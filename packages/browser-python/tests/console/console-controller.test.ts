/**
 * The controller: prompt state, the queued command, ordering, completion staleness, pruning.
 * Driven against a FAKE surface and a MOCK engine, both defined here, because these behaviours
 * are about things overlapping or arriving late - a stale completion, a command typed during
 * startup, a result racing the stdout before it - which a real engine cannot produce on demand.
 */
import { describe, expect, it, vi } from "vitest";
import {
  BACKGROUND_EXECUTION_ID,
  ConsoleController,
} from "../../src/console/console-controller.js";
import type {
  ConsoleDisplayOutput,
  ConsoleSurfaceAdapter,
  ConsoleTextOutput,
} from "../../src/console/console-types.js";
import { toSink, type ArtifactSink } from "../../src/artifact-stream.js";
import type {
  ArtifactInfo,
  ArtifactsEvent,
  BrowserPython,
  ExecutionResult,
  BrowserPythonState,
  OutputEvent,
  PushResult,
  StatusEvent,
} from "../../src/types.js";

/** Records everything the controller asks the surface to do. */
class FakeSurface implements ConsoleSurfaceAdapter {
  prompt: ">>> " | "... " = ">>> ";
  busy = false;
  command = "";
  cursor = 0;
  readonly text: ConsoleTextOutput[] = [];
  readonly displays: ConsoleDisplayOutput[] = [];
  clears = 0;
  /** Every `trim` the controller asked for, and what it removed. */
  readonly trims: Array<{ keepEntries: number; keepCharacters: number; removed: number }> = [];
  /** Every `settle` the controller asked for, in order. The ORDER is the contract: a settle
   * before the output has been flushed, or before the prompt has been redrawn, scrolls to the
   * wrong place. */
  readonly settles: Array<{ focus: boolean; textCount: number; busy: boolean }> = [];
  follows = 0;

  mount(): void {}
  setPrompt(prompt: ">>> " | "... "): void {
    this.prompt = prompt;
  }
  setBusy(busy: boolean): void {
    this.busy = busy;
  }
  setCommand(value: string): void {
    this.command = value;
    this.cursor = value.length;
  }
  getCommand(): string {
    return this.command;
  }
  getCursor(): number {
    return this.cursor;
  }
  setCursor(position: number): void {
    this.cursor = position;
  }
  insert(value: string): void {
    this.command += value;
    this.cursor = this.command.length;
  }
  appendText(output: ConsoleTextOutput): void {
    this.text.push(output);
  }
  appendDisplay(output: ConsoleDisplayOutput): void {
    this.displays.push(output);
  }
  /** Drop from the OLDEST end, exactly as the real adapter does, and report the count. Modelled
   * rather than stubbed: the assertion that matters is that the newest entries SURVIVE, and a
   * `trim` that returned a number without removing anything would let that pass. */
  trim(limits: { keepEntries: number; keepCharacters: number }): number {
    let removed = 0;
    while (
      this.text.length > limits.keepEntries ||
      this.text.reduce((n, entry) => n + entry.text.length, 0) > limits.keepCharacters
    ) {
      if (this.text.length === 0) break;
      this.text.shift();
      removed += 1;
    }
    this.trims.push({ ...limits, removed });
    return removed;
  }

  clear(): void {
    this.clears += 1;
    this.text.length = 0;
  }
  focus(): void {}
  settle(options: { focus: boolean }): void {
    this.settles.push({ focus: options.focus, textCount: this.text.length, busy: this.busy });
  }
  followLatest(): void {
    this.follows += 1;
  }
  destroy(): void {}

  /** Kinds in the order they were rendered - the assertion most of these tests make. */
  kinds(): string[] {
    return this.text.map((t) => t.kind);
  }
}

/** A scriptable BrowserPython. Only the surface the controller is allowed to use. */
class MockEngine implements BrowserPython {
  state: BrowserPythonState = "ready";
  // Reported capabilities. The controller does not read them; the interface does, and a mock that
  // diverges from the interface tests a component against an engine that does not exist.
  readonly credentialsPersisted = false;
  onStorage(): () => void {
    return () => {};
  }
  readonly pushes: string[] = [];
  /** Sources handed to `run()`, separately from `pushes`, which existing tests read the whole
   * conversation out of. What those cannot see is WHICH method was used, and for a registered
   * example that is the assertion: file semantics, once, whatever the length. */
  readonly runs: string[] = [];
  readonly completeCalls: Array<{ source: string; cursor: number }> = [];
  #status = new Set<(e: StatusEvent) => void>();
  #output = new Set<(e: OutputEvent) => void>();

  /** Set by a test to control what `push` answers. */
  nextPush: (line: string) => Promise<PushResult> = async () => ({
    executionId: "exec-1",
    syntax: "complete",
    executed: true,
  });
  /** Set by a test to control completion, including how long it takes. */
  nextComplete: (source: string, cursor: number) => Promise<{ start: number; matches: string[] }> =
    async () => ({ start: 0, matches: [] });

  restarts = 0;
  disposed = false;

  /** The workspace this mock claims. A disk-backed one, since that is the ordinary case. */
  readonly workspace = {
    available: true,
    path: "/workspace",
    maxFiles: 64,
    sessionId: "mock-session",
  };
  files: ArtifactInfo[] = [];
  #artifacts = new Set<(e: ArtifactsEvent) => void>();

  async start() {
    return {
      profile: "minimal" as const,
      pythonVersion: "3.14.2",
      pyodideVersion: "314.0.6",
      packages: {},
      startupMs: 1,
      workspace: this.workspace,
      addons: [],
      unavailableAddons: [],
      credentialsPersisted: false,
      jspi: false,
    };
  }
  async artifacts(): Promise<readonly ArtifactInfo[]> {
    return this.files;
  }
  async readArtifact(name: string) {
    return {
      name,
      mime: "text/plain",
      size: 2,
      blob: new Blob(["hi"], { type: "text/plain" }),
      truncated: false,
    };
  }
  async deleteArtifact(name: string) {
    this.files = this.files.filter((file) => file.name !== name);
    this.emitArtifacts({ removed: [name] });
  }
  onArtifacts(listener: (e: ArtifactsEvent) => void) {
    this.#artifacts.add(listener);
    return () => this.#artifacts.delete(listener);
  }
  /** So a test can prove the controller did NOT subscribe when the host has no file UI. */
  get artifactListenerCount() {
    return this.#artifacts.size;
  }
  emitArtifacts(change: Partial<Omit<ArtifactsEvent, "type" | "artifacts">> = {}): void {
    for (const l of this.#artifacts) {
      l({
        type: "artifacts",
        artifacts: this.files,
        added: [],
        updated: [],
        removed: [],
        ...change,
      });
    }
  }
  async push(line: string) {
    this.pushes.push(line);
    return this.nextPush(line);
  }
  async run(code: string): Promise<ExecutionResult> {
    this.pushes.push(code);
    this.runs.push(code);
    return { executionId: "exec-run" };
  }
  async complete(source: string, cursor?: number) {
    this.completeCalls.push({ source, cursor: cursor ?? source.length });
    return this.nextComplete(source, cursor ?? source.length);
  }
  async clearBuffer() {}
  /** Nothing runs in the mock, so an interrupt truthfully finds nothing. Overridden where it does. */
  interruptCalls = 0;
  interruptAnswer = false;
  async interrupt() {
    this.interruptCalls += 1;
    return this.interruptAnswer;
  }
  async restart() {
    this.restarts += 1;
    return this.start();
  }
  dispose() {
    this.disposed = true;
  }
  async disposeAsync() {
    this.disposed = true;
  }
  async streamArtifact(name: string, destination: ArtifactSink | WritableStream<Uint8Array>) {
    const sink = toSink(destination);
    const bytes = new TextEncoder().encode("hi");
    await sink.write(bytes);
    await sink.close();
    return { bytesWritten: bytes.byteLength, name, mime: "text/plain" };
  }
  onStatus(listener: (e: StatusEvent) => void) {
    this.#status.add(listener);
    return () => this.#status.delete(listener);
  }
  onOutput(listener: (e: OutputEvent) => void) {
    this.#output.add(listener);
    return () => this.#output.delete(listener);
  }

  emitStatus(state: BrowserPythonState, detail?: string): void {
    this.state = state;
    for (const l of this.#status) l({ type: "status", state, ...(detail ? { detail } : {}) });
  }
  emitOutput(event: OutputEvent): void {
    for (const l of this.#output) l(event);
  }
  get statusListeners(): number {
    return this.#status.size;
  }
  get outputListeners(): number {
    return this.#output.size;
  }
}

export { FakeSurface, MockEngine };

/** The hooks a host must supply, all doing nothing. `onArtifacts` is deliberately absent. */
function noopHooks() {
  return {
    onStatus: vi.fn(),
    onSuggestion: vi.fn(),
    onCompletion: vi.fn(),
    onSearch: vi.fn(),
  };
}

function build(options: ConstructorParameters<typeof ConsoleController>[2] = {}) {
  const surface = new FakeSurface();
  const hooks = {
    onStatus: vi.fn(),
    onSuggestion: vi.fn(),
    onCompletion: vi.fn(),
    onSearch: vi.fn(),
    onCommandChanged: vi.fn(),
  };
  const controller = new ConsoleController(surface, hooks, {
    history: { persistence: "memory" },
    ...options,
  });
  const engine = new MockEngine();
  controller.attach(engine);
  return { surface, hooks, controller, engine };
}

const settle = () => new Promise((r) => setTimeout(r, 0));
/** Long enough for the stdout flush to fire. Buffered stream output is flushed on an animation
 * frame; under Node there is no `requestAnimationFrame`, so the controller falls back to a ~16ms
 * timeout, and a test awaiting only a microtask would see an empty transcript. */
const frame = () => new Promise((r) => setTimeout(r, 40));

describe("submission", () => {
  it("passes the line to the engine EXACTLY as given", async () => {
    const { controller, engine } = build();
    const line = '    test = {"Test": \'test\'}["Test"]  ';
    await controller.submit(line);
    expect(engine.pushes).toEqual([line]);
  });

  it("echoes the command with its prompt before running it", async () => {
    const { controller, surface } = build();
    await controller.submit("1 + 1");
    expect(surface.text[0]).toMatchObject({ kind: "command", text: "1 + 1", prompt: ">>> " });
  });

  it("switches to the continuation prompt when the engine says INCOMPLETE", async () => {
    const { controller, surface, engine } = build();
    engine.nextPush = async () => ({ executionId: "e", syntax: "incomplete", executed: false });
    await controller.submit("def double(v):");
    expect(surface.prompt).toBe("... ");
    expect(controller.continuing).toBe(true);
  });

  it("returns to the primary prompt once the statement completes", async () => {
    const { controller, surface, engine } = build();
    engine.nextPush = async () => ({ executionId: "e", syntax: "incomplete", executed: false });
    await controller.submit("def double(v):");
    engine.nextPush = async () => ({ executionId: "e", syntax: "complete", executed: true });
    await controller.submit("");
    expect(surface.prompt).toBe(">>> ");
    expect(controller.continuing).toBe(false);
  });

  it("returns to the primary prompt after a SYNTAX ERROR too", async () => {
    const { controller, surface, engine } = build();
    engine.nextPush = async () => ({
      executionId: "e",
      syntax: "syntax-error",
      executed: false,
      error: "SyntaxError",
    });
    await controller.submit("x = = 1");
    expect(surface.prompt).toBe(">>> ");
  });

  it("stores a multi-line statement as ONE history entry", async () => {
    const { controller, engine } = build();
    engine.nextPush = async () => ({ executionId: "e", syntax: "incomplete", executed: false });
    await controller.submit("def double(v):");
    await controller.submit("    return v * 2");
    engine.nextPush = async () => ({ executionId: "e", syntax: "complete", executed: true });
    await controller.submit("");
    expect(controller.history.entries).toEqual(["def double(v):\n    return v * 2\n"]);
  });

  // One submission, not one per line. `["a = 1", "", "b = 2", ""]` describes the REPL protocol
  // faithfully and is wrong for a block: a blank line ENDS the current suite there. The blank
  // lines are preserved byte for byte inside the one string.
  it("submits a pasted block as one source, blank lines preserved inside it", async () => {
    const { controller, engine } = build();
    await controller.execute("a = 1\n\nb = 2\n");
    expect(engine.pushes).toEqual(["a = 1\n\nb = 2\n"]);
  });

  it("normalises CRLF but nothing else - indentation survives", async () => {
    const { controller, engine } = build();
    await controller.execute("a = 1\r\n    b = 2");
    expect(engine.pushes).toEqual(["a = 1\n    b = 2"]);
  });
});

describe("a command typed before the engine is ready", () => {
  it("is held, echoed, and run once the engine reports ready", async () => {
    const { controller, engine, surface } = build();
    controller.detach();
    engine.state = "loading";
    controller.attach(engine);

    await controller.submit("value = 40");
    expect(engine.pushes).toEqual([]); // nothing ran
    expect(surface.kinds()).toContain("status"); // and the user was told

    engine.emitStatus("ready");
    await settle();
    expect(engine.pushes).toEqual(["value = 40"]);
  });

  // ONE queued command, not a queue. Somebody who typed three during a twenty-second download did
  // not ask for three to run at once; the newest is the one they are waiting for.
  it("keeps only the newest, and never runs it twice", async () => {
    const { controller, engine } = build();
    controller.detach();
    engine.state = "loading";
    controller.attach(engine);

    await controller.submit("first");
    await controller.submit("second");
    engine.emitStatus("ready");
    await settle();
    engine.emitStatus("ready"); // a second ready must not replay it
    await settle();
    expect(engine.pushes).toEqual(["second"]);
  });
});

describe("output ordering", () => {
  it("coalesces rapid stdout into one node per run", async () => {
    const { engine, surface } = build();
    for (const text of ["a", "b", "c"]) {
      engine.emitOutput({ type: "stdout", executionId: "e1", text });
    }
    engine.emitOutput({ type: "result", executionId: "e1", text: "42" });
    await settle();
    const stdout = surface.text.filter((t) => t.kind === "stdout");
    expect(stdout).toHaveLength(1);
    expect(stdout[0]?.text).toBe("abc");
  });

  // The ordering rule: a result is flushed BEFORE it is emitted, so it can never overtake the
  // stdout printed before it - the one thing a transcript must never do.
  it("keeps stdout before the result that followed it", async () => {
    const { engine, surface } = build();
    engine.emitOutput({ type: "stdout", executionId: "e1", text: "printed\n" });
    engine.emitOutput({ type: "result", executionId: "e1", text: "'value'" });
    await settle();
    expect(surface.kinds()).toEqual(["stdout", "result"]);
  });

  it("keeps stdout before a display event too", async () => {
    const { engine, surface } = build();
    engine.emitOutput({ type: "stdout", executionId: "e1", text: "before\n" });
    engine.emitOutput({
      type: "display",
      executionId: "e1",
      mime: "image/png",
      encoding: "base64",
      data: "iVBORw0KGgo=",
    });
    await settle();
    expect(surface.kinds()).toEqual(["stdout"]);
    expect(surface.displays).toHaveLength(1);
  });

  it("does not merge stdout and stderr into one run", async () => {
    const { engine, surface } = build();
    engine.emitOutput({ type: "stdout", executionId: "e", text: "out" });
    engine.emitOutput({ type: "stderr", executionId: "e", text: "err" });
    engine.emitOutput({ type: "stdout", executionId: "e", text: "out2" });
    await frame();
    expect(surface.kinds()).toEqual(["stdout", "stderr", "stdout"]);
  });

  it("carries the execution id through to the surface", async () => {
    const { engine, surface } = build();
    engine.emitOutput({ type: "result", executionId: "exec-7", text: "1" });
    await settle();
    expect(surface.text[0]?.executionId).toBe("exec-7");
  });
});

describe("output pruning", () => {
  it("drops the OLDEST entries and keeps the newest, rather than clearing everything", async () => {
    // "Bounded scrollback" means the top falls off, not the bottom: clearing the whole transcript
    // on exceeding the limit by one entry throws away the newest output with the oldest.
    const { engine, surface } = build({ output: { maxEntries: 3 } });
    for (let i = 0; i < 6; i += 1) {
      engine.emitOutput({ type: "result", executionId: `e${i}`, text: String(i) });
      await settle();
    }
    expect(surface.clears).toBe(0);
    expect(surface.trims.some((trim) => trim.removed > 0)).toBe(true);
    const rendered = surface.text.filter((entry) => entry.kind === "result").map((e) => e.text);
    expect(rendered).toContain("5");
    expect(rendered).not.toContain("0");
  });

  it("retains nothing at all when maxEntries is 0", async () => {
    // A real configuration: a host that renders output itself and wants the transcript empty.
    const { engine, surface } = build({ output: { maxEntries: 0 } });
    for (let i = 0; i < 3; i += 1) {
      engine.emitOutput({ type: "result", executionId: `e${i}`, text: String(i) });
      await settle();
    }
    expect(surface.text.filter((entry) => entry.kind === "result")).toEqual([]);
  });

  it("cancels buffered output when the transcript is cleared", async () => {
    // Stream output is coalesced and flushed on an animation frame, so anything printed in the
    // moments before Clear was pressed is still buffered - and a pending flush would write it into
    // the transcript the visitor had just emptied.
    const { controller, engine, surface } = build();
    engine.emitOutput({ type: "stdout", executionId: "e1", text: "secret\n" });
    controller.clearOutput();
    await settle();
    expect(surface.text.filter((entry) => entry.text.includes("secret"))).toEqual([]);
  });
});

describe("completion", () => {
  it("inserts a single unambiguous candidate at the engine's own range", async () => {
    const { controller, surface, engine } = build();
    surface.setCommand("ds.ise");
    engine.nextComplete = async () => ({ start: 0, matches: ["ds.isel"] });
    await controller.requestCompletion();
    expect(surface.command).toBe("ds.isel");
    expect(surface.cursor).toBe("ds.isel".length);
  });

  it("opens a menu for several candidates without changing the buffer", async () => {
    const { controller, surface, engine, hooks } = build();
    surface.setCommand("xr.open_");
    engine.nextComplete = async () => ({ start: 0, matches: ["xr.open_zarr", "xr.open_dataset"] });
    await controller.requestCompletion();
    expect(surface.command).toBe("xr.open_");
    expect(hooks.onCompletion).toHaveBeenLastCalledWith(["xr.open_zarr", "xr.open_dataset"], 0);
    expect(controller.completionOpen()).toBe(true);
  });

  it("cycles forwards and backwards through the menu", async () => {
    const { controller, surface, engine, hooks } = build();
    surface.setCommand("x");
    engine.nextComplete = async () => ({ start: 0, matches: ["xa", "xb", "xc"] });
    await controller.requestCompletion();
    controller.cycleCompletion(1);
    expect(hooks.onCompletion).toHaveBeenLastCalledWith(["xa", "xb", "xc"], 1);
    controller.cycleCompletion(-1);
    expect(hooks.onCompletion).toHaveBeenLastCalledWith(["xa", "xb", "xc"], 0);
    controller.cycleCompletion(-1); // wraps
    expect(hooks.onCompletion).toHaveBeenLastCalledWith(["xa", "xb", "xc"], 2);
  });

  it("accepting a candidate inserts it and does NOT execute", async () => {
    const { controller, surface, engine } = build();
    surface.setCommand("x");
    engine.nextComplete = async () => ({ start: 0, matches: ["xa", "xb"] });
    await controller.requestCompletion();
    controller.acceptCompletion();
    expect(surface.command).toBe("xa");
    expect(engine.pushes).toEqual([]);
  });

  // A completion request crosses a worker boundary; by the time it returns the buffer may have
  // changed twice. Applying a stale answer would overwrite newer input with a completion of text
  // the user already deleted.
  it("drops a response that arrives after the buffer changed", async () => {
    const { controller, surface, engine } = build();
    surface.setCommand("ds.ise");
    let release: (v: { start: number; matches: string[] }) => void = () => {};
    engine.nextComplete = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const pending = controller.requestCompletion();
    surface.setCommand("something else entirely");
    release({ start: 0, matches: ["ds.isel"] });
    await pending;
    expect(surface.command).toBe("something else entirely");
  });

  it("drops a response superseded by a NEWER request", async () => {
    const { controller, surface, engine } = build();
    surface.setCommand("a");
    let releaseFirst: (v: { start: number; matches: string[] }) => void = () => {};
    engine.nextComplete = () => new Promise((r) => (releaseFirst = r));
    const first = controller.requestCompletion();

    engine.nextComplete = async () => ({ start: 0, matches: ["second"] });
    await controller.requestCompletion();
    releaseFirst({ start: 0, matches: ["first"] });
    await first;
    expect(surface.command).toBe("second");
  });

  // Tab at the start of a line means INDENT to anyone who has used a Python REPL. Offering a
  // module list there is noise, and the engine is not asked.
  it("inserts an indent instead of completing on a blank or all-whitespace prefix", async () => {
    const { controller, surface, engine } = build();
    surface.setCommand("    ");
    await controller.requestCompletion();
    expect(surface.command).toBe("        ");
    expect(engine.completeCalls).toEqual([]);
  });

  it("Escape closes the menu and invalidates anything in flight", async () => {
    const { controller, surface, engine, hooks } = build();
    surface.setCommand("x");
    engine.nextComplete = async () => ({ start: 0, matches: ["xa", "xb"] });
    await controller.requestCompletion();
    controller.closeCompletion();
    expect(controller.completionOpen()).toBe(false);
    expect(hooks.onCompletion).toHaveBeenLastCalledWith([], -1);
  });
});

describe("history interaction", () => {
  it("Up recalls, and accepting a suggestion does NOT execute it", async () => {
    const { controller, surface, engine } = build();
    await controller.submit("import xarray as xr");
    surface.setCommand("import ");
    expect(controller.acceptSuggestion()).toBe(true);
    expect(surface.command).toBe("import xarray as xr");
    expect(engine.pushes).toEqual(["import xarray as xr"]); // only the original submission
  });

  it("reverse search restores the draft on cancel", async () => {
    const { controller, surface } = build();
    await controller.submit("open_zarr(URL)");
    surface.setCommand("my draft");
    controller.startSearch();
    controller.searchType("zarr");
    expect(surface.command).toBe("open_zarr(URL)");
    controller.cancelSearch();
    expect(surface.command).toBe("my draft");
  });

  it("reverse search keeps the entry on the line when accepted, without running it", async () => {
    const { controller, surface, engine } = build();
    await controller.submit("open_zarr(URL)");
    const before = engine.pushes.length;
    surface.setCommand("");
    controller.startSearch();
    controller.searchType("zarr");
    controller.acceptSearch();
    expect(surface.command).toBe("open_zarr(URL)");
    expect(engine.pushes).toHaveLength(before);
  });

  it("repeated Ctrl+R steps to older matches", async () => {
    const { controller, surface } = build();
    await controller.submit("zarr(A)");
    await controller.submit("zarr(B)");
    surface.setCommand("");
    controller.startSearch();
    controller.searchType("zarr");
    expect(surface.command).toBe("zarr(B)");
    controller.searchOlder();
    expect(surface.command).toBe("zarr(A)");
  });
});

describe("lifecycle", () => {
  it("detach removes every subscription and leaves the engine alone", () => {
    const { controller, engine } = build();
    expect(engine.statusListeners + engine.outputListeners).toBe(2);
    controller.detach();
    expect(engine.statusListeners + engine.outputListeners).toBe(0);
    expect(engine.disposed).toBe(false);
  });

  it("attaching twice does not double-subscribe, so output is not rendered twice", () => {
    const { controller, engine, surface } = build();
    controller.attach(engine);
    engine.emitOutput({ type: "result", executionId: "e", text: "1" });
    expect(surface.text.filter((t) => t.kind === "result")).toHaveLength(1);
  });

  it("clearing output does not touch Python state", () => {
    const { controller, engine, surface } = build();
    controller.clearOutput();
    expect(surface.clears).toBe(1);
    expect(engine.restarts).toBe(0);
    expect(engine.disposed).toBe(false);
  });

  it("restart clears the continuation buffer and returns to the primary prompt", async () => {
    const { controller, surface, engine } = build();
    engine.nextPush = async () => ({ executionId: "e", syntax: "incomplete", executed: false });
    await controller.submit("if True:");
    expect(surface.prompt).toBe("... ");
    await controller.restart();
    expect(surface.prompt).toBe(">>> ");
    expect(controller.continuing).toBe(false);
    expect(engine.restarts).toBe(1);
  });

  it("dispose never disposes the engine - ownership is the element's business", () => {
    const { controller, engine } = build();
    controller.dispose();
    expect(engine.disposed).toBe(false);
  });
});

describe("abandoning a line", () => {
  // readline's behaviour, the one people have in their fingers: Ctrl+C means "forget this and
  // start again". Leaving the history cursor where it was makes the next Up continue walking
  // backwards from wherever the abandoned line came from - a place the user has no reason to be.
  it("Ctrl+C returns history to the end, so the next Up is the newest command", async () => {
    const { controller, surface } = build();
    await controller.submit("first = 1");
    await controller.submit("second = 2");
    controller.historyPrevious();
    controller.historyPrevious();
    expect(surface.command).toBe("first = 1");

    await controller.clearBuffer();
    expect(surface.command).toBe("");

    controller.historyPrevious();
    expect(surface.command).toBe("second = 2");
  });
});

// The startup window: the gap between "the element exists" and "Python is ready". A portal
// autostarts the console and calls `execute()` in the same breath, so this is the normal case for
// an embedded console - and the queue's single slot, meant for one impatient typed line, must not
// eat whole programs.
describe("execute during startup", () => {
  it("keeps every line of a block submitted before the engine is ready", async () => {
    const { controller, engine } = build();
    // Emitted, not assigned: the controller learns readiness from the status stream, so setting
    // the field alone leaves it still believing the engine is ready.
    engine.emitStatus("loading");
    const running = controller.execute("import numpy as np\nnp.arange(5)");
    // The whole block is submitted BEFORE readiness - which is the real case, where Pyodide takes
    // seconds. Letting `ready` land mid-loop hides the bug behind a lucky interleaving.
    await settle();
    engine.emitStatus("ready");
    await running;
    await settle();
    expect(engine.pushes).toEqual(["import numpy as np\nnp.arange(5)"]);
  });

  it("keeps a queued block contiguous when someone types during startup", async () => {
    const { controller, engine } = build();
    engine.emitStatus("loading");
    const block = controller.execute("a = 1\nb = 2");
    const typed = controller.submit("c = 3");
    await settle();
    engine.emitStatus("ready");
    await Promise.all([block, typed]);
    await settle();
    // The block stays whole. A typed line may follow it, but must never land inside it - that is
    // how a stray statement ends up spliced into a half-finished `def`.
    expect(engine.pushes).toEqual(["a = 1\nb = 2", "c = 3"]);
  });

  it("echoes a queued command ONCE, not again when it runs", async () => {
    const { controller, engine, surface } = build();
    engine.emitStatus("loading");
    const running = controller.submit("value = 40");
    await settle();
    engine.emitStatus("ready");
    await running;
    await settle();
    const echoes = surface.text.filter((t) => t.kind === "command" && t.text === "value = 40");
    expect(echoes).toHaveLength(1);
    expect(engine.pushes).toEqual(["value = 40"]);
  });
});

describe("the continuation prompt on an echoed command", () => {
  it("marks the second line of a block as a continuation", async () => {
    const { controller, engine, surface } = build();
    engine.emitStatus("ready");
    engine.nextPush = async (line: string) => ({
      executionId: "e",
      syntax: line.endsWith(":") ? ("incomplete" as const) : ("complete" as const),
      executed: !line.endsWith(":"),
    });
    await controller.submit("def f():");
    await controller.submit("    pass");
    await settle();
    const prompts = surface.text.filter((t) => t.kind === "command").map((t) => t.prompt);
    expect(prompts).toEqual([">>> ", "... "]);
  });
});

// The waiter that `submitBlock()` awaits while the engine starts. A promise with only a resolve
// path hangs: each of these ends the queue WITHOUT running it, so each must reject rather than
// leave a portal's "run this example" button awaiting a block that will never run.
describe("a queued block that will never run", () => {
  it("rejects when the console is disposed", async () => {
    const { controller, engine } = build();
    engine.emitStatus("loading");
    const running = controller.submitBlock("a = 1\nb = 2");
    await settle();
    controller.dispose();
    await expect(running).rejects.toThrow(/disposed/);
  });

  it("rejects when a restart clears the queue", async () => {
    const { controller, engine } = build();
    engine.emitStatus("loading");
    const running = controller.submitBlock("a = 1\nb = 2");
    await settle();
    await controller.restart();
    await expect(running).rejects.toThrow(/restart/);
  });

  it("resolves only once the queue has actually emptied", async () => {
    const { controller, engine } = build();
    engine.emitStatus("loading");
    let settled = false;
    const running = controller.submitBlock("a = 1\nb = 2").then(() => {
      settled = true;
    });
    await settle();
    expect(settled).toBe(false);
    engine.emitStatus("ready");
    await running;
    expect(settled).toBe(true);
    expect(engine.pushes).toEqual(["a = 1\nb = 2"]);
  });
});

describe("a block submitted while the engine is ready", () => {
  it("does not let a typed line land in the middle of it", async () => {
    const { controller, engine } = build();
    engine.emitStatus("ready");
    const block = controller.submitBlock("def f():\n    return 1\n");
    const typed = controller.submit("g = 2");
    await Promise.all([block, typed]);
    await settle();
    // The block stays whole and the typed line follows it. Landing INSIDE it is the failure.
    expect(engine.pushes).toEqual(["def f():\n    return 1\n", "g = 2"]);
  });
});

// The workspace hook. The controller owns every engine subscription, so it owns this one, and the
// interesting cases are the two ends: a host that renders no files must not be forced to pay for
// it, and a console attaching to an already-running engine must not show an empty list until the
// next write, because the spontaneous events only describe changes.
describe("artifact hooks", () => {
  it("forwards workspace changes to the hook", () => {
    const engine = new MockEngine();
    const seen: ArtifactsEvent[] = [];
    const controller = new ConsoleController(
      new FakeSurface(),
      { ...noopHooks(), onArtifacts: (event) => seen.push(event) },
      {},
    );
    controller.attach(engine as unknown as BrowserPython);

    engine.files = [
      {
        name: "out.nc",
        size: 10,
        modifiedMs: 1,
        generation: 1,
        state: "ready",
        mime: "text/plain",
      },
    ];
    engine.emitArtifacts({ added: ["out.nc"] });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.added).toEqual(["out.nc"]);
  });

  it("does not subscribe at all when the host has no file UI", () => {
    // `onArtifacts` is optional, and a host without it should not be paying for the subscription
    // or receiving events it has nowhere to put.
    const engine = new MockEngine();
    const controller = new ConsoleController(new FakeSurface(), noopHooks(), {});
    controller.attach(engine as unknown as BrowserPython);
    expect(engine.artifactListenerCount).toBe(0);
  });

  it("unsubscribes on detach, so a re-attach does not double-render", () => {
    const engine = new MockEngine();
    const seen: ArtifactsEvent[] = [];
    const controller = new ConsoleController(
      new FakeSurface(),
      { ...noopHooks(), onArtifacts: (event) => seen.push(event) },
      {},
    );
    controller.attach(engine as unknown as BrowserPython);
    controller.attach(engine as unknown as BrowserPython); // attach detaches first
    engine.emitArtifacts({ added: ["a"] });
    expect(seen).toHaveLength(1);

    controller.detach();
    engine.emitArtifacts({ added: ["b"] });
    expect(seen).toHaveLength(1);
  });

  it("asks the engine for the current list, because events only describe CHANGES", async () => {
    const engine = new MockEngine();
    engine.files = [
      { name: "old.nc", size: 4, modifiedMs: 1, generation: 1, state: "ready", mime: "text/plain" },
    ];
    const seen: ArtifactsEvent[] = [];
    const controller = new ConsoleController(
      new FakeSurface(),
      { ...noopHooks(), onArtifacts: (event) => seen.push(event) },
      {},
    );
    controller.attach(engine as unknown as BrowserPython);

    await controller.refreshArtifacts();

    // A console mounted against an engine that has been running for ten minutes would otherwise
    // show nothing until the next file was written.
    expect(seen.at(-1)?.artifacts.map((a) => a.name)).toEqual(["old.nc"]);
  });

  it("swallows a refresh that fails, rather than putting it in the transcript", async () => {
    // A browser with no workspace answers `artifacts()` with a rejection. That is expected, and it
    // is not something to report every time a console is mounted.
    const engine = new MockEngine();
    engine.artifacts = async () => {
      throw new Error("no workspace in this browser");
    };
    const seen: ArtifactsEvent[] = [];
    const controller = new ConsoleController(
      new FakeSurface(),
      { ...noopHooks(), onArtifacts: (event) => seen.push(event) },
      {},
    );
    controller.attach(engine as unknown as BrowserPython);

    await expect(controller.refreshArtifacts()).resolves.toBeUndefined();
    expect(seen).toHaveLength(0);
  });
});

describe("completion offsets cross a unit boundary", () => {
  it("sends the surface's own UTF-16 cursor through unconverted", async () => {
    // ONE UNIT ACROSS THE WHOLE JAVASCRIPT SIDE. Converting the caret to Python characters here
    // puts the request five units left of the caret in a line with five emoji, and the Worker -
    // which slices with `String.slice()` - then asks Python about a prefix of what was typed.
    // `tests/completion-cursor.test.ts` covers the far side against the real Worker code.
    const { controller, surface, engine } = build();
    surface.setCommand("😀 ds.ise");
    surface.setCursor("😀 ds.ise".length);
    let sawCursor = -1;
    engine.nextComplete = async (_source, cursor) => {
      sawCursor = cursor;
      // The engine answers in UTF-16 too: the emoji is two units wide, so the token starts at 3.
      return { start: 3, matches: ["ds.isel"] };
    };

    await controller.requestCompletion();

    expect(sawCursor, "UTF-16 code units, as source.length counts them").toBe(9);
    // The replacement lands on the token and leaves the emoji whole.
    expect(surface.command).toBe("😀 ds.isel");
    expect([...surface.command].filter((c) => c === "😀")).toHaveLength(1);
  });
});

describe("a dead interpreter does not leave callers waiting", () => {
  it("rejects execute() when the engine fails while its block is queued", async () => {
    // `execute()` resolving only when its block has actually run is the right contract, and a
    // failed startup must not turn it into a promise that never settles: a host awaiting it in a
    // lifecycle hook would hang there, with no error and nothing in the transcript to explain it.
    const { controller, engine } = build();
    engine.emitStatus("loading");
    const running = controller.execute("import numpy as np\nnp.arange(5)\n");
    await settle();

    engine.emitStatus("error", "the runtime could not be reached");

    await expect(running).rejects.toThrow(/could not be reached/);
  });

  it("discards the queue rather than replaying it into the next interpreter", async () => {
    // The lines were typed for an interpreter that no longer exists. Running them against its
    // replacement is not recovery, it is executing code somebody wrote for a different session.
    const { controller, engine } = build();
    engine.emitStatus("loading");
    void controller.execute("secret = 1\nprint(secret)\n").catch(() => undefined);
    await settle();
    engine.emitStatus("error", "gone");
    await settle();

    const before = engine.pushes.length;
    engine.emitStatus("ready");
    await settle();
    expect(engine.pushes.length).toBe(before);
  });
});

describe("background output is not attributed to the last execution", () => {
  it("groups it under its own identity", async () => {
    // A `__del__` on a later collection, an `atexit` hook: real output that belongs to no
    // statement. Labelling it with the last execution's id puts a line inside a block that had
    // finished, and presents that guess as fact.
    const { engine, surface } = build();
    engine.emitOutput({ type: "stdout", executionId: "exec-1", text: "during\n" });
    await frame();
    engine.emitOutput({
      type: "stdout",
      executionId: "exec-1",
      text: "after\n",
      background: true,
    });
    await frame();

    const during = surface.text.find((entry) => entry.text.includes("during"));
    const after = surface.text.find((entry) => entry.text.includes("after"));
    expect(during?.executionId).toBe("exec-1");
    expect(after?.executionId).toBe(BACKGROUND_EXECUTION_ID);
  });
});

// `clear`, and Ctrl+C: two additions that are not Python and are here anyway, for opposite
// reasons. `clear` is a word every terminal answers and Python does not, so a NameError answers a
// reasonable reflex with a stack trace; Ctrl+C is a key Python DOES answer.
describe("the clear command", () => {
  it("empties the transcript without sending anything to the interpreter", async () => {
    const { controller, surface, engine } = build();
    await controller.submit("value = 1");
    expect(engine.pushes).toEqual(["value = 1"]);

    await controller.submit("clear");
    expect(engine.pushes).toEqual(["value = 1"]);
    expect(surface.clears).toBe(1);
    expect(surface.prompt).toBe(">>> ");
  });

  it("accepts the call form too", async () => {
    const { controller, surface, engine } = build();
    await controller.submit("clear()");
    expect(engine.pushes).toEqual([]);
    expect(surface.clears).toBe(1);
  });

  it("leaves every other use of the name to Python", async () => {
    // The one case shadowed is a bare `clear`, the case Python would have answered with a
    // NameError. Binding it, calling it with an argument, deleting it and printing it are all
    // somebody's program and go to the interpreter untouched.
    const { controller, engine } = build();
    for (const line of [
      "clear = 5",
      "clear(x)",
      "del clear",
      "print(clear)",
      "clear ",
      " clears",
    ]) {
      await controller.submit(line);
    }
    expect(engine.pushes).toEqual([
      "clear = 5",
      "clear(x)",
      "del clear",
      "print(clear)",
      " clears",
    ]);
  });

  it("is a line of the program while a statement is open", async () => {
    // At a `... ` prompt this is somebody's loop body, not a command to the console.
    const { controller, engine, surface } = build();
    engine.nextPush = async () => ({ executionId: "e", syntax: "incomplete", executed: false });
    await controller.submit("for row in rows:");
    expect(surface.prompt).toBe("... ");
    await controller.submit("    clear");
    expect(engine.pushes).toEqual(["for row in rows:", "    clear"]);
    expect(surface.clears).toBe(0);
  });
});

describe("Ctrl+C", () => {
  it("echoes the abandoned line and answers KeyboardInterrupt", async () => {
    const { controller, surface } = build();
    surface.setCommand("value = (1,");
    await controller.clearBuffer();
    const last = surface.text.slice(-2);
    expect(last[0]).toMatchObject({ kind: "command", text: "value = (1," });
    expect(last[1]).toMatchObject({ kind: "stderr", text: "KeyboardInterrupt\n" });
    expect(surface.command).toBe("");
    expect(surface.prompt).toBe(">>> ");
  });

  // AN EMPTY PROMPT IS ECHOED TOO. Echoing nothing produces a bare `KeyboardInterrupt` with no
  // prompt above it, and five presses print five in a column - which reads as five interrupts of
  // something rather than five empty lines abandoned. CPython echoes the prompt:
  //
  //     >>>
  //     KeyboardInterrupt
  //     >>>
  //
  // So: exactly ONE command entry, empty, at the primary prompt, and the message under it.
  it("answers at an empty prompt too, echoing the bare prompt as CPython does", async () => {
    const { controller, surface } = build();
    await controller.clearBuffer();
    expect(surface.text.at(-1)).toMatchObject({ kind: "stderr", text: "KeyboardInterrupt\n" });
    const echoed = surface.text.filter((entry) => entry.kind === "command");
    expect(echoed).toHaveLength(1);
    expect(echoed[0]).toMatchObject({ text: "", prompt: ">>> " });
  });

  it("echoes the continuation prompt when a statement was open", async () => {
    // What CPython shows: the `... ` line the visitor was on, then the message.
    const { controller, surface, engine } = build();
    engine.nextPush = async () => ({ executionId: "e", syntax: "incomplete", executed: false });
    await controller.submit("def f():");
    await controller.clearBuffer();
    const last = surface.text.slice(-2);
    expect(last[0]).toMatchObject({ kind: "command", prompt: "... " });
    expect(last[1]).toMatchObject({ kind: "stderr", text: "KeyboardInterrupt\n" });
    expect(surface.prompt).toBe(">>> ");
  });
});

// Following, and who decides it. A reader who scrolls back must not be dragged to the end by
// output they did not cause - and must be taken there by output they did. Left to the browser
// scrolling a focused caret into view, the two cannot be told apart.
describe("returning to the bottom", () => {
  it("follows the latest when the reader submits a line", async () => {
    const { controller, surface } = build();
    surface.follows = 0;
    await controller.submit("1 + 1");
    expect(surface.follows).toBeGreaterThan(0);
  });

  it("follows on a paste, which is also the reader submitting", async () => {
    const { controller, surface } = build();
    surface.follows = 0;
    await controller.submitBlock("a = 1\nb = 2\n", { origin: "paste" });
    expect(surface.follows).toBeGreaterThan(0);
  });

  it("does NOT follow when a host runs something", async () => {
    // `Try in Python`, `execute()`, a registered example: output the reader did not type. Where
    // they are reading is where they stay, and `Jump to latest` is how they hear about it.
    const { controller, surface } = build();
    surface.follows = 0;
    await controller.submitBlock("print('hello')\n", { origin: "programmatic" });
    expect(surface.follows).toBe(0);
  });
});

// A WEDGED INTERPRETER STILL GETS AN ANSWER.
//
// `engine.interrupt()` is a round trip to the Worker, and a synchronous loop - `while True: pass`,
// or a long NumPy call - never lets the Worker read the message, so that promise never settles.
// Armed after the await, the "Still running" note would therefore never be armed at all, and the
// only case that needs it is the only case that would not get it. The real-engine suite cannot
// catch this: it interrupts `await asyncio.sleep(30)`, which yields to the Worker's event loop
// and answers immediately.
describe("Ctrl+C against an interpreter that cannot answer", () => {
  it("names Restart Python even when the interrupt round trip never settles", async () => {
    vi.useFakeTimers();
    try {
      const { controller, surface, engine } = build();
      let releasePush: ((value: PushResult) => void) | undefined;
      engine.nextPush = () =>
        new Promise<PushResult>((resolve) => {
          releasePush = resolve;
        });
      // Not awaited: the execution is still in flight, which is the state Ctrl+C is for.
      void controller.submit("while True: pass");
      await Promise.resolve();

      // The wedged Worker: no reply, ever.
      engine.interrupt = () => new Promise<boolean>(() => {});
      void controller.interrupt();
      await Promise.resolve();

      expect(surface.text.at(-1)).toMatchObject({ kind: "status", text: "^C\n" });
      await vi.advanceTimersByTimeAsync(1500);
      expect(surface.text.at(-1)).toMatchObject({
        kind: "status",
        text: expect.stringContaining("Restart Python"),
      });
      releasePush?.({ executionId: "e", syntax: "complete", executed: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("says nothing more when the interrupt lands and the execution ends", async () => {
    vi.useFakeTimers();
    try {
      const { controller, surface, engine } = build();
      let releasePush: ((value: PushResult) => void) | undefined;
      engine.nextPush = () =>
        new Promise<PushResult>((resolve) => {
          releasePush = resolve;
        });
      void controller.submit("await asyncio.sleep(30)");
      await Promise.resolve();

      engine.interruptAnswer = true;
      await controller.interrupt();
      releasePush?.({ executionId: "e", syntax: "complete", executed: true });
      await vi.advanceTimersByTimeAsync(1500);

      const notes = surface.text.filter(
        (entry) => entry.kind === "status" && entry.text.includes("Restart Python"),
      );
      expect(notes).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// HOST STARTUP CODE MUST NOT REACH THE TRANSCRIPT.
//
// A host with wheels to install, a path to set up or an import to warm has two ways to run it, and
// only one of them is right. `submitBlock` - what `element.execute()` calls - means "behave as
// though this were typed", so the source is echoed at a prompt and recorded in history: a visitor
// opens the console and the first thing they see is somebody else's bootstrap. The engine's own
// `run()` executes the same code with no echo and no history entry, which is what startup work
// wants. This pins the difference so a host is not left to discover it.
describe("startup code a host runs before the visitor arrives", () => {
  const BOOTSTRAP = 'import micropip\nawait micropip.install("/assets/python/x.whl", deps=False)\n';

  it("reaches the transcript when it goes through submitBlock, which is why it must not", async () => {
    const { controller, surface } = build();
    await controller.submitBlock(BOOTSTRAP, { origin: "programmatic" });
    expect(surface.text.some((entry) => entry.text.includes("micropip"))).toBe(true);
  });

  it("leaves a clean prompt when the host runs it on the engine instead", async () => {
    const { controller, surface, engine } = build();
    await engine.run(BOOTSTRAP);
    expect(surface.text.some((entry) => entry.text.includes("micropip"))).toBe(false);
    expect(controller.history.entries).toEqual([]);
    expect(surface.prompt).toBe(">>> ");
    expect(surface.command).toBe("");
  });

  // A restart is a new interpreter, so a host runs its startup code again. The second run must be
  // as invisible as the first: this is the path where an echo would appear only after a restart,
  // which is the hardest kind to notice.
  it("stays clean across a restart, when the host runs it again", async () => {
    const { controller, surface, engine } = build();
    await engine.run(BOOTSTRAP);
    await engine.restart();
    await engine.run(BOOTSTRAP);
    expect(surface.text.some((entry) => entry.text.includes("micropip"))).toBe(false);
    expect(controller.history.entries).toEqual([]);
    expect(surface.prompt).toBe(">>> ");
  });

  // AND WHY `run()` IS STILL THE WRONG HOOK, invisible though it is. A Python-level failure does
  // not reject: the worker answers with `ExecutionResult.error` set and the promise RESOLVES, so
  // a host that forgets to read the field announces a ready console with none of the wheels in
  // it - the same defect as `except Exception: pass`. `startupSource` is the checked path; see
  // `tests/engine.test.ts`.
  it("resolves rather than rejecting when the code raises, which is the trap", async () => {
    const { engine } = build();
    engine.run = async (): Promise<ExecutionResult> => ({
      executionId: "e",
      error: "ModuleNotFoundError: micropip",
    });
    const outcome = await engine.run(BOOTSTRAP);
    expect(outcome.error).toContain("ModuleNotFoundError");
  });
});
