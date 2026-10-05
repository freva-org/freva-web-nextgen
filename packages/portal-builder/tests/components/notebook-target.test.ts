// "Open as notebook" opens the seed of the registered example run last - and after an edited
// snippet (the visitor's own source, which no seed holds), the notebook's file list.
import { describe, expect, it } from "vitest";

import { NotebookTarget, notebookSeedPath } from "../../client/notebook-paths.js";

describe("Open as notebook", () => {
  it("opens the last registered example, never an earlier one after an edited run", () => {
    const target = new NotebookTarget();
    const origin = "https://py.example.org";
    expect(target.url(origin)).toBe(`${origin}/notebook/tree/index.html`);
    target.ranExample("a".repeat(64));
    expect(target.url(origin)).toContain(encodeURIComponent(notebookSeedPath("a".repeat(64))));
    target.ranOther();
    expect(target.hasExample).toBe(false);
    expect(target.url(origin)).toBe(`${origin}/notebook/tree/index.html`);
  });
});
