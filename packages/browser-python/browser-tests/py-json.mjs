/**
 * JSON from Python to the test, across a boundary that cannot be misread.
 *
 * `value()` in the suites returns Python's `repr()` of the result. For a `str` holding JSON that
 * is the JSON wrapped in quotes - with PYTHON's escaping, not JSON's: a single quote inside becomes
 * `\'`, which `JSON.parse` rejects ("Bad escaped character"), and a repr may switch to double quotes
 * when the text contains a single quote. Slicing the quotes off and parsing therefore works until
 * an error message contains an apostrophe. So the JSON is base64-encoded in Python: base64's
 * alphabet has nothing either language escapes, its repr is exactly `'<base64>'`, and anything
 * else is refused rather than guessed at.
 */

/** A Python EXPRESSION giving base64 of the UTF-8 JSON of `expression`. Imports nothing globally. */
export function pythonJsonExpression(expression) {
  return (
    `__import__("base64").b64encode(__import__("json").dumps(${expression}).encode("utf-8"))` +
    `.decode("ascii")`
  );
}

/** Decode what `value(pythonJsonExpression(...))` returned: the repr of a base64 string. */
export function jsonFromPythonRepr(repr) {
  const match = /^'([A-Za-z0-9+/]*={0,2})'$/.exec(String(repr));
  if (!match) {
    throw new Error(
      `expected the repr of a base64 string from pythonJsonExpression(), got ` +
        JSON.stringify(String(repr).slice(0, 120)),
    );
  }
  return JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
}
