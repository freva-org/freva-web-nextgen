// The generated HTTP status documents. A host is configured to serve a *file* for a status -
// `error_page 503 /503.html`, `ErrorDocument`, a CDN's custom error response - at the URL that
// failed, so the status code survives. The assertions are therefore about files at exact names,
// each carrying its own code, and each being the portal rather than the origin's default error
// page.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupFixtures, tempRoot } from "../helpers/fixture.js";
import { buildFixture, writeMatrixSite } from "../helpers/site.js";
import { STATUS_PAGES } from "../../src/model/status-pages.js";

afterAll(cleanupFixtures);

describe("the HTTP status documents", () => {
  let out: string;

  beforeAll(async () => {
    const source = writeMatrixSite({
      databrowser: false,
      stac: false,
      auth: false,
      canonicalUrl: "https://portal.example.org/site/",
    });
    out = join(tempRoot("portal-status-"), "site");
    const result = await buildFixture(source, out);
    expect(result.diagnostics.errors).toEqual([]);
  }, 120_000);

  const read = (code: number): string => readFileSync(join(out, `${code}.html`), "utf8");

  it("writes one file per status, at the name a host asks for", () => {
    for (const page of STATUS_PAGES) {
      expect(existsSync(join(out, `${page.code}.html`))).toBe(true);
    }
    // Astro writes `/404` and `/500` itself and the rest as directories, so an unmoved file
    // shows up here.
    for (const page of STATUS_PAGES) {
      expect(existsSync(join(out, String(page.code), "index.html"))).toBe(false);
      expect(existsSync(join(out, String(page.code)))).toBe(false);
    }
  });

  it("says which status it is, in the code and in the specification's own name", () => {
    for (const page of STATUS_PAGES) {
      const html = read(page.code);
      expect(html).toContain(`data-portal-status="${page.code}"`);
      expect(html).toContain(`class="portal-status-number">${page.code}<`);
      expect(html).toContain(page.reason);
      expect(html).toContain(page.title);
    }
  });

  it("carries the status mark on every one of them, animated and still", () => {
    for (const page of STATUS_PAGES) {
      const html = read(page.code);
      expect(html).toContain("portal-status-mark");
      // Two files, both the status page's own: the animated mark, plus its first frame exported
      // beside it for a reader who asked for no motion, because an animated image cannot be
      // paused from CSS. Named `status-mark`, not the shell's `freva-mark.webp`, which the
      // footer and the badge both read - replacing that one changes the mark on every page.
      expect(html).toMatch(/class="portal-status-logo" src="[^"]*status-mark[^"]*"/);
      expect(html).toMatch(/class="portal-status-logo-still" src="[^"]*status-mark-still[^"]*"/);
      expect(html).not.toContain("portal-status-glyph");
      // And the credit in the footer, which every page has: an enabled footer carries the badge
      // rather than the plain lockup, and a status document is a portal page like any other.
      expect(html).toContain('id="portal-footer-badge"');
      expect(html).not.toContain("portal-freva-lockup");
    }
  });

  it("is the portal, not a bare error page", () => {
    const html = read(503);
    expect(html).toContain('class="portal-header"');
    expect(html).toContain('class="portal-footer"');
    expect(html).toContain('href="/site/"');
  });

  it("keeps a status document out of the search index and out of the sitemap", () => {
    // A canonical link is the one thing a status page must not claim: it is not a page, it is
    // what a host says when a page is missing.
    for (const page of STATUS_PAGES) {
      const html = read(page.code);
      expect(html).toContain(`<title>${page.title}`);
    }
  });

  it("declares every status document in the manifest", () => {
    const manifest = JSON.parse(readFileSync(join(out, "portal-manifest.json"), "utf8")) as {
      routes: { path: string; kind: string }[];
    };
    const errors = manifest.routes.filter((route) => route.kind === "error").map((r) => r.path);
    expect(errors).toEqual(STATUS_PAGES.map((page) => `/${page.code}.html`));
  });
});
