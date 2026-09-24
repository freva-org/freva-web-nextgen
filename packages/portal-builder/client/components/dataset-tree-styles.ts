/**
 * `@freva-org/dataset-tree`'s own stylesheet, adopted at RUNTIME rather than linked from the head.
 *
 * The portal has one client entry for the whole site, so anything that entry can reach is in every
 * page's client graph, and Astro links the CSS of everything in a page's graph from that page's
 * `<head>` - which is how a page avoids painting unstyled content. Left as an import, the tree
 * package's stylesheet is a `<link>` on every page of a portal, the 404 document included.
 *
 * Moving it is safe because of WHAT the sheet styles: everything inside `.dataset-tree`, which the
 * package draws after this module has run. The server emits a container and a JSON block and
 * nothing else, so there is no moment at which unstyled tree markup could be on screen. The
 * portal's OWN wrapper - heading, summary, width - is `./dataset-tree.css`, and stays a linked
 * stylesheet precisely because it styles markup the server did render.
 *
 * `?inline` makes it a string instead of a side effect: Vite hands back the processed CSS and
 * emits no stylesheet asset, so the bytes travel inside the island's own chunk.
 *
 * Adopted through a constructable stylesheet, which also survives a strict `style-src 'self'`: a
 * `<style>` element is inline style and a careful portal's policy refuses one. The element remains
 * as a fallback for an engine without `adoptedStyleSheets`.
 */

import CSS from "@freva-org/dataset-tree/styles.css?inline";

/** Documents this stylesheet has been adopted into, so N blocks cost one sheet. */
const adopted = new WeakSet<Document>();

/** Put the package's stylesheet in the document, before anything it styles exists. */
export function adoptTreeStyles(doc: Document = document): void {
  if (adopted.has(doc)) return;
  adopted.add(doc);
  try {
    if (typeof CSSStyleSheet === "function" && Array.isArray(doc.adoptedStyleSheets)) {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
      return;
    }
  } catch {
    // an engine that has the API and refuses the sheet falls through to the element
  }
  const style = doc.createElement("style");
  style.textContent = CSS;
  doc.head.append(style);
}
