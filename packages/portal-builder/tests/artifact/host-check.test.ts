// Host conformance, checked against a server that really serves the artifact. `preview` is that
// server, which is the honest scope: it shows that `host-check` asks the right questions and
// that a conforming host answers them. It claims nothing about TLS, CDNs or access logs, which
// only a deployed target and `host-check` can settle.

import { readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupFixtures, tempRoot } from "../helpers/fixture.js";
import { buildFixture, writeMatrixSite } from "../helpers/site.js";
import { createPreviewServer } from "../../src/verify/preview.js";
import { hostCheck } from "../../src/verify/host-check.js";

let out: string;
let server: Server;
let base: string;

beforeAll(async () => {
  const source = writeMatrixSite({ databrowser: true, stac: false, auth: true });
  out = join(tempRoot("portal-host-"), "site");
  const result = await buildFixture(source, out);
  expect(result.diagnostics.errors).toEqual([]);

  server = createPreviewServer({ dir: out, port: 0 });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  base = `http://127.0.0.1:${port}/`;
}, 120_000);

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  cleanupFixtures();
});

describe("a conforming host", () => {
  it("serves the root document and every deep link without a SPA fallback", async () => {
    const root = await fetch(base);
    expect(root.status).toBe(200);
    expect(root.headers.get("content-type")).toContain("text/html");

    const deep = await fetch(`${base}docs/guide/`);
    expect(deep.status).toBe(200);
    expect(await deep.text()).toContain("Guide");

    const unknown = await fetch(`${base}definitely-missing/`);
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toContain("Page not found");
  });

  it("redirects the non-slash directory form and preserves the query", async () => {
    const response = await fetch(`${base}docs/guide?probe=1`, { redirect: "manual" });
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("/docs/guide/?probe=1");
  });

  it("applies the recorded cache classes", async () => {
    const manifest = JSON.parse(readFileSync(join(out, "portal-manifest.json"), "utf8")) as {
      files: { path: string; cacheClass: string }[];
    };
    const immutable = manifest.files.find((f) => f.cacheClass === "immutable");
    if (immutable) {
      const response = await fetch(`${base}${immutable.path}`);
      expect(response.headers.get("cache-control")).toContain("immutable");
    }
    const html = await fetch(base);
    expect(html.headers.get("cache-control")).not.toContain("immutable");
  });

  it("applies the auth callback's privacy headers", async () => {
    const response = await fetch(`${base}auth/callback/`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("passes host-check with no errors", async () => {
    const bag = await hostCheck({ dir: out, url: base });
    const errors = bag.errors.map((d) => d.message);
    expect(errors).toEqual([]);
  }, 60_000);

  it("reports a host that drops the download headers", async () => {
    // A second artifact whose manifest declares a download the preview server serves without
    // the required headers, so the check has something to fail on.
    const manifestPath = join(out, "portal-manifest.json");
    const original = readFileSync(manifestPath, "utf8");
    const manifest = JSON.parse(original) as {
      files: { path: string; mimeType: string; cacheClass: string; contentDisposition?: string }[];
    };
    manifest.files.push({
      path: "index.html",
      mimeType: "text/html; charset=utf-8",
      cacheClass: "download",
    });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const bag = await hostCheck({ dir: out, url: base });
    expect(bag.errors.some((d) => d.message.includes("Content-Disposition"))).toBe(true);
    writeFileSync(manifestPath, original);
  }, 60_000);

  it("warns when the artifact is served at a URL it was not built for", async () => {
    const bag = await hostCheck({ dir: out, url: "https://elsewhere.example.org/" });
    expect(bag.warnings.some((d) => d.message.includes("canonical URL"))).toBe(true);
  }, 60_000);
});
