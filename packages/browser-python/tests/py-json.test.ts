/**
 * JSON handed from Python to a browser suite must survive quotes, backslashes and newlines.
 *
 * The suites used to take Python's `repr()` of a JSON string, cut the outer quotes off and parse the
 * rest. Python escapes a single quote inside a repr as `\'`, which JSON does not allow, so the first
 * error message with an apostrophe in it failed the WHOLE suite in Firefox with "Bad escaped
 * character in JSON" before a single check ran. The boundary is now base64 of UTF-8 JSON.
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { jsonFromPythonRepr, pythonJsonExpression } from "../browser-tests/py-json.mjs";

/** Values that break naive repr slicing, and a few that break naive base64 handling. */
const HOSTILE = {
  apostrophe: "the server said 'no'",
  doubleQuote: 'a "quoted" word',
  both: `it's "both"`,
  backslash: "C:\\path\\to\\file and \\n literally",
  newline: "line one\nline two\r\nline three",
  tab: "a\tb",
  unicode: "Zarr ✓ – naïve – 😀",
  nested: { list: [1, "two", null, true], empty: "" },
};

/** What Python's repr of a base64 str looks like: the characters, in single quotes. */
const reprOfBase64 = (value: unknown) =>
  `'${Buffer.from(JSON.stringify(value), "utf8").toString("base64")}'`;

function python(code: string): string | null {
  try {
    return execFileSync("python3", ["-c", code], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}
const hasPython = python("print(1)") === "1";

describe("JSON from Python crosses as base64, never as a sliced repr", () => {
  it("round-trips quotes, backslashes, newlines and non-ASCII exactly", () => {
    expect(jsonFromPythonRepr(reprOfBase64(HOSTILE))).toEqual(HOSTILE);
  });

  it("the old slicing really does fail on the same value - the reason for the change", () => {
    // What Python prints for repr(json.dumps({"a": "it's"})): single quotes, with \' inside.
    const pythonRepr = `'{"a": "it\\'s"}'`;
    expect(() => JSON.parse(pythonRepr.slice(1, -1))).toThrow(/escape|JSON/i);
  });

  it("refuses anything that is not the repr of a base64 string, rather than guessing", () => {
    expect(() => jsonFromPythonRepr(`'{"a": 1}'`)).toThrow(/repr of a base64 string/);
    expect(() => jsonFromPythonRepr(`"abc="`)).toThrow(/repr of a base64 string/);
    expect(() => jsonFromPythonRepr("None")).toThrow(/repr of a base64 string/);
  });

  it("builds a Python expression that imports what it needs and nothing globally", () => {
    const expression = pythonJsonExpression("out");
    expect(expression).toContain('__import__("base64")');
    expect(expression).toContain('__import__("json").dumps(out)');
    expect(expression).not.toMatch(/^import /m);
  });

  it.runIf(hasPython)("…and the real CPython repr of that expression decodes exactly", () => {
    const source = JSON.stringify(JSON.stringify(HOSTILE));
    const repr = python(
      `import json\nout = json.loads(${source})\nprint(repr(${pythonJsonExpression("out")}))`,
    );
    expect(repr).not.toBeNull();
    expect(jsonFromPythonRepr(repr ?? "")).toEqual(HOSTILE);
  });
});
