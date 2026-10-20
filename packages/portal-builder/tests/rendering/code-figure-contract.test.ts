// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// The code figure the builder renders, held to `@freva-org/browser-python/ui/code-figure.html` -
// the markup contract `/ui/code` reads, which the package tests itself and every other generator
// (Waterpark's MkDocs hook) is held to as well. A change to the shape on either side fails here.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { renderOne } from "../helpers/render.js";

const require = createRequire(import.meta.url);
const contract = readFileSync(
  require.resolve("@freva-org/browser-python/ui/code-figure.html"),
  "utf8",
);
/** The generator's choice, as the contract file says. */
const OPTIONAL = new Set(["data-portal-editable"]);

/** Each element of a figure: its tag, classes, `data-portal-*` names and its parents' first class. */
function shape(
  root: Element,
): { tag: string; classes: string[]; portal: string[]; parents: string[] }[] {
  return [root, ...Array.from(root.querySelectorAll("*"))].map((el: Element) => {
    const parents: string[] = [];
    for (let p = el.parentElement; p && p !== root.parentElement; p = p.parentElement) {
      parents.unshift(p.classList[0] ?? p.tagName.toLowerCase());
    }
    return {
      tag: el.tagName.toLowerCase(),
      classes: [...el.classList],
      portal: el
        .getAttributeNames()
        .filter((n) => n.startsWith("data-portal-") && !OPTIONAL.has(n)),
      parents,
    };
  });
}

describe("the code figure contract", () => {
  it("is met by a runnable block the builder renders", async () => {
    const markdown = ["# Guide", "", "```python try-in-python", 'print("hello")', "```", ""].join(
      "\n",
    );
    const out = await renderOne("guide.md", markdown, {}, { runnable: true });
    const parse = (html: string) => new DOMParser().parseFromString(html, "text/html");
    const wanted = parse(contract).querySelector(".portal-code-figure")!;
    const produced = parse(out.html).querySelector(".portal-code-figure");
    expect(produced, "no code figure in the rendered page").toBeTruthy();
    const have = shape(produced!);
    for (const want of shape(wanted)) {
      const found = have.some(
        (h) =>
          h.tag === want.tag &&
          want.classes.every((c) => h.classes.includes(c)) &&
          want.portal.every((a) => h.portal.includes(a)) &&
          want.parents.every((p) => h.parents.includes(p)),
      );
      expect(
        found,
        `<${want.tag} class="${want.classes.join(" ")}"> ${want.portal.join(" ")}`,
      ).toBe(true);
    }
  });
});
