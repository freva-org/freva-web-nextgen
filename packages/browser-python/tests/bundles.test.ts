// MIME bundles at the protocol boundary, the worker's cell output, the comment-stripped Python
// sources and the resource adapter.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  BUNDLE_MIMES,
  MAX_BUNDLE_CHARS,
  MAX_DISPLAY_HTML_CHARS,
  MAX_EXECUTION_DISPLAY_CHARS,
  MAX_TRACEBACK_CHARS,
  boundTraceback,
  displayLimit,
  isBundleMime,
  isDisplayMime,
  validateBundle,
  type WorkerMessage,
} from "../src/protocol.js";
import { NOTICE_MIME } from "../src/types.js";
import { CellOutput, OutputBridge } from "../src/worker/output.js";
import { fetchedBytes, wasmCapacityBytes } from "../src/worker/resources.js";
import { stripPythonComments } from "../scripts/strip-python-comments.mjs";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("validateBundle", () => {
  it("carries the five bundle types, while a single display stays PNG and plain text", () => {
    expect([...BUNDLE_MIMES].sort()).toEqual(
      ["image/png", "image/svg+xml", NOTICE_MIME, "text/html", "text/plain"].sort(),
    );
    expect(isBundleMime("text/html")).toBe(true);
    expect(isDisplayMime("text/html")).toBe(false);
    expect(isBundleMime("application/javascript")).toBe(false);
  });

  it("accepts a well-formed bundle and keeps only pixel sizes as metadata", () => {
    const checked = validateBundle({
      data: { "text/plain": "x", "image/png": PNG, "text/html": "<b>x</b>" },
      metadata: {
        "image/png": { width: 10, height: 20, isolated: true },
        "text/html": { width: -1 },
      },
    });
    expect(checked).toEqual({
      ok: true,
      value: {
        data: { "text/plain": "x", "image/png": PNG, "text/html": "<b>x</b>" },
        metadata: { "image/png": { width: 10, height: 20 } },
      },
    });
  });

  it.each([
    [{ data: { "text/plain": "x", "application/javascript": "1" } }, /unsupported mime/],
    [{ data: { "text/html": "<b>" } }, /text\/plain is missing/],
    [{ data: { "text/plain": 3 } }, /must be a string/],
    [{ data: { "text/plain": "x", "image/png": "!!" } }, /base64/],
    [{ data: ["text/plain"] }, /unsupported mime/],
    [{ data: null }, /data must be an object/],
    [
      { data: { "text/plain": "x", "text/html": "a".repeat(MAX_DISPLAY_HTML_CHARS + 1) } },
      /over the/,
    ],
  ])("refuses %#", (candidate, error) => {
    const checked = validateBundle(candidate);
    expect(checked.ok).toBe(false);
    expect((checked as { error: string }).error).toMatch(error);
  });

  it("bounds the whole bundle as well as each representation", () => {
    const svg = "a".repeat(displayLimit("image/svg+xml"));
    const many = {
      "text/plain": "x",
      "image/svg+xml": svg,
      "image/png": "QUJD".repeat(MAX_BUNDLE_CHARS / 4 - svg.length / 4 + 4),
    };
    expect(validateBundle({ data: many })).toMatchObject({ ok: false });
  });

  it("bounds a traceback and says how much was cut", () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i} ${"x".repeat(100)}`);
    const bounded = boundTraceback(lines);
    expect(bounded.join("\n").length).toBeLessThanOrEqual(MAX_TRACEBACK_CHARS + 200);
    expect(bounded.at(-1)).toMatch(/traceback truncated: \d+ lines omitted/);
    expect(boundTraceback(["a", "b"])).toEqual(["a", "b"]);
  });
});

describe("CellOutput (the worker's side)", () => {
  function harness() {
    const posted: WorkerMessage[] = [];
    const post = (m: WorkerMessage) => posted.push(m);
    const bridge = new OutputBridge(post);
    return { posted, bridge, cells: new CellOutput(bridge, post) };
  }

  it("announces the start before any output and flushes text before a bundle", () => {
    const { posted, bridge, cells } = harness();
    bridge.beginExecution("e1");
    cells.start("e1", 3, "tok");
    bridge.stdout("printed first\n");
    cells.publish({ output: "execute_result", data: { "text/plain": "1" }, executionCount: 3 });
    bridge.endExecution();
    expect(posted.map((m) => m.kind)).toEqual(["execute-input", "stdout", "bundle"]);
    expect(posted[0]).toMatchObject({ executionId: "e1", executionCount: 3, token: "tok" });
    expect(posted[2]).toMatchObject({
      type: "execute_result",
      executionCount: 3,
      executionId: "e1",
    });
  });

  it("drops a forged bundle with one line of explanation", () => {
    const { posted, bridge, cells } = harness();
    bridge.beginExecution("e1");
    cells.publish({ output: "display_data", data: { "text/plain": "x", "text/x-evil": "y" } });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ kind: "stderr" });
    expect((posted[0] as { text: string }).text).toMatch(/dropped a display payload/);
  });

  it("spends the execution's display budget and stops with one notice", () => {
    const { posted, bridge, cells } = harness();
    bridge.beginExecution("e1");
    const big = {
      output: "display_data",
      data: { "text/plain": "x", "image/svg+xml": "a".repeat(4 * 1024 * 1024) },
    };
    const fits = Math.floor(MAX_EXECUTION_DISPLAY_CHARS / (4 * 1024 * 1024 + 1));
    for (let i = 0; i < fits + 3; i += 1) cells.publish(big);
    const bundles = posted.filter((m) => m.kind === "bundle");
    const notices = posted.filter((m) => m.kind === "stderr");
    expect(bundles).toHaveLength(fits);
    expect(notices).toHaveLength(1);
    expect((notices[0] as { text: string }).text).toMatch(/display output limit reached/);
  });

  it("clear_output and errors keep their order, the traceback bounded", () => {
    const { posted, bridge, cells } = harness();
    bridge.beginExecution("e1");
    bridge.stderr("warn\n");
    cells.publish({ output: "clear_output", wait: true });
    cells.error("e1", "ValueError", "boom", ["Traceback", "ValueError: boom"]);
    expect(posted.map((m) => m.kind)).toEqual(["stderr", "clear-output", "cell-error"]);
    expect(posted[2]).toMatchObject({ text: "Traceback\nValueError: boom", ename: "ValueError" });
  });

  it("output after the execution ended is marked background", () => {
    const { posted, bridge, cells } = harness();
    bridge.beginExecution("e1");
    bridge.endExecution();
    cells.publish({ output: "display_data", data: { "text/plain": "late" } });
    expect(posted[0]).toMatchObject({ kind: "bundle", background: true, executionId: "e1" });
  });
});

describe("embedded Python sources", () => {
  const dir = fileURLToPath(new URL("../src/python/", import.meta.url));
  const files = readdirSync(dir).filter((f) => f.endsWith(".py"));

  it("keep every line and every string, losing only comments", () => {
    for (const file of files) {
      const source = readFileSync(`${dir}${file}`, "utf8");
      const stripped = stripPythonComments(source);
      expect(stripped.split("\n")).toHaveLength(source.split("\n").length);
      expect(stripped).not.toMatch(/^\s*#/m);
    }
    expect(stripPythonComments('x = "# not a comment"  # comment\n')).toBe(
      'x = "# not a comment"\n',
    );
    expect(stripPythonComments('s = """\n# inside\n"""\n')).toBe('s = """\n# inside\n"""\n');
    expect(stripPythonComments("r = r'\\'' # c\n")).toBe("r = r'\\''\n");
    expect(() => stripPythonComments('f"{d["k"]}"\n')).toThrow(/same-quote nesting/);
  });

  // Where Python is installed, the strongest check there is: the parsed program is unchanged,
  // line and column of every node included.
  const python = (() => {
    try {
      execFileSync("python3", ["--version"]);
      return true;
    } catch {
      return false;
    }
  })();
  it.skipIf(!python)("parse to the identical AST, positions included", () => {
    for (const file of files) {
      const source = readFileSync(`${dir}${file}`, "utf8");
      const dump = (text: string) =>
        execFileSync(
          "python3",
          [
            "-c",
            "import ast,sys;print(ast.dump(ast.parse(sys.stdin.read()),include_attributes=True))",
          ],
          {
            input: text,
            encoding: "utf8",
            maxBuffer: 64 * 1024 * 1024,
          },
        );
      expect(dump(stripPythonComments(source))).toBe(dump(source));
    }
  });
});

describe("resource adapter", () => {
  it("reads the heap capacity, and nothing that is not one", () => {
    expect(wasmCapacityBytes({ _module: { HEAPU8: { buffer: { byteLength: 1 << 26 } } } })).toBe(
      1 << 26,
    );
    expect(wasmCapacityBytes({})).toBeUndefined();
    expect(wasmCapacityBytes(null)).toBeUndefined();
    expect(
      wasmCapacityBytes({ _module: { HEAPU8: { buffer: { byteLength: 0 } } } }),
    ).toBeUndefined();
    expect(
      wasmCapacityBytes({
        get _module() {
          throw new Error("gone");
        },
      }),
    ).toBeUndefined();
  });

  it("keeps transfer and decoded sizes apart, and treats zeros as unknown", () => {
    const perf = {
      getEntriesByType: () => [
        { transferSize: 100, decodedBodySize: 400 },
        { transferSize: 0, decodedBodySize: 0 },
        { transferSize: 0, decodedBodySize: 50 },
      ],
    };
    expect(fetchedBytes(perf)).toEqual({ fetchedDecodedBytes: 450, transferBytesEstimate: 100 });
    expect(
      fetchedBytes({ getEntriesByType: () => [{ transferSize: 0, decodedBodySize: 0 }] }),
    ).toEqual({});
    expect(fetchedBytes(undefined)).toEqual({});
    expect(
      fetchedBytes({
        getEntriesByType: () => {
          throw new Error("no");
        },
      }),
    ).toEqual({});
  });
});
