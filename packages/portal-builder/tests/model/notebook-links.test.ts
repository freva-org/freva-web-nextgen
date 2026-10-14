import { describe, expect, it } from "vitest";
import { opensNotebookSheet, proseOpensNotebookSheet } from "../../src/model/notebook-links.js";

const ORIGIN = "https://portal.example.org";
const SHEET = "/showroom/notebook/lab/index.html";

describe("a link in a page's text", () => {
  it("opens the sheet when it is the sheet's address, with only what the sheet takes", () => {
    expect(opensNotebookSheet(SHEET, SHEET, ORIGIN)).toBe(true);
    expect(opensNotebookSheet(`${ORIGIN}${SHEET}?dataset=x&panel=data`, SHEET, ORIGIN)).toBe(true);
    expect(opensNotebookSheet(`${SHEET}?example=examples%2Fa.ipynb`, SHEET, ORIGIN)).toBe(true);
    expect(opensNotebookSheet(`${SHEET}?path=a.ipynb`, SHEET, ORIGIN)).toBe(false);
    expect(opensNotebookSheet(`${SHEET}?panel=climateclaw`, SHEET, ORIGIN)).toBe(false);
    expect(opensNotebookSheet(`${SHEET}#top`, SHEET, ORIGIN)).toBe(false);
    expect(opensNotebookSheet("/showroom/notebook/tree/index.html", SHEET, ORIGIN)).toBe(false);
    expect(opensNotebookSheet(`https://other.example.org${SHEET}`, SHEET, ORIGIN)).toBe(false);
  });

  it("is read from the rendered page, its entities decoded", () => {
    expect(
      proseOpensNotebookSheet(
        `<p><a href="${SHEET}?dataset=x&amp;panel=data" rel="noopener">Open</a></p>`,
        SHEET,
        ORIGIN,
      ),
    ).toBe(true);
    expect(
      proseOpensNotebookSheet(
        `<p><a href="${SHEET}?dataset=x&amp;path=a">Open</a> <img src="${SHEET}"></p>`,
        SHEET,
        ORIGIN,
      ),
    ).toBe(false);
  });
});
