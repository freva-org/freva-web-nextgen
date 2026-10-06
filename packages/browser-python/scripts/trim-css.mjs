/**
 * Strip comments and collapse whitespace, WITHOUT touching anything inside a string or a url().
 * This output is embedded in the console bundle as a JavaScript string, so every byte of
 * `styles.css` is downloaded by every visitor, comments included: 35,785 bytes of authored CSS, a
 * little over a third of it prose. The prose stays in `src/console/styles.css`; what ships is the
 * rules.
 *
 * DELIBERATELY CONSERVATIVE: it removes comments and runs of whitespace and does NOT rewrite
 * selectors, merge rules, shorten colours or drop the last semicolon in a block.
 */
export function trimCss(text) {
  let out = "";
  let quote = "";
  let inUrl = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      out += ch;
      if (ch === "\\") {
        out += text[i + 1] ?? "";
        i += 1;
      } else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    if (!inUrl && ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
      // A comment between two tokens becomes one space, so `a/*x*/b` cannot become `ab`.
      if (!/\s$/.test(out)) out += " ";
      continue;
    }
    if (/\s/.test(ch)) {
      if (!/\s$/.test(out)) out += " ";
      continue;
    }
    out += ch;
    if (!inUrl && /url\($/i.test(out)) inUrl = true;
    else if (inUrl && ch === ")") inUrl = false;
  }
  // Space is only meaningful between tokens, never beside these. NOTE WHAT IS NOT DONE: the space
  // BEFORE a colon is kept, because `.bp-terminal ::selection` is a descendant combinator followed
  // by a pseudo-element while `.bp-terminal::selection` is one on the terminal itself - and this
  // sheet contains exactly that selector, carrying the rule that keeps selected text from being
  // painted in transparent ink.
  return out
    .replace(/\s*([{};,])\s*/g, "$1")
    .replace(/;\}/g, "}")
    .replace(/:\s+/g, ":")
    .trim();
}
