// Containment of the embedded catalogue's stylesheet. The claim is narrow and the consequence of
// getting it wrong is wide: the portal serves a third-party application's compiled CSS into its
// own document, and every selector in it that does not name the mount restyles the portal's own
// header, navigation and prose.
//
// These are unit tests over the rewrite - which shapes it has to handle. The browser suite
// carries the other half, that no rule in a BUILT artifact matches an element outside the mount,
// which is where "are these all the shapes there are?" can be settled.

import { describe, expect, it } from "vitest";
import {
  containStylesheet,
  findEscapes,
  scopeSelector,
  splitSelectorList,
} from "../../src/components/stac-browser/containment.js";

const contained = (css: string) => containStylesheet(css).css;

describe("scopeSelector", () => {
  it("narrows a bare element selector without changing its specificity", () => {
    // `a:hover { text-decoration: underline }` underlines the portal's own navigation links on
    // the catalogue route unless it is narrowed, and it has to keep matching links inside the
    // embed at exactly its original weight, or Bootstrap's `.btn` - one class - stops winning.
    expect(scopeSelector("a:hover")).toBe(":where(#stac-browser-mount) a:hover");
    expect(scopeSelector("*")).toBe(":where(#stac-browser-mount) *");
    expect(scopeSelector(".badge")).toBe(":where(#stac-browser-mount) .badge");
  });

  it("replaces a document selector rather than descending into it", () => {
    // `:where(#stac-browser-mount) body` matches nothing: the document element is an ANCESTOR of
    // the mount, so it is replaced by the mount and the rest of the compound is kept.
    expect(scopeSelector(":root")).toBe("#stac-browser-mount");
    expect(scopeSelector("html")).toBe("#stac-browser-mount");
    expect(scopeSelector("body.sidebar .drawer")).toBe("#stac-browser-mount.sidebar .drawer");
  });

  it("keeps the id form for both of Bootstrap's theme blocks", () => {
    // Upstream declares light on `:root,[data-bs-theme=light]` and dark on `[data-bs-theme=dark]`
    // at equal specificity, so source order decides and dark wins. Scoping one with an id and not
    // the other takes the application halfway dark: everything driven by a Bootstrap variable
    // silently stays light. Both land on the same element and are rewritten the same way, and a
    // leading `[data-bs-theme=…]` is concatenated, because Bootstrap sets that attribute on the
    // very element it themes.
    expect(scopeSelector("[data-bs-theme=dark]")).toBe("#stac-browser-mount[data-bs-theme=dark]");
    expect(scopeSelector("[data-bs-theme=light]")).toBe("#stac-browser-mount[data-bs-theme=light]");
  });

  it("leaves a selector that already names the embed exactly as it is", () => {
    // Prefixing one of these would produce `:where(#stac-browser-mount) #stac-browser-mount`,
    // which matches nothing at all - the mount is not inside itself. That is how a containment
    // pass silently deletes a stylesheet.
    expect(scopeSelector("#stac-browser .btn")).toBe("#stac-browser .btn");
    expect(scopeSelector("#stac-browser-mount.portal-stac-mount")).toBe(
      "#stac-browser-mount.portal-stac-mount",
    );
  });

  it("leaves a shadow-tree selector alone", () => {
    // `:host` matches only from inside a shadow tree's own stylesheet, so in a document stylesheet
    // it already matches nothing. A descendant combinator in front of it is not narrower, it is
    // differently broken.
    expect(scopeSelector(":host")).toBe(":host");
    expect(scopeSelector(":host [data-bs-theme=dark]")).toBe(":host [data-bs-theme=dark]");
  });
});

describe("splitSelectorList", () => {
  it("splits on commas that separate selectors and no others", () => {
    expect(splitSelectorList("a, b").map((s) => s.trim())).toEqual(["a", "b"]);
    expect(splitSelectorList(":is(a, b) c").map((s) => s.trim())).toEqual([":is(a, b) c"]);
    expect(splitSelectorList('[title="a,b"]').map((s) => s.trim())).toEqual(['[title="a,b"]']);
  });
});

describe("containStylesheet", () => {
  it("contains a rule that opens an at-rule block", () => {
    // An expression anchored on `(^|[},])` cannot see a rule preceded by `{`, the first rule
    // inside an at-rule, so `:root{scroll-behavior:smooth}` inside
    // `@media (prefers-reduced-motion: no-preference)` reaches the host document. A parser has
    // one reading of a stylesheet; an expression has as many as it has anchors.
    const out = contained(
      "@media (prefers-reduced-motion: no-preference){:root{scroll-behavior:smooth}}",
    );
    expect(out).toContain("#stac-browser-mount{scroll-behavior:smooth}");
    expect(findEscapes(out)).toEqual([]);
  });

  it("leaves keyframe steps alone", () => {
    // `from`, `to` and `42%` are step selectors, not element selectors. Rewriting one produces an
    // animation with no keyframes, which is an animation that does not run.
    const out = contained("@keyframes spin{from{transform:rotate(0)}to{transform:rotate(1turn)}}");
    expect(out).toBe("@keyframes spin{from{transform:rotate(0)}to{transform:rotate(1turn)}}");
    expect(findEscapes(out)).toEqual([]);
  });

  it("rewrites every selector in a list independently", () => {
    const out = contained("h1,#stac-browser .h1,body{margin:0}");
    expect(out).toBe(
      ":where(#stac-browser-mount) h1,#stac-browser .h1,#stac-browser-mount{margin:0}",
    );
  });

  it("reports what it could not contain instead of shipping it", () => {
    // A stylesheet that cannot be parsed must not be rewritten, and must not be quietly passed
    // through either: the build is what refuses it, and it can only refuse what it is told about.
    const result = containStylesheet("a{color:red");
    expect(result.escaped).toEqual(["<unparseable stylesheet>"]);
    expect(result.css).toBe("a{color:red");
  });

  it("finds nothing left to contain in its own output", () => {
    const source = [
      "*,*::before{box-sizing:border-box}",
      "a{color:#0d6efd}",
      "a:hover{text-decoration:underline}",
      "button:not(:disabled){cursor:pointer}",
      "[hidden]{display:none!important}",
      ".badge{--bs-badge-color:#fff}",
      "#stac-browser>header .site>.col-md-12>.title a:hover{color:var(--sb-header-hover-color)}",
      "@media (min-width:768px){.container{max-width:720px}}",
    ].join("");
    const result = containStylesheet(source);
    expect(findEscapes(source).length).toBeGreaterThan(0);
    expect(result.escaped).toEqual([]);
    expect(result.scoped).toBe(8);
  });
});
