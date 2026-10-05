// Canonical text for the portal-style-v1 checks. Every check runs on what a browser would read,
// not on what was written: `\75 rl(` is `url(`, and `u/**/rl(` is not a function at all but must
// not be allowed to become one after a comment is dropped. So comments go first, then escapes are
// decoded, and only then is anything compared.

/** Remove `/* … *\/` comments outside quoted strings. An unterminated comment runs to the end. */
export function stripComments(text: string): string {
  let out = "";
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      out += c;
      if (c === "\\" && i + 1 < text.length) {
        out += text[++i];
      } else if (c === quote) {
        quote = undefined;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += c;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * Decode CSS escapes (`\HHHHHH ` and `\c`). Code point 0, surrogates and values above U+10FFFF
 * become U+FFFD, as the CSS Syntax specification says. A trailing lone backslash is kept.
 */
export function cssUnescape(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c !== "\\" || i + 1 >= text.length) {
      out += c;
      continue;
    }
    const next = text[i + 1]!;
    if (next === "\n") {
      i += 1;
      continue;
    }
    const hex = /^[0-9a-fA-F]{1,6}/.exec(text.slice(i + 1));
    if (hex) {
      const code = Number.parseInt(hex[0], 16);
      out +=
        code === 0 || (code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff
          ? "�"
          : String.fromCodePoint(code);
      i += hex[0].length;
      // One whitespace character after a hex escape belongs to the escape.
      if (/[ \t\n\r\f]/.test(text[i + 1] ?? "")) i += 1;
      continue;
    }
    out += next;
    i += 1;
  }
  return out;
}

/**
 * Comments removed and escapes decoded everywhere except inside quoted strings, whose escapes are
 * kept so the string still delimits what it delimited. What the checks see as identifiers,
 * function names and keywords is then exactly what the browser tokenizes.
 */
export function canonicalValue(text: string): string {
  const stripped = stripComments(text);
  let out = "";
  let i = 0;
  while (i < stripped.length) {
    const c = stripped[i]!;
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < stripped.length && stripped[j] !== c) j += stripped[j] === "\\" ? 2 : 1;
      out += stripped.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < stripped.length && stripped[j] !== '"' && stripped[j] !== "'") {
      if (stripped[j] === "\\") j += 1;
      j += 1;
    }
    out += cssUnescape(stripped.slice(i, j));
    i = j;
  }
  return out;
}
