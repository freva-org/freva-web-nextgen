// What a build says when Mermaid cannot get a browser.
//
// The canonical image carries Playwright and a pinned Chromium. An npm install of this package
// carries neither: Playwright is an optional peer dependency, and its browsers are a separate
// download. So FP1702 names the commands for the cause it actually hit, instead of pointing an
// npm consumer at an image they are not using.

import { describe, expect, it } from "vitest";
import { browserHint, PlaywrightMissing, renderDiagrams } from "../../src/rendering/mermaid.js";
import { loadProfile } from "../../src/rendering/profile.js";

describe("the FP1702 hint", () => {
  it("names the package and the browser download when Playwright is not installed", () => {
    const hint = browserHint(new PlaywrightMissing("Cannot find package 'playwright'."), "");
    expect(hint).toContain("npm install --save-dev playwright");
    expect(hint).toContain("npx playwright install --with-deps chromium");
    expect(hint).toContain("FREVA_PORTAL_CHROMIUM");
  });

  it("names the browser download when Playwright has no Chromium", () => {
    const error = new Error(
      "browserType.launch: Executable doesn't exist at /root/.cache/ms-playwright/chromium-1194/chrome-linux/chrome",
    );
    const hint = browserHint(error, "");
    expect(hint).toMatch(/has not been downloaded/);
    expect(hint).toContain("npx playwright install --with-deps chromium");
  });

  it("names --with-deps when the system libraries are missing", () => {
    const error = new Error(
      "chrome: error while loading shared libraries: libnss3.so: cannot open shared object file",
    );
    expect(browserHint(error, "")).toMatch(/system libraries[\s\S]*--with-deps/);
  });

  it("blames the configured path when FREVA_PORTAL_CHROMIUM is set", () => {
    expect(browserHint(new Error("spawn ENOENT"), "/opt/nowhere/chrome")).toContain(
      "FREVA_PORTAL_CHROMIUM is set to '/opt/nowhere/chrome'",
    );
  });
});

describe("a build with a diagram and no usable browser", () => {
  it("fails with FP1702, at the diagram, with the hint", async () => {
    const previous = process.env.FREVA_PORTAL_CHROMIUM;
    process.env.FREVA_PORTAL_CHROMIUM = "/nonexistent/chromium";
    try {
      const [result] = await renderDiagrams(
        [{ code: "graph TD; A-->B", id: "d1", file: "content/page.md", line: 3 }],
        loadProfile().profile,
      );
      const diagnostic = result!.diagnostics[0]!;
      expect(diagnostic.code).toBe("FP1702");
      expect(diagnostic.file).toBe("content/page.md");
      expect(diagnostic.position).toEqual({ line: 3 });
      expect(diagnostic.hint).toContain("FREVA_PORTAL_CHROMIUM");
      // One line of Playwright's message, not its whole framed banner.
      expect(diagnostic.message.split("\n")).toHaveLength(1);
    } finally {
      if (previous === undefined) delete process.env.FREVA_PORTAL_CHROMIUM;
      else process.env.FREVA_PORTAL_CHROMIUM = previous;
    }
  });
});
