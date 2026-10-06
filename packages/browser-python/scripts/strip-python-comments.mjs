// Remove `#` comments from Python source, keeping every line (so traceback line numbers still
// match `src/python/*.py`) and every string literal byte for byte. Docstrings are kept: they are
// strings, and code may read them.
//
// A small tokenizer rather than a regex: a `#` inside a string is not a comment, and a line that
// starts with `#` inside a triple-quoted string is string content. Backslash escapes the next
// character in every string kind, which is also how Python's tokenizer finds the end of a raw
// string. Same-quote nesting inside an f-string replacement field (PEP 701) is refused rather
// than guessed at.

/** @param {string} source */
export function stripPythonComments(source) {
  const out = [];
  let i = 0;
  const n = source.length;
  /** Start of the current output line in `out`, for trimming the whitespace a comment leaves. */
  let lineStart = 0;
  const trimLine = () => {
    let end = out.length;
    while (end > lineStart && (out[end - 1] === " " || out[end - 1] === "\t")) end -= 1;
    out.length = end;
  };
  while (i < n) {
    const c = source[i];
    if (c === "#") {
      while (i < n && source[i] !== "\n") i += 1;
      trimLine();
      continue;
    }
    if (c === "\n") {
      out.push(c);
      i += 1;
      lineStart = out.length;
      continue;
    }
    if (c === '"' || c === "'") {
      const triple = source.startsWith(c.repeat(3), i);
      const quote = triple ? c.repeat(3) : c;
      // An f-string prefix right before the quote: refuse same-quote nesting rather than mis-scan.
      let p = i - 1;
      let prefix = "";
      while (p >= 0 && /[A-Za-z]/.test(source[p])) prefix = source[p--] + prefix;
      const fstring = /^[rRbBuU]?[fFtT][rR]?$|^[rR][fFtT]$/.test(prefix);
      let j = i + quote.length;
      let depth = 0;
      while (j < n) {
        const d = source[j];
        if (d === "\\") {
          j += 2;
          continue;
        }
        if (fstring && d === "{") {
          if (source[j + 1] === "{") j += 1;
          else depth += 1;
        } else if (fstring && d === "}" && depth > 0) {
          depth -= 1;
        }
        if (source.startsWith(quote, j)) {
          if (depth > 0) {
            throw new Error(
              `strip-python-comments: same-quote nesting inside an f-string at offset ${j} is ` +
                "not supported; use the other quote character inside the replacement field.",
            );
          }
          j += quote.length;
          break;
        }
        if (!triple && d === "\n") {
          throw new Error(`strip-python-comments: unterminated string at offset ${i}`);
        }
        j += 1;
      }
      if (j > n) throw new Error(`strip-python-comments: unterminated string at offset ${i}`);
      const literal = source.slice(i, j);
      for (const ch of literal) {
        out.push(ch);
        if (ch === "\n") lineStart = out.length;
      }
      i = j;
      continue;
    }
    out.push(c);
    i += 1;
  }
  return out.join("");
}
