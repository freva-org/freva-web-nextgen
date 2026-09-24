/**
 * The console fixture page, shared by the browser suites.
 *
 * The console is driven against a MOCK engine by default, which is what lets these suites run in
 * Chromium, Firefox and WebKit in seconds without downloading Pyodide three times, and what
 * lets a test produce orderings a real engine will not produce on demand: a late completion
 * response, a command typed during startup, a fatal mid-execution.
 * `console-real-engine.mjs` runs the same component against the real interpreter.
 */

export async function waitForConsole(page, condition, arg = null) {
  try {
    await page.waitForFunction(condition, arg, { polling: 50, timeout: 30_000 });
    return true;
  } catch (error) {
    if (error.name !== "TimeoutError") throw error;
    return false;
  }
}

/** A mock BrowserPython, in the page. Scriptable from the test through `window.__mock`. */
export const MOCK_ENGINE = `
class MockEngine {
  constructor() {
    this.state = "idle";
    this.pushes = [];
    this.completeCalls = [];
    this.restarts = 0;
    this.disposed = false;
    this._status = new Set();
    this._output = new Set();
    // Overridable from a test.
    this.pushImpl = async (line) => ({ executionId: "e" + this.pushes.length, syntax: "complete", executed: true });
    this.completeImpl = async () => ({ start: 0, matches: [] });
    this._artifacts = new Set();
    // The workspace the console sees. A test replaces it to play an unsupported browser.
    this.workspace = { available: true, path: "/workspace", maxFiles: 8, sessionId: "mock" };
    /** name -> { info, bytes } - the whole of the mock filesystem. */
    this.files = new Map();
    this.deleted = [];
    this.reads = [];
    this._generation = 0;
    /** Slows each chunk down so a test can cancel a transfer that is genuinely in flight. */
    this.streamDelayMs = 0;
  }
  async start() {
    this._emitStatus("loading", "downloading the Python runtime");
    await new Promise((r) => setTimeout(r, 5));
    this._emitStatus("ready");
    return { profile: "minimal", pythonVersion: "3.14.2", pyodideVersion: "314.0.6", packages: {}, startupMs: 5, workspace: this.workspace, credentialsPersisted: false };
  }
  async push(line) { this.pushes.push(line); return this.pushImpl(line); }
  async run(code) { this.pushes.push(code); return { executionId: "run" }; }
  async complete(source, cursor) { this.completeCalls.push({ source, cursor }); return this.completeImpl(source, cursor); }
  async clearBuffer() {}
  async restart() { this.restarts += 1; this.files.clear(); this._emitStatus("ready"); return { profile: "minimal", pythonVersion: "3.14.2", pyodideVersion: "314.0.6", packages: {}, startupMs: 1, workspace: this.workspace, credentialsPersisted: false }; }
  // Faithful to the real engine: dispose is TERMINAL, so the state becomes "disposed" and stays
  // there. A mock whose dispose only sets a private flag lets a component be tested against a
  // lifecycle the real engine does not have - and the component reads engine.state.
  dispose() { this.disposed = true; this._emitStatus("disposed"); }
  async disposeAsync() { this.dispose(); }
  // A real chunked transfer, so a test can watch the window and cancel mid-flight. Follows the
  // engine's OWNERSHIP CONTRACT: once a destination is passed in, this closes or aborts it on
  // every path, including the ones that fail before a byte is read - adopting it only after
  // deciding the artifact exists would leave the console's picked file handle open.
  async streamArtifact(name, destination, options = {}) {
    const sink = typeof destination.getWriter === "function"
      ? (() => { const w = destination.getWriter();
                 return { write: async (c) => { await w.ready; await w.write(c); },
                          close: () => w.close(), abort: (r) => w.abort(r) }; })()
      : destination;
    const file = this.files.get(name);
    if (!file) {
      const error = new Error("There is no artifact called " + name + " in the workspace.");
      await sink.abort(error);
      throw error;
    }
    const chunk = options.chunkBytes ?? 4;
    let written = 0;
    this.streamed = this.streamed ?? [];
    this.streamed.push({ name, chunkBytes: chunk });
    try {
      for (let at = 0; at < file.bytes.length; at += chunk) {
        if (options.signal?.aborted) { const e = new Error("The download was cancelled."); e.name = "ArtifactTransferAborted"; throw e; }
        const slice = file.bytes.slice(at, at + chunk);
        await sink.write(slice);
        written += slice.length;
        options.onProgress?.({ transferred: written, total: file.bytes.length, phase: "transferring" });
        await new Promise((r) => setTimeout(r, this.streamDelayMs ?? 0));
      }
      // The engine's contract: every byte is written, the destination is committing, and
      // cancellation no longer applies. The component reads this to disable Cancel.
      options.onProgress?.({ transferred: written, total: file.bytes.length, phase: "finishing" });
      await new Promise((r) => setTimeout(r, this.closeDelayMs ?? 0));
      await sink.close();
    } catch (error) {
      await sink.abort(error);
      throw error;
    }
    return { bytesWritten: written, name, mime: file.info.mime };
  }
  onStatus(l) { this._status.add(l); return () => this._status.delete(l); }
  onArtifacts(l) { this._artifacts.add(l); return () => this._artifacts.delete(l); }
  async artifacts() { return [...this.files.values()].map((f) => f.info); }
  async readArtifact(name, options = {}) {
    this.reads.push({ name, options });
    const file = this.files.get(name);
    if (!file) throw new Error("There is no artifact called " + name + " in the workspace.");
    if (file.info.state !== "ready") throw new Error(name + " is not ready.");
    const max = options.maxBytes ?? file.bytes.length;
    const slice = file.bytes.slice(0, max);
    return {
      name,
      mime: file.info.mime,
      size: file.bytes.length,
      blob: new Blob([slice], { type: file.info.mime }),
      truncated: max < file.bytes.length,
    };
  }
  async deleteArtifact(name) {
    this.deleted.push(name);
    this.files.delete(name);
    this.emitArtifacts({ removed: [name] });
  }
  /** Put a file in the mock workspace and announce it, the way a real execution would. */
  addFile(name, { mime = "text/plain", bytes = [104, 105], state = "ready", failure } = {}) {
    const data = Uint8Array.from(bytes);
    this.files.set(name, {
      bytes: data,
      info: { name, size: data.length, modifiedMs: Date.now(), generation: ++this._generation, state, mime, ...(failure ? { failure } : {}) },
    });
    this.emitArtifacts({ added: [name] });
  }
  emitArtifacts({ added = [], updated = [], removed = [], executionId } = {}) {
    const event = {
      type: "artifacts",
      artifacts: [...this.files.values()].map((f) => f.info),
      added, updated, removed,
      ...(executionId ? { executionId } : {}),
    };
    for (const l of this._artifacts) l(event);
  }
  onOutput(l) { this._output.add(l); return () => this._output.delete(l); }
  _emitStatus(state, detail) { this.state = state; for (const l of this._status) l({ type: "status", state, detail }); }
  emit(event) { for (const l of this._output) l(event); }
  get listenerCount() { return this._status.size + this._output.size + this._artifacts.size; }
}
window.__MockEngine = MockEngine;
`;

/** A real 1x1 PNG, for the display path. */
export const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export function consolePage({ attributes = "", injectEngine = true } = {}) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>console</title>
<style>html,body{margin:0;padding:12px;font-family:system-ui,sans-serif}</style>
</head><body>
<freva-python-console id="c" ${attributes}></freva-python-console>
<script type="module">
  ${MOCK_ENGINE}
  import { defineBrowserPythonConsole } from "/bundle/console.js";
  defineBrowserPythonConsole();

  const element = document.getElementById("c");
  const mock = new window.__MockEngine();
  window.__mock = mock;
  ${injectEngine ? "element.engine = mock;" : ""}
  window.__el = element;

  /** Everything a suite drives, on one global. None of it is part of the package's API. */
  window.__c = {
    element,
    mock,
    root: () => element.shadowRoot,
    q: (sel) => element.shadowRoot.querySelector(sel),
    qa: (sel) => [...element.shadowRoot.querySelectorAll(sel)],
    text: () => element.shadowRoot.querySelector(".bp-transcript")?.textContent ?? "",
    lines: () => [...element.shadowRoot.querySelectorAll(".bp-line")].map((l) => ({
      kind: [...l.classList].find((c) => c.startsWith("bp-") && c !== "bp-line")?.slice(3) ?? "",
      text: l.textContent,
      executionId: l.dataset.executionId ?? null,
    })),
    /** Type into the terminal's own input, the way a person does. */
    focusInput: () => {
      const t = element.shadowRoot.querySelector(".terminal");
      if (t) t.click();
    },
  };
  window.__ready = true;
</script></body></html>`;
}
