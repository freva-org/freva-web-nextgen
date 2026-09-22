/**
 * ONE cursor convention across the whole autocomplete path: UTF-16 code units.
 *
 * Three units are in play, so every boundary has to be deliberate: the DOM gives UTF-16 code
 * units (`source.length`, `String.slice()`, `selectionStart`); Python counts CHARACTERS, so
 * `len("😀")` is 1 where `"😀".length` is 2; and a caret converted to characters before
 * `complete()` and then fed to JavaScript's `slice()` in the Worker is measured in one unit and
 * applied in the other. Five emoji left of the caret put those five units apart, so the Worker
 * completes a prefix the user had not finished typing and rlcompleter, handed an empty token,
 * answers with every global it can see. Python's character offset is converted exactly once.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Repl } from "../src/worker/repl.js";
import type { OutputBridge } from "../src/worker/output.js";
import type { PyodideApi } from "../src/worker/pyodide-runtime.js";

/** The exact case from the brief: five astral characters, then a real token at the caret. */
const EMOJI_SOURCE = '"\u{1F600}\u{1F600}\u{1F600}\u{1F600}\u{1F600}"; print';

/** A Python sequence proxy, in the two respects `Repl` uses. */
function sequence(values: unknown[]) {
  return {
    length: values.length,
    get: (i: number) => values[i],
    destroy: () => undefined,
  };
}

/**
 * A `_freva_bridge` stand-in that records the head it was asked to complete. Deliberately NOT a
 * mock of the engine: the mocked-engine test in the console suite never runs the Worker's own
 * `slice()`, which is where the units stop agreeing. Everything between this bridge and the
 * caller is real.
 */
function fakeBridge(reply: { matches: string[]; start: number }) {
  const heads: string[] = [];
  const bridge = {
    make_console: () => true,
    set_jspi: (available: boolean) => available,
    console_push: () => undefined,
    run_future: async () => undefined,
    run_source: () => undefined,
    clear_buffer: () => true,
    complete: (head: string) => {
      heads.push(head);
      return sequence([sequence(reply.matches), reply.start]);
    },
    capture_display: () => undefined,
    install_browser_http: () => "",
    versions: () => undefined,
    python_version: () => "3.14.0",
    destroy: () => undefined,
  };
  return { bridge, heads };
}

function replWith(reply: { matches: string[]; start: number }) {
  const { bridge, heads } = fakeBridge(reply);
  const pyodide = {
    runPython: () => undefined,
    globals: { get: () => bridge },
  } as unknown as PyodideApi;
  const output = {
    stdout: () => undefined,
    stderr: () => undefined,
  } as unknown as OutputBridge;
  const repl = new Repl(pyodide, output);
  return { repl, heads };
}

describe("the Worker slices with the caller's UTF-16 cursor", () => {
  it("completes the token at the caret with five astral characters to its left", async () => {
    expect(EMOJI_SOURCE.length, "UTF-16 code units").toBe(19);
    expect([...EMOJI_SOURCE].length, "Python characters").toBe(14);

    const { repl, heads } = replWith({ matches: ["print("], start: 13 });
    await repl.start();
    repl.complete(EMOJI_SOURCE, EMOJI_SOURCE.length);

    // The head Python is asked about must be the WHOLE line, `print` included. Slicing at the
    // character count instead cuts it to `"😀😀😀😀😀"; ` - an empty token, which comes back with
    // every global in the namespace.
    expect(heads).toEqual([EMOJI_SOURCE]);
    expect(heads[0]!.endsWith("print"), "the token at the caret must survive the slice").toBe(true);
  });

  it("converts Python's character `start` to UTF-16 exactly once, at the boundary", async () => {
    // Python counts the token `print` as starting at character 9: quote, 5 emoji, quote, `;`,
    // space. In UTF-16 that same position is index 14, because each emoji is two units wide.
    const { repl } = replWith({ matches: ["print("], start: 9 });
    await repl.start();
    const result = repl.complete(EMOJI_SOURCE, EMOJI_SOURCE.length);

    expect(result.start, "UTF-16 code units, matching source.length and String.slice()").toBe(14);
    expect(EMOJI_SOURCE.slice(result.start)).toBe("print");
    expect(result.matches).toEqual(["print("]);
  });

  it("applies the completion without splitting a surrogate pair", async () => {
    const { repl } = replWith({ matches: ["print("], start: 9 });
    await repl.start();
    const result = repl.complete(EMOJI_SOURCE, EMOJI_SOURCE.length);

    const applied =
      EMOJI_SOURCE.slice(0, result.start) + "print(" + EMOJI_SOURCE.slice(EMOJI_SOURCE.length);
    expect(applied).toBe('"\u{1F600}\u{1F600}\u{1F600}\u{1F600}\u{1F600}"; print(');
    // A split pair shows up as a lone surrogate, which round-trips through the code-point
    // iterator as U+FFFD-adjacent garbage rather than the character that was typed.
    expect(
      [...applied].filter((c) => c.codePointAt(0)! >= 0xd800 && c.codePointAt(0)! <= 0xdfff),
    ).toEqual([]);
    expect([...applied].filter((c) => c === "\u{1F600}")).toHaveLength(5);
  });

  it("slices at a cursor in the MIDDLE of the text, in UTF-16 units", async () => {
    const source = "\u{1F600}\u{1F600} ds.ise + trailing";
    const cursor = source.indexOf(" + trailing");
    const { repl, heads } = replWith({ matches: ["ds.isel"], start: 3 });
    await repl.start();
    const result = repl.complete(source, cursor);

    expect(heads).toEqual(["\u{1F600}\u{1F600} ds.ise"]);
    // Python character 3 - emoji, emoji, space - is UTF-16 index 5.
    expect(result.start).toBe(5);
    expect(source.slice(result.start, cursor)).toBe("ds.ise");
  });

  it("is unchanged for BMP-only text, where the two units agree", async () => {
    const source = "ds.ise";
    const { repl, heads } = replWith({ matches: ["ds.isel"], start: 0 });
    await repl.start();
    const result = repl.complete(source, source.length);

    expect(heads).toEqual(["ds.ise"]);
    expect(result.start).toBe(0);
  });

  it("defaults an omitted cursor to the end of the source, in UTF-16 units", async () => {
    const { repl, heads } = replWith({ matches: ["print("], start: 9 });
    await repl.start();
    // `complete()`'s public default is `source.length`, which is a UTF-16 count.
    repl.complete(EMOJI_SOURCE, EMOJI_SOURCE.length);
    expect(heads).toEqual([EMOJI_SOURCE]);
  });
});

// EVERY HELPER THIS PACKAGE WRITES INTO THE INTERPRETER IS HIDDEN FROM COMPLETION.
//
// The set in `repl.ts` is hand-written, and `browser_s3.py` was added to `src/python/` without
// being added to it - so `import browser_<Tab>` offered a module that is this package's plumbing.
// Derived from the directory here rather than repeated, so the next helper cannot be forgotten in
// the same way: the list of files IS the list of private modules.
describe("the module list completion hides", () => {
  it("covers every helper in src/python", () => {
    const pyDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "python");
    const helpers = readdirSync(pyDir)
      .filter((file) => file.endsWith(".py"))
      .map((file) => file.replace(/\.py$/, ""))
      .sort();
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "src", "worker", "repl.ts"),
      "utf8",
    );
    const block = source.slice(
      source.indexOf("#PRIVATE_MODULES"),
      source.indexOf("]", source.indexOf("#PRIVATE_MODULES")),
    );
    const hidden = [...block.matchAll(/"([a-z_][a-z0-9_]*)"/g)].map((m) => m[1]).sort();
    expect(hidden).toEqual(helpers);
  });
});
