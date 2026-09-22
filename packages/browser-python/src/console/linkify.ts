/**
 * Turn the URLs in a line of console output into anchors, and nothing else into anything.
 *
 * A device-flow login prints a URL and waits for it to be opened; a dataset's error names the
 * catalogue page that explains it; `help()` cites the docs. Without this they are text a visitor
 * has to select by hand, character-exact, inside a transcript that scrolls.
 *
 * BUILT AS DOM, because the output is a visitor's own program's bytes - a `print()` away from
 * `<img onerror=...>` and one `innerHTML` from being run. The text is sliced, the pieces become
 * text nodes, and the matches become `<a>` elements whose `href` is set as a property after the
 * scheme has been checked: there is no path from output to markup, which is stronger than "it is
 * escaped". WHAT COUNTS AS A URL is deliberately narrow: `http://` or `https://`, spelled out.
 * Not `www.`, not a bare domain, not `file:`, and above all not `javascript:`.
 */

/**
 * Explicit-scheme URLs, stopping at whitespace and at the characters no URL ends a sentence with.
 * `<` and `>` are excluded so an angle-bracketed URL - how RFC 3986 suggests writing one in prose,
 * and how several Python libraries print them - keeps its brackets outside the link.
 */
const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/gi;

/**
 * Trailing characters that belong to the SENTENCE rather than to the URL.
 * `Open https://example.org/verify.` ends in a full stop, not a path, and a link that swallows it
 * sends the visitor to a 404 - worse than not linking at all, because it looks like it worked.
 * Closing brackets are trimmed only when the URL does not open them itself, so `…/Foo_(bar)`
 * survives while `(see https://example.org/x)` does not take the parenthesis.
 */
function trimTrailing(url: string): string {
  let end = url.length;
  while (end > 0) {
    const character = url[end - 1] ?? "";
    if (".,;:!?".includes(character)) {
      end -= 1;
      continue;
    }
    const opener = { ")": "(", "]": "[", "}": "{" }[character];
    if (opener !== undefined) {
      const candidate = url.slice(0, end);
      const opens = candidate.split(opener).length - 1;
      const closes = candidate.split(character).length - 1;
      if (closes > opens) {
        end -= 1;
        continue;
      }
    }
    break;
  }
  return url.slice(0, end);
}

/** Only the two schemes the matcher can produce, re-checked against the parser's own opinion. */
function isOpenable(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * The pieces of `text`, in order: strings for the prose, `{ url }` for each link. Separated from
 * the DOM building so the matching can be tested without a document, and so a surface that is not
 * this one can render the same decision its own way.
 */
export function splitLinks(text: string): Array<string | { url: string }> {
  const pieces: Array<string | { url: string }> = [];
  let index = 0;
  URL_PATTERN.lastIndex = 0;
  for (let match = URL_PATTERN.exec(text); match; match = URL_PATTERN.exec(text)) {
    const raw = match[0];
    const url = trimTrailing(raw);
    // A match that trims away to nothing, or that the URL parser will not have, is prose.
    if (!url || !isOpenable(url)) continue;
    if (match.index > index) pieces.push(text.slice(index, match.index));
    pieces.push({ url });
    index = match.index + url.length;
    // Rewound, because the trimmed tail is still text and may itself contain the next match.
    URL_PATTERN.lastIndex = index;
  }
  if (index < text.length) pieces.push(text.slice(index));
  return pieces;
}

/** Whether linking would change anything, so a caller can keep its single text node when it would not. */
export function hasLink(text: string): boolean {
  return splitLinks(text).some((piece) => typeof piece !== "string");
}

/**
 * `text`, as nodes, with its URLs as anchors. `rel` carries all three of `noopener`, `noreferrer`
 * and `nofollow`: the first two because the opened page must not get a handle on the console's
 * window or its address, the third because the link is a visitor's own output and a portal should
 * not be voting for it.
 */
export function linkifyInto(parent: Node, text: string, doc: Document): void {
  for (const piece of splitLinks(text)) {
    if (typeof piece === "string") {
      parent.appendChild(doc.createTextNode(piece));
      continue;
    }
    const anchor = doc.createElement("a");
    anchor.className = "bp-link";
    anchor.setAttribute("part", "link");
    anchor.href = piece.url;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer nofollow";
    anchor.textContent = piece.url;
    parent.appendChild(anchor);
  }
}
