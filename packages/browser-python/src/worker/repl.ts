/**
 * repl.ts - the interactive console, and the proxy discipline that keeps it alive.
 *
 * The console is `pyodide.console.PyodideConsole`, not `eval`, `exec` or `code.interact()`: it
 * knows that `def f():` is INCOMPLETE rather than a syntax error, that a bare expression's value
 * is echoed while a statement's is not, and that `await` at top level is legal.
 * `code.interact()` is the trap in particular - it owns the input loop and reads synchronously,
 * so in a browser it blocks the worker forever or is fed a future it cannot await.
 *
 * Proxy ownership. A PyProxy is a JavaScript handle on a Python object with a MANUAL lifetime:
 * one you keep must be destroyed exactly once, and one borrowed from a parent must not outlive
 * the parent. Pulling `PyodideConsole` off the `pyodide.console` module proxy and destroying the
 * module leaves a callable whose parent is gone - it works for a while, then fails with "This
 * borrowed proxy was automatically destroyed", typically on the *second* command. So exactly one
 * long-lived proxy exists, the `_freva_bridge` MODULE, destroyed only at teardown, and every
 * helper is reached through it. Temporaries are destroyed in `finally` blocks, and `#live`
 * counts them so a test can assert it returns to zero after a hundred commands.
 */

import type { OutputBridge } from "./output.js";
import type { PyodideApi } from "./pyodide-runtime.js";
import type { CompletionResult, ExecutionResult, PushResult, ReplSyntaxState } from "../types.js";
import { lastMeaningfulLine } from "./startup-failure.js";

/** Python's character offset as a JS string index - the ONE place the two units meet. */
export function codePointsToUtf16(source: string, offset: number): number {
  let index = 0;
  for (let count = 0; count < offset && index < source.length; count += 1) {
    index += (source.codePointAt(index) ?? 0) > 0xffff ? 2 : 1;
  }
  return index;
}

/** A PyProxy, in the only two respects this file cares about. */
interface Destroyable {
  destroy(): void;
}

function isDestroyable(value: unknown): value is Destroyable {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { destroy?: unknown }).destroy === "function"
  );
}

/** The `_freva_bridge` module proxy: the one long-lived handle. See the file header. */
interface Bridge extends Destroyable {
  make_console(stdout: (t: string) => void, stderr: (t: string) => void): boolean;
  console_push(line: string): unknown;
  run_future(future: unknown): Promise<unknown>;
  run_source(source: string): unknown;
  clear_buffer(): boolean;
  interrupt(): boolean;
  complete(source: string): unknown;
  capture_display(): unknown;
  install_browser_http(): string;
  install_cartopy_data(): string;
  versions(names: string[]): unknown;
  python_version(): string;
}

/**
 * A Python callable reached through the bridge. `callPromising` enters Python with WebAssembly
 * stack switching enabled, which makes `pyodide.ffi.run_sync` legal underneath the call. It is
 * `undefined` without JSPI and is experimental Pyodide API, so it is never assumed.
 */
interface PromisingCallable extends Destroyable {
  (): unknown;
  callPromising?: () => Promise<unknown>;
}

/** A Python tuple/list arriving as a proxy, with the accessors used to read it. */
interface Sequence extends Destroyable {
  length?: number;
  get?(index: number): unknown;
  toJs?(options?: { create_pyproxies?: boolean; dict_converter?: unknown }): unknown;
}

export class Repl {
  readonly #pyodide: PyodideApi;
  readonly #output: OutputBridge;
  #bridge: Bridge | null = null;
  /** Temporaries currently held. Asserted back to zero by the browser suite - see the header. */
  #live = 0;

  constructor(pyodide: PyodideApi, output: OutputBridge) {
    this.#pyodide = pyodide;
    this.#output = output;
  }

  /** Temporary proxies currently outstanding. Zero whenever no call is in progress. */
  get liveProxies(): number {
    return this.#live;
  }

  /**
   * Import the bridge and build the console. `pyimport` is used ONCE, for a module that is then
   * kept: no attribute is lifted off a module that is subsequently destroyed, and nothing is
   * `.copy()`-ed.
   */
  async start(): Promise<void> {
    this.#pyodide.runPython(
      `import sys\nif "/freva" not in sys.path: sys.path.insert(0, "/freva")\nimport _freva_bridge`,
    );
    const bridge = this.#pyodide.globals.get("_freva_bridge");
    if (!isDestroyable(bridge)) {
      throw new Error("The Python bridge module did not load.");
    }
    this.#bridge = bridge as unknown as Bridge;

    // Stream callbacks go to the console, NOT to `pyodide.setStdout`. Both exist and are not the
    // same thing: `setStdout` catches everything the interpreter writes, including Pyodide's own
    // loading chatter, while the console's callbacks are scoped to a user's execution. The global
    // hook would attribute a package's import-time warning to whatever the user last typed.
    this.#bridge.make_console(
      (text: string) => this.#output.stdout(text),
      (text: string) => this.#output.stderr(text),
    );
  }

  /** Install the Fetch-backed filesystem. Only meaningful once fsspec is loaded. */
  installBrowserHttp(): string {
    return this.#requireBridge().install_browser_http();
  }

  /**
   * Arm Cartopy's on-demand Natural Earth downloads. Cheap and unconditional: a `sys.meta_path`
   * finder that answers for one module name and imports nothing, so a session that never draws a
   * map pays a dictionary lookup per import. Waiting until Cartopy is known to be present would
   * mean importing it to find out, the several-megabyte cost lazy loading exists to avoid.
   */
  installCartopyData(): string {
    return this.#requireBridge().install_cartopy_data();
  }

  resolveVersions(names: readonly string[]): Record<string, string> {
    const raw = this.#requireBridge().versions([...names]);
    return this.#toPlainObject(raw);
  }

  pythonVersion(): string {
    return this.#requireBridge().python_version();
  }

  /**
   * One line into the console. The three-way answer - incomplete, syntax error, executed - is
   * what a UI needs to choose between a `>>>` prompt, an error and a `...` continuation, and it
   * comes from the console's own parser rather than from guessing at the text.
   */
  async push(line: string): Promise<Omit<PushResult, "executionId">> {
    const bridge = this.#requireBridge();

    // `console_push` returns (syntax, error, future|None). The future is the only Python object
    // that crosses, and only when there is something to await.
    const pushed = bridge.console_push(line) as Sequence;
    this.#live += 1;
    let syntax: ReplSyntaxState;
    let syntaxError = "";
    let future: unknown = null;
    try {
      syntax = this.#at(pushed, 0) as ReplSyntaxState;
      syntaxError = String(this.#at(pushed, 1) ?? "");
      future = this.#at(pushed, 2) ?? null;
    } finally {
      pushed.destroy();
      this.#live -= 1;
    }

    if (syntax === "incomplete") {
      // Nothing ran. This is what a continuation prompt is reporting, and emitting a result here
      // would make a half-typed `for` loop look like it produced a value.
      return { syntax, executed: false };
    }
    if (syntax === "syntax-error") {
      const error = syntaxError.trimEnd();
      this.#output.stderr(`${error}\n`);
      return { syntax, executed: false, error };
    }

    const outcome = await this.#awaitFuture(future);
    await this.#emitDisplay();
    return { syntax: "complete", executed: true, ...outcome };
  }

  /** A whole snippet, as if from a file. Deliberately does not touch the console's line buffer. */
  async run(code: string): Promise<Omit<ExecutionResult, "executionId">> {
    const bridge = this.#requireBridge();
    // Imports are resolved BEFORE the code runs. This is what makes `import xarray as xr` work at
    // a prompt without anyone calling `loadPackage` first: Pyodide reads the import statements
    // and fetches the wheels it has. It is also why Matplotlib can be absent at startup and
    // present the moment somebody imports it.
    await this.#pyodide.loadPackagesFromImports(code);
    // Awaited: `run_source` is async, because a snippet may itself contain a top-level await.
    const returned = (await bridge.run_source(code)) as Sequence;
    this.#live += 1;
    let error: string | null = null;
    try {
      error = (this.#at(returned, 2) as string | null) ?? null;
    } finally {
      returned.destroy();
      this.#live -= 1;
    }
    await this.#emitDisplay();
    if (error) {
      this.#output.stderr(error.endsWith("\n") ? error : `${error}\n`);
      return { error: error.trimEnd() };
    }
    return {};
  }

  clearBuffer(): void {
    this.#requireBridge().clear_buffer();
  }

  /**
   * Ctrl+C. Returns whether there was anything to interrupt.
   *
   * SYNCHRONOUS, and it has to be: called from the worker's message handler while Python is
   * suspended at an `await` inside the visitor's execution, so it re-enters Python
   * mid-execution, which is only safe for a call that cannot itself suspend.
   * `_freva_bridge.interrupt` has no `await` in it; it records a cancellation on the running
   * task and returns, and Python's event loop delivers the `CancelledError` later.
   */
  interrupt(): boolean {
    const bridge = this.#bridge;
    // Not `#requireBridge`: an interrupt aimed at an interpreter that is already gone is answered
    // "there was nothing to interrupt", which is true, rather than thrown at a visitor who pressed
    // a key at an unlucky moment.
    if (!bridge) return false;
    return Boolean(bridge.interrupt());
  }

  /**
   * THIS PACKAGE'S OWN PLUMBING IS NOT OFFERED AS A COMPLETION.
   *
   * Six modules are written into `/freva` and imported at start-up so the console can work at
   * all: the REPL bridge, the HTTP shim, the Cartopy downloader, the Matplotlib backend, the
   * rich display hook and the freva-client patches. They are on `sys.path`, so completion would
   * offer `freva_client_compat` beside `freva_client` - an internal name one keystroke from the
   * real one. Hidden from COMPLETION only: they stay importable and `sys.modules` is untouched.
   */
  static readonly #PRIVATE_MODULES: ReadonlySet<string> = new Set([
    "_freva_bridge",
    "browser_http",
    "browser_s3",
    "cartopy_data",
    "freva_browser_backend",
    "freva_client_compat",
    "rich_display",
  ]);

  /**
   * Is this candidate one of them? The match is on the module name as a whole, or on the head of
   * a dotted path, so `freva_client_compat.install` goes too and `freva_client` - whose name is a
   * prefix of an internal one - stays. The set is fixed and is this package's own file list, so
   * a visitor's own definitions are untouched.
   */
  static #isPrivateModule(candidate: string): boolean {
    const head = candidate.split(".")[0] ?? candidate;
    return Repl.#PRIVATE_MODULES.has(head);
  }

  /** `cursor` is UTF-16, so it slices directly; Python's `start` converts on the way out. */
  complete(source: string, cursor: number): CompletionResult {
    const bridge = this.#requireBridge();
    const head = source.slice(0, cursor);
    const returned = bridge.complete(head) as Sequence;
    this.#live += 1;
    try {
      const rawMatches = this.#at(returned, 0) as Sequence | undefined;
      const start = codePointsToUtf16(head, Number(this.#at(returned, 1) ?? head.length));
      const matches: string[] = [];
      if (rawMatches && isDestroyable(rawMatches)) {
        this.#live += 1;
        try {
          const length = Number(rawMatches.length ?? 0);
          for (let i = 0; i < length; i += 1) {
            const match = String(rawMatches.get?.(i) ?? "");
            if (!Repl.#isPrivateModule(match)) matches.push(match);
          }
        } finally {
          rawMatches.destroy();
          this.#live -= 1;
        }
      }
      return { start, matches };
    } finally {
      returned.destroy();
      this.#live -= 1;
    }
  }

  /** Release the one long-lived proxy. After this the Repl is unusable. */
  destroy(): void {
    const bridge = this.#bridge;
    this.#bridge = null;
    if (!bridge) return;
    try {
      bridge.destroy();
    } catch {
      // The interpreter may already be gone (a terminated worker, a fatal error). Failing to free
      // memory that is about to be discarded with the whole WASM heap is not worth reporting.
    }
  }

  // ------ internals

  #requireBridge(): Bridge {
    if (!this.#bridge) throw new Error("The Python bridge is not available.");
    return this.#bridge;
  }

  /**
   * Await a ConsoleFuture. The future is handed straight back to Python, which awaits it and
   * returns primitives - see `_freva_bridge.run_future` for why. What remains here is one
   * `destroy()` in a `finally`, which runs on the exception path too, an execution that raises
   * being the ordinary case in a REPL.
   */
  async #awaitFuture(future: unknown): Promise<{ result?: string; error?: string }> {
    if (!isDestroyable(future)) return {};
    const bridge = this.#requireBridge();
    this.#live += 1;
    let returned: Sequence | null = null;
    try {
      returned = (await bridge.run_future(future)) as Sequence;
      this.#live += 1;
      try {
        const hasValue = Boolean(this.#at(returned, 0));
        const text = String(this.#at(returned, 1) ?? "");
        const error = (this.#at(returned, 2) as string | null) ?? null;
        if (error) {
          this.#output.stderr(error.endsWith("\n") ? error : `${error}\n`);
          return { error: error.trimEnd() };
        }
        if (hasValue) {
          this.#output.result(text);
          return { result: text };
        }
        return {};
      } finally {
        returned.destroy();
        this.#live -= 1;
      }
    } finally {
      future.destroy();
      this.#live -= 1;
    }
  }

  /** Read one element of a Python tuple that arrived as a proxy. */
  #at(sequence: Sequence, index: number): unknown {
    return sequence.get?.(index);
  }

  /**
   * Collect whatever rich output the execution produced. Called after EVERY execution and cheap
   * when nothing plotted: the Python side answers with an empty list after one `sys.modules`
   * lookup.
   */
  async #emitDisplay(): Promise<void> {
    const bridge = this.#bridge;
    if (!bridge) return;
    let payloads: Sequence;
    try {
      payloads = (await this.#captureDisplay(bridge)) as Sequence;
    } catch (error) {
      // The bridge is an ordinary attribute of an ordinary module in the user's own namespace, so
      // `_freva_bridge.capture_display = lambda: 1/0` is typeable at the prompt, and the
      // Python-side try/except cannot help because the function that would have caught it is the
      // one replaced. Losing the display is the correct cost; losing the RESULT is not.
      this.#output.stderr(
        `[browser-python] the display bridge raised and was skipped: ${
          lastMeaningfulLine(error) ?? String(error)
        }\n`,
      );
      return;
    }
    if (!isDestroyable(payloads)) return;
    this.#live += 1;
    try {
      const plain = payloads.toJs?.({ create_pyproxies: false, dict_converter: undefined });
      const list = Array.isArray(plain) ? plain : [];
      for (const entry of list) {
        // A Map when `dict_converter` is left at its default; an object when a host converts it.
        this.#output.display(entry instanceof Map ? Object.fromEntries(entry) : entry);
      }
    } finally {
      payloads.destroy();
      this.#live -= 1;
    }
  }

  /**
   * Call `capture_display` in a way that MAY SUSPEND, because rendering can reach the network.
   *
   * This is the boundary the Cartopy downloader lives behind. `plt.show()` does not draw: the
   * browser backend marks the figure and the drawing happens here, in `savefig()`, AFTER the
   * user's program has finished, so Cartopy asks for a missing 50m coastline from inside THIS
   * call - and `run_sync` is only legal when the JS-to-Python entry was made with stack
   * switching enabled, Pyodide otherwise refusing with "Cannot stack switch because the Python
   * entrypoint was a synchronous function" and losing the figure. `callPromising` is that entry;
   * it is experimental and absent without JSPI, so the plain call remains the fallback.
   */
  async #captureDisplay(bridge: Bridge): Promise<unknown> {
    const capture = (bridge as unknown as { capture_display?: PromisingCallable }).capture_display;
    if (typeof capture !== "function" || typeof capture.callPromising !== "function") {
      return bridge.capture_display();
    }
    // The attribute access made a proxy; it is ours and it is destroyed here. Counted like every
    // other temporary so the suite's "no proxy survives a hundred commands" assertion holds.
    this.#live += 1;
    try {
      return await capture.callPromising();
    } catch (error) {
      // A runtime that HAS the method but cannot stack switch (an asyncify build, a browser that
      // dropped the flag) rejects here before Python runs. Falling back to the plain call keeps
      // such a browser exactly as capable; a Python-side failure cannot arrive this way, because
      // `capture_display` catches its own exceptions and answers with a text payload.
      this.#output.stderr(
        `[browser-python] display capture could not use stack switching: ${
          lastMeaningfulLine(error) ?? String(error)
        }\n`,
      );
      return bridge.capture_display();
    } finally {
      capture.destroy?.();
      this.#live -= 1;
    }
  }

  #toPlainObject(raw: unknown): Record<string, string> {
    if (!isDestroyable(raw)) return {};
    const proxy = raw as Sequence;
    this.#live += 1;
    try {
      const plain = proxy.toJs?.({ create_pyproxies: false });
      if (plain instanceof Map) {
        const out: Record<string, string> = {};
        for (const [key, value] of plain) out[String(key)] = String(value);
        return out;
      }
      if (plain && typeof plain === "object") {
        const out: Record<string, string> = {};
        for (const [key, value] of Object.entries(plain)) out[key] = String(value);
        return out;
      }
      return {};
    } finally {
      proxy.destroy();
      this.#live -= 1;
    }
  }
}
