// python.ts - which access examples may offer "Try in Python", and nothing else. No Python here,
// no runtime, no knowledge of how an example runs: this answers one question - is THIS example a
// registered, self-contained, fully resolved Python program? - as pure functions a test can read
// and a reviewer can argue with. Every rule fails closed: a missing button is a mild
// disappointment, a button that runs a half-written snippet against somebody's credentials is not.

import type { DatasetAccessExample, DatasetTreePython } from "./types.js";

/**
 * Language tags this component treats as Python: a closed set, not a substring test.
 * `"pythonic-yaml"` is not Python, nor is a language a consumer invented that starts the same way.
 */
const PYTHON_LANGUAGES: ReadonlySet<string> = new Set(["python", "python3", "py"]);

/**
 * A registered digest: lowercase hex SHA-256, as the build manifest writes it. Checking the shape
 * is not verification - only whoever holds the source can verify - but an execution layer given a
 * well-formed digest can look it up and fail cleanly, where one given `"true"` cannot.
 */
const DIGEST = /^[0-9a-f]{64}$/;

/**
 * Placeholder syntaxes: three narrow patterns, not one clever one. Each has to be a form that is
 * unambiguous in Python, because a false positive removes a button that should have been there and
 * a false negative runs a snippet with `<YOUR_TOKEN>` still in it.
 */
const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  // `{{ dataset.path }}` - a templating engine that did not run. Python has no `{{` operator.
  /\{\{[^{}]*\}\}/,
  // `${BUCKET}` - shell or JS interpolation. Python's f-strings use `{}`, never `${}`.
  /\$\{[^{}]*\}/,
];

/**
 * `<something>` - the angle-bracket placeholder, and the two rules that tell it from an operator.
 * `<` and `>` are comparison operators, so a bare pair is no evidence: `a<b>c` is a legal chained
 * comparison. Shouting - uppercase, hyphen or slash - is the wrong test, since
 * `xr.open_zarr("https://host/<dataset>.zarr")` shouts nowhere inside its brackets yet is a
 * placeholder. Position separates them: a placeholder always sits inside a string, since elsewhere
 * it is a syntax error Python refuses on its own, and a comparison never does. So inside a string
 * literal any bracketed run counts, outside one only a shouting run, keeping comparisons eligible.
 */
const ANGLE = /<([A-Za-z0-9_./-]+)>/g;

/**
 * The ranges of `code` that are inside a string literal. A small scanner, not a parser: the cases
 * needing one - an f-string whose `{}` expression holds a comparison - are ones where flagging is
 * safe anyway. Prefixes (`r`, `b`, `f`, `rb`, ...) go undetected because a string starts at its
 * quote whatever precedes it, and a backslash stops the next character closing the string in raw
 * strings too, all this needs escapes for. An unterminated literal runs to the end of its line or
 * source - a syntax error, so what follows counts as string content and the snippet fails closed.
 */
function stringRanges(code: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let i = 0;
  while (i < code.length) {
    const ch = code[i] as string;
    // A comment runs to the end of the line and contains no string.
    if (ch === "#") {
      const nl = code.indexOf("\n", i);
      i = nl === -1 ? code.length : nl + 1;
      continue;
    }
    if (ch !== "'" && ch !== '"') {
      i += 1;
      continue;
    }
    const triple = code.startsWith(ch.repeat(3), i);
    const delimiter = triple ? ch.repeat(3) : ch;
    let j = i + delimiter.length;
    const start = j;
    while (j < code.length) {
      if (code[j] === "\\") {
        j += 2;
        continue;
      }
      if (code.startsWith(delimiter, j)) break;
      // A single-quoted string cannot span a newline; an unterminated one ends there.
      if (!triple && code[j] === "\n") break;
      j += 1;
    }
    ranges.push([start, Math.min(j, code.length)]);
    i = code.startsWith(delimiter, j) ? j + delimiter.length : j + 1;
  }
  return ranges;
}

/** Whether `index` falls inside one of `ranges`. */
function within(ranges: ReadonlyArray<readonly [number, number]>, index: number): boolean {
  return ranges.some(([from, to]) => index >= from && index < to);
}

/** Whether a language tag names Python. Case and surrounding space are ignored. */
export function isPythonLanguage(language: string | undefined): boolean {
  if (typeof language !== "string") return false;
  return PYTHON_LANGUAGES.has(language.trim().toLowerCase());
}

/**
 * Whether the snippet still contains something a human was meant to fill in. Called on code about
 * to be offered to run, never on code about to be drawn: a template is fine to show and to copy,
 * and the copy button stays exactly where it was for one.
 */
export function hasUnresolvedPlaceholder(code: string): boolean {
  if (typeof code !== "string") return true;
  for (const pattern of PLACEHOLDER_PATTERNS) if (pattern.test(code)) return true;
  const strings = stringRanges(code);
  ANGLE.lastIndex = 0;
  for (let match = ANGLE.exec(code); match; match = ANGLE.exec(code)) {
    const inner = match[1] as string;
    const inString = within(strings, match.index);
    const shouts = inner.length >= 2 && (/[A-Z]/.test(inner) || /[-/]/.test(inner));
    if (inString || shouts) {
      ANGLE.lastIndex = 0;
      return true;
    }
  }
  return false;
}

/**
 * The example's registered identity, or `null` when it has none - checkable without importing a
 * manifest, since an example that was never registered has no digest to carry: nothing to send,
 * and nothing that could be resolved at the far end.
 */
export function registeredDigest(example: DatasetAccessExample): string | null {
  const digest = example.digest;
  if (typeof digest !== "string") return null;
  const trimmed = digest.trim().toLowerCase();
  return DIGEST.test(trimmed) ? trimmed : null;
}

/** Whether the integration is switched on at all. Absent options mean absent feature. */
export function pythonEnabled(python: DatasetTreePython | undefined): boolean {
  if (!python || typeof python.onTry !== "function") return false;
  return python.enabled !== false;
}

/**
 * The whole eligibility rule, in the order the disqualifiers were written down: the integration is
 * on, the language is Python, the consumer marked the example executable, nothing is left to fill
 * in, and the example has a registered identity.
 */
export function tryPythonEligible(
  example: DatasetAccessExample | undefined,
  python: DatasetTreePython | undefined,
): boolean {
  if (!example) return false;
  if (!pythonEnabled(python)) return false;
  if (!isPythonLanguage(example.language)) return false;
  if (example.executable !== true) return false;
  if (typeof example.id !== "string" || example.id.length === 0) return false;
  if (hasUnresolvedPlaceholder(example.code)) return false;
  return registeredDigest(example) !== null;
}
