/**
 * @vitest-environment happy-dom
 */
// The published element interface carries the no-JSPI card's two host hooks, so the assignments
// the README documents compile against `BrowserPythonConsoleElement` and not only the class.
import { describe, expect, it } from "vitest";
import { defineBrowserPythonConsole } from "../../src/console/index.js";
import type { BrowserPythonConsoleElement } from "../../src/console/console-types.js";

describe("BrowserPythonConsoleElement", () => {
  it("types and reflects pageUrl and openExternal", () => {
    defineBrowserPythonConsole();
    const element = document.createElement("freva-python-console") as BrowserPythonConsoleElement;
    expect(element.pageUrl).toBeNull();
    element.pageUrl = "https://portal.example/datasets/";
    expect(element.getAttribute("page-url")).toBe("https://portal.example/datasets/");
    element.pageUrl = null;
    expect(element.hasAttribute("page-url")).toBe(false);

    const opened: string[] = [];
    element.openExternal = (url) => opened.push(url);
    element.openExternal?.("https://www.google.com/chrome/");
    expect(opened).toEqual(["https://www.google.com/chrome/"]);
    element.openExternal = null;
    expect(element.openExternal).toBeNull();
  });
});
