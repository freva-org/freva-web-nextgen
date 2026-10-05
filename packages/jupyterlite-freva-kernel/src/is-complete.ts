// Whether a console's input is a whole Python statement yet - the answer CPython's
// `codeop.compile_command` gives, read on the page: the console asks on every Enter and runs the
// input if no answer comes within a quarter of a second, so it cannot wait for a Python that is
// still starting or busy with a cell.
//
// As `codeop`: "incomplete" while a bracket, a triple-quoted string or a backslash continuation
// is open; while the last statement opens a block (`if x:`, `else:`); while a compound statement
// - a block, a decorated definition, a one-line `def f(): ...` - has not been ended by a newline;
// and while a `try` has no `except` or `finally` yet, or decorators have no definition.
// "invalid" for what no more input can fix (an unexpected indent, a missing one, a dedent to no
// enclosing level, an `else` without its statement, an unterminated one-line string). Two
// deliberate differences, both IPython's: several statements are complete (they run as a cell
// does, where `codeop`'s single-statement mode refuses them), and a last line of only spaces -
// what the console's automatic indent leaves when Enter is pressed on an empty line - ends a
// block like an empty one.

export type IsComplete =
  | { status: "complete" }
  | { status: "incomplete"; indent: string }
  | { status: "invalid" };

interface Logical {
  /** The statement's skeleton: its physical lines joined, strings emptied, comments dropped. */
  text: string;
  /** Its first line's indentation. */
  indent: string;
  /** Opens a block: its last token at bracket depth 0 is `:`. */
  opens: boolean;
  /** A compound statement written on one line (`def f(): return 1`, `if x: pass`). */
  oneLine: boolean;
  /** Its first word. */
  keyword: string;
}

const COMPOUND = new Set([
  "if",
  "elif",
  "else",
  "for",
  "while",
  "try",
  "except",
  "finally",
  "with",
  "def",
  "class",
  "async",
  "match",
  "case",
]);
/** Clauses that continue the statement before them at the same indent. */
const CLAUSES = new Set(["elif", "else", "except", "finally"]);

const indentOf = (line: string) => /^[ \t]*/.exec(line)![0];
const width = (indent: string) => indent.replace(/\t/g, "        ").length;

/** Whether the string whose quote is at `at` has an `f` among its prefix letters. */
function isFString(code: string, at: number): boolean {
  const prefix = /[A-Za-z]{1,2}$/.exec(code.slice(Math.max(0, at - 2), at))?.[0] ?? "";
  const before = code[at - prefix.length - 1] ?? "";
  return /^[rRbBuUfF]*$/.test(prefix) && /[fF]/.test(prefix) && !/[\w]/.test(before);
}

type Scan = number | "open" | "bad";

/**
 * A string from just after its opening `quote`: the index after its closing quote, "open" when
 * the input ends inside one that may go on (a triple-quoted string, or an f-string's replacement
 * field), or "bad" when no more input can close it (a one-line string at a newline or the end).
 * An f-string's fields are read as Python 3.12 does (PEP 701): an expression may span lines, hold
 * strings of any quote and comments; its format spec may not span lines.
 */
function scanString(code: string, start: number, quote: string, f: boolean): Scan {
  const triple = quote.length === 3;
  for (let j = start; j < code.length; ) {
    const c = code[j]!;
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (code.startsWith(quote, j)) return j + quote.length;
    if (c === "\n" && !triple) return "bad";
    if (f && (c === "{" || c === "}")) {
      if (code[j + 1] === c) {
        j += 2;
        continue;
      }
      if (c === "}") return "bad";
      const end = scanField(code, j + 1, quote);
      if (end !== "open" && end !== "bad") {
        j = end;
        continue;
      }
      return end;
    }
    j += 1;
  }
  return triple ? "open" : "bad";
}

/** An f-string's replacement field, from just after its `{`: the index after its `}`. */
function scanField(code: string, start: number, quote: string): Scan {
  const triple = quote.length === 3;
  let depth = 0;
  let spec = false;
  for (let k = start; k < code.length; ) {
    const c = code[k]!;
    if (!spec) {
      // A comment runs to the end of its line: its quotes and braces count for nothing, and
      // the field closes on a later line (PEP 701).
      if (c === "#") {
        while (k < code.length && code[k] !== "\n") k += 1;
        continue;
      }
      if (c === '"' || c === "'") {
        const inner = code.startsWith(c.repeat(3), k) ? c.repeat(3) : c;
        const end = scanString(code, k + inner.length, inner, isFString(code, k));
        if (end === "open" || end === "bad") return end;
        k = end;
        continue;
      }
      if ("([{".includes(c)) depth += 1;
      else if (")]".includes(c)) depth = Math.max(0, depth - 1);
      else if (c === "}") {
        if (depth === 0) return k + 1;
        depth -= 1;
      } else if (depth === 0 && c === "!" && code[k + 1] !== "=") spec = true;
      else if (depth === 0 && c === ":") spec = true;
      k += 1;
      continue;
    }
    // The conversion and format spec: nested fields, and no line break in a one-line string.
    if (c === "{") {
      const end = scanField(code, k + 1, quote);
      if (end === "open" || end === "bad") return end;
      k = end;
      continue;
    }
    if (c === "}") return k + 1;
    if (c === "\n" && !triple) return "bad";
    if (code.startsWith(quote, k)) return "bad";
    k += 1;
  }
  return "open";
}

/**
 * The input's logical lines, or what is still open at its end: a bracket, a triple-quoted string
 * or a continuation (incomplete), or a one-line string (invalid). Each line is read as a skeleton
 * - strings emptied, comments dropped - so a colon in a string or a comment counts for nothing.
 */
function logicalLines(
  code: string,
): { lines: Logical[] } | { open: "bracket" | "string" | "continuation" } | { bad: true } {
  const lines: Logical[] = [];
  let depth = 0;
  let skeleton = "";
  let indent: string | null = null;
  /** Where the first colon at bracket depth 0 is in `skeleton`, or -1. */
  let colon = -1;
  const end = () => {
    const text = skeleton.trim();
    if (text) {
      const keyword = /^(@|[A-Za-z_]\w*)/.exec(text)?.[1] ?? "";
      const compound = COMPOUND.has(keyword) && colon >= 0;
      const rest = compound ? skeleton.slice(colon + 1).trim() : "";
      lines.push({
        text,
        indent: indent ?? "",
        opens: compound && rest === "",
        oneLine: compound && rest !== "",
        keyword,
      });
    }
    skeleton = "";
    indent = null;
    colon = -1;
  };
  for (let i = 0; i < code.length; i += 1) {
    const c = code[i]!;
    if (indent === null) {
      if (c === "\n") continue;
      indent = indentOf(code.slice(i));
    }
    if (c === "#") {
      while (i + 1 < code.length && code[i + 1] !== "\n") i += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = code.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
      const end = scanString(code, i + quote.length, quote, isFString(code, i));
      if (end === "open") return { open: "string" };
      if (end === "bad") return { bad: true };
      skeleton += '""';
      i = end - 1;
      continue;
    }
    if (c === "\\") {
      if (i === code.length - 1) return { open: "continuation" };
      if (code[i + 1] === "\n") {
        skeleton += " ";
        i += 1;
        continue;
      }
    }
    if (c === "\n") {
      if (depth > 0) skeleton += " ";
      else end();
      continue;
    }
    if ("([{".includes(c)) depth += 1;
    else if (")]}".includes(c)) depth = Math.max(0, depth - 1);
    else if (c === ":" && depth === 0 && colon < 0 && code[i + 1] !== "=") colon = skeleton.length;
    skeleton += c;
  }
  if (depth > 0) return { open: "bracket" };
  end();
  return { lines };
}

export function isComplete(code: string): IsComplete {
  // A last line of only spaces ends the input like an empty one (see above).
  const normalized = code.replace(/\n[ \t]+$/, "\n");
  if (!normalized.trim()) return { status: "complete" };
  const read = logicalLines(normalized);
  const lastLine = normalized.slice(normalized.lastIndexOf("\n") + 1);
  if ("bad" in read) return { status: "invalid" };
  if ("open" in read) {
    return { status: "incomplete", indent: read.open === "continuation" ? indentOf(lastLine) : "" };
  }
  const lines = read.lines;
  if (lines.length === 0) return { status: "complete" };

  // What no more input can fix: indentation that does not match, a clause with no statement.
  if (width(lines[0]!.indent) > 0) return { status: "invalid" };
  if (CLAUSES.has(lines[0]!.keyword)) return { status: "invalid" };
  // Each line's indent is its block's (one deeper after an opener) or an enclosing one's.
  const levels = [0];
  for (let i = 1; i < lines.length; i += 1) {
    const before = lines[i - 1]!;
    const line = lines[i]!;
    const at = width(line.indent);
    if (before.opens) {
      if (at <= levels[levels.length - 1]!) return { status: "invalid" };
      levels.push(at);
    } else {
      if (at > levels[levels.length - 1]!) return { status: "invalid" };
      while (at < levels[levels.length - 1]!) levels.pop();
      if (at !== levels[levels.length - 1]) return { status: "invalid" };
    }
    if (before.keyword === "@" && !["def", "class", "async", "@"].includes(line.keyword)) {
      return { status: "invalid" };
    }
  }

  const last = lines[lines.length - 1]!;
  // A block opened and not yet written.
  if (last.opens) return { status: "incomplete", indent: `${last.indent}    ` };
  // Decorators still waiting for their definition.
  if (last.keyword === "@") return { status: "incomplete", indent: last.indent };
  // A `try` with no `except` or `finally` yet (at its own indent, before anything else there).
  for (let i = 0; i < lines.length; i += 1) {
    // `try:` and the one-line `try: risky()` both still need a handler.
    if (lines[i]!.keyword !== "try" || !(lines[i]!.opens || lines[i]!.oneLine)) continue;
    const at = width(lines[i]!.indent);
    const next = lines.slice(i + 1).find((line) => width(line.indent) <= at);
    if (!next) return { status: "incomplete", indent: lines[i]!.indent };
    if (width(next.indent) === at && !["except", "finally"].includes(next.keyword)) {
      return { status: "invalid" };
    }
  }
  // A compound statement still being written - its last line inside the block, or itself a
  // one-line compound - ends with a newline. A statement back at the left margin after it
  // closed it already; simple statements are whole as they are.
  const open = width(last.indent) > 0 || last.oneLine;
  if (open && !normalized.endsWith("\n")) {
    return { status: "incomplete", indent: indentOf(lastLine) };
  }
  return { status: "complete" };
}
