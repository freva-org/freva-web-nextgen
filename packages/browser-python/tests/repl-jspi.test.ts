/**
 * A browser WITHOUT WebAssembly stack switching must not hear about it after every command.
 *
 * Pyodide defines `callPromising` whether or not the runtime can stack switch, and without JSPI
 * every call to it throws "WebAssembly stack switching not supported in this JavaScript runtime".
 * The REPL used to try it after each execution to collect figures, print a warning when it threw,
 * and fall back - so `1 + 1` in such a browser answered `2` followed by a red line about
 * WebAssembly. The worker now tells the REPL what it detected, and these tests hold both halves:
 * without JSPI the stack-switching entry is never attempted and nothing is printed; with it, the
 * entry is used; and Python is told the same answer `ready.jspi` reports.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Repl } from "../src/worker/repl.js";
import type { OutputBridge } from "../src/worker/output.js";
import type { PyodideApi } from "../src/worker/pyodide-runtime.js";

function sequence(values: unknown[]) {
  return { length: values.length, get: (i: number) => values[i], destroy: () => undefined };
}

/** A payload list, as `capture_display` returns it: empty, because nothing was plotted. */
const noFigures = () => ({ ...sequence([]), toJs: () => [] });

function harness(options: { jspi?: boolean; promising?: "throws" | "works" }) {
  const calls = { plain: 0, promising: 0, setJspi: [] as boolean[] };
  const capture = Object.assign(
    () => {
      calls.plain += 1;
      return noFigures();
    },
    {
      callPromising: async () => {
        calls.promising += 1;
        if (options.promising === "throws") {
          throw new Error("WebAssembly stack switching not supported in this JavaScript runtime");
        }
        return noFigures();
      },
      destroy: () => undefined,
    },
  );
  const bridge = {
    make_console: () => true,
    set_jspi: (available: boolean) => {
      calls.setJspi.push(available);
      return available;
    },
    console_push: () => sequence(["complete", "", { destroy: () => undefined }]),
    run_future: async () => sequence([true, "2", null]),
    run_source: async () => sequence([false, "", null]),
    clear_buffer: () => true,
    complete: () => sequence([sequence([]), 0]),
    get capture_display() {
      return capture;
    },
    install_browser_http: () => "",
    install_cartopy_data: () => "armed",
    versions: () => undefined,
    python_version: () => "3.14.2",
    destroy: () => undefined,
  };
  const pyodide = {
    runPython: () => undefined,
    loadPackagesFromImports: async () => undefined,
    globals: { get: () => bridge },
  } as unknown as PyodideApi;
  const stderr: string[] = [];
  const output = {
    stdout: () => undefined,
    stderr: (text: string) => stderr.push(text),
    result: () => undefined,
    display: () => undefined,
  } as unknown as OutputBridge;
  const repl = new Repl(pyodide, output, options.jspi === undefined ? {} : { jspi: options.jspi });
  return { repl, calls, stderr };
}

describe("the REPL and a runtime without JSPI", () => {
  it("never attempts the stack-switching entry, and prints nothing, when JSPI is absent", async () => {
    const { repl, calls, stderr } = harness({ jspi: false, promising: "throws" });
    await repl.start();
    const pushed = await repl.push("1 + 1");
    await repl.run("x = 1\nprint(x)");
    expect(pushed).toMatchObject({ syntax: "complete", executed: true, result: "2" });
    expect(calls.promising, "callPromising must not even be tried").toBe(0);
    expect(calls.plain, "figures are still collected, through the plain call").toBe(2);
    expect(stderr, "nothing about stack switching after an ordinary command").toEqual([]);
    expect(repl.liveProxies).toBe(0);
  });

  it("tells Python the same answer the worker detected", async () => {
    const without = harness({ jspi: false });
    await without.repl.start();
    expect(without.calls.setJspi).toEqual([false]);
    const withIt = harness({ jspi: true, promising: "works" });
    await withIt.repl.start();
    expect(withIt.calls.setJspi).toEqual([true]);
  });

  it("uses the stack-switching entry when JSPI is present, silently", async () => {
    const { repl, calls, stderr } = harness({ jspi: true, promising: "works" });
    await repl.start();
    await repl.push("1 + 1");
    expect(calls.promising).toBe(1);
    expect(calls.plain).toBe(0);
    expect(stderr).toEqual([]);
    expect(repl.liveProxies).toBe(0);
  });

  it("still reports an UNEXPECTED refusal where JSPI was detected, and keeps the figure path", async () => {
    const { repl, calls, stderr } = harness({ jspi: true, promising: "throws" });
    await repl.start();
    await repl.push("1 + 1");
    expect(calls.plain, "falls back to the plain call").toBe(1);
    expect(stderr.join("")).toMatch(/display capture could not use stack switching/);
  });
});

describe("the worker says nothing about JSPI at startup", () => {
  const read = (path: string) =>
    readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

  it("has no startup warning about stack switching", () => {
    const worker = read("../src/worker/browser-python.worker.ts");
    expect(worker).not.toMatch(/has no WebAssembly stack switching/);
    expect(worker).toMatch(/new Repl\(pyodide, output, \{ jspi: supportsJspi\(\) \}\)/);
    // ...and still REPORTS the capability, detected in the worker.
    expect(worker).toMatch(/jspi: supportsJspi\(\)/);
  });

  it("keeps the one JSPI message in Python, where the failing call is, with the Safari 27 link", () => {
    const bridge = read("../src/python/_freva_bridge.py");
    expect(bridge).toContain("Remote dataset access requires WebAssembly JSPI (stack switching)");
    expect(bridge).toContain("https://webkit.org/blog/18325/webkit-features-for-safari-27-0/");
    expect(bridge).toContain("def set_jspi(available):");
    // Only when JSPI is absent: the same message family with JSPI present is a real bug.
    expect(bridge).toMatch(/def _needs_jspi\(exc\):[\s\S]{0,1600}if _jspi:\s+return False/);
  });
});
