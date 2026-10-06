// The header search: one static index built with the artifact, one island that searches it.
//
// What must hold: the index covers every content page by section, is a content-hashed file in the
// artifact that the manifests and checksums cover, and is served same-origin so the CSP gains
// nothing; the header carries the control only when search is enabled; and with search disabled
// NOTHING of it ships - no index, no island, no stylesheet, no markup - which the evidence plan
// checks against the build graph rather than assuming.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupFixtures, codes, resolveFixture, tempRoot, writeSite } from "../helpers/fixture.js";
import { buildFixture } from "../helpers/site.js";
import { buildSearchIndex, searchFacets, sectionsOf } from "../../src/model/search-index.js";
import { generateEntryModule } from "../../src/artifact/runtime-projection.js";
import { verifyArtifact } from "../../src/verify/verify.js";
import {
  browse,
  inSections,
  normalize,
  search,
  snippet,
  terms,
} from "../../client/components/site-search-core.js";

afterAll(cleanupFixtures);

const PAGE = (title: string, body: string): string =>
  `---\ntitle: ${title}\ndescription: About ${title.toLowerCase()}.\n---\n\n${body}\n`;

function site(search: string, canonicalUrl?: string, header = "true", navigation = ""): string {
  const root = tempRoot("site-search-");
  writeSite(root, {
    ...(canonicalUrl ? { canonicalUrl } : {}),
    content: {
      "content/storage-concepts/index.md": PAGE(
        "Storage concepts",
        "Intro about HEALPix.\n\n## Why Zarr\n\nChunked arrays on object storage.\n\n### Remapping\n\nThe remapping benchmark compares methods.\n\n$$ x^2 $$\n\n```python\nimport xarray\n```\n",
      ),
      "content/storage-concepts/why-healpix.md": PAGE(
        "Why HEALPix?",
        "Equal-area pixels on the sphere.\n",
      ),
    },
    extra: `chrome:
  header:
    enabled: ${header}
${search}rendering:
  profile: portal-content-v1
  sources:
    - root: ./content
      mount: /docs/
${navigation}`,
  });
  return root;
}

const ON = "    search:\n      enabled: true\n      placeholder: Search Waterpark\n";

describe("the index", () => {
  it("splits a page at its h2/h3 headings and keeps only prose", () => {
    const sections = sectionsOf(
      '<p>Lead <span class="katex"><span class="katex-mathml">hidden</span><span class="katex-html">x</span></span> text.</p>' +
        '<h2 id="a">A<a class="portal-heading-anchor" href="#a">#</a></h2><p>Alpha</p>' +
        '<div class="portal-code-figure"><div class="portal-code-head"><span class="portal-code-lang">Python</span><button>Copy</button></div><pre><code>print(1)</code></pre></div>' +
        '<h3 id="b">B</h3><ul><li>one</li><li>two</li></ul>',
    );
    expect(sections).toEqual([
      { text: "Lead text." },
      { heading: "A", id: "a", text: "Alpha print(1)" },
      { heading: "B", id: "b", text: "one two" },
    ]);
  });

  it("indexes every content page by section, base-path-aware, with the description first", async () => {
    const { model } = await resolveFixture(site(ON, "https://portal.example.org/wp/"));
    const index = buildSearchIndex(model!.routes, model!.site.basePath);
    const concepts = index.entries.filter((e) => e.u === "/wp/docs/storage-concepts/");
    expect(concepts.map((e) => e.h ?? null)).toEqual([null, "Why Zarr", "Remapping"]);
    expect(concepts[0]!.x).toMatch(/^About storage concepts\. Intro about HEALPix\./);
    expect(concepts[2]!.a).toBe("remapping");
    // The code is searchable; the maths' hidden copy and the language label are not.
    expect(concepts[2]!.x).toContain("import xarray");
    expect(concepts[2]!.x).not.toMatch(/Python import/);
  });
});

describe("the filters", () => {
  const NAVIGATION = `navigation:
  header:
    - label: Concepts
      href: /docs/storage-concepts/
`;

  it("label every entry with its header section and count the pages in each", async () => {
    const { model } = await resolveFixture(site(ON, undefined, "true", NAVIGATION));
    expect(model!.search!.facets).toEqual([{ label: "Concepts", count: 2 }]);
    const index = buildSearchIndex(model!.routes, model!.site.basePath, () => "Concepts");
    expect(index.entries.every((entry) => entry.s === "Concepts")).toBe(true);
  });

  it("keep a nested section's pages out of the broader section listed before it", async () => {
    const nested = `navigation:
  header:
    - label: Concepts
      href: /docs/storage-concepts/
    - label: HEALPix
      href: /docs/storage-concepts/why-healpix/
`;
    const { model, diagnostics } = await resolveFixture(site(ON, undefined, "true", nested));
    expect(diagnostics.errors).toEqual([]);
    expect(model!.search!.facets).toEqual([
      { label: "Concepts", count: 1 },
      { label: "HEALPix", count: 1 },
    ]);
  });

  it("order the sections by page count, then by name", () => {
    const facets = searchFacets({
      v: 1,
      entries: [
        { u: "/a/", t: "A", x: "", s: "Small" },
        { u: "/b/", t: "B", x: "", s: "Big" },
        { u: "/b/", t: "B", h: "More", x: "", s: "Big" },
        { u: "/c/", t: "C", x: "", s: "Big" },
        { u: "/d/", t: "D", x: "", s: "Also" },
        { u: "/e/", t: "E", x: "" },
      ],
    });
    expect(facets).toEqual([
      { label: "Big", count: 2 },
      { label: "Also", count: 1 },
      { label: "Small", count: 1 },
    ]);
  });

  it("are empty without header navigation, so the dialog has no panel", async () => {
    const { model } = await resolveFixture(site(ON));
    expect(model!.search!.facets).toEqual([]);
  });
});

describe("the island's search", () => {
  const entries = [
    { u: "/docs/a/", t: "Remapping benchmark", x: "Compares nearest and conservative." },
    { u: "/docs/b/", t: "Storage", h: "Remapping", a: "remapping", x: "Short." },
    { u: "/docs/c/", t: "Other", x: "A theorem about remapping and Zürich." },
  ].map((e) => ({ ...e, nt: normalize(e.t), nh: normalize(e.h ?? ""), nx: normalize(e.x) }));

  it("ranks a title over a heading over the text, and needs every term", () => {
    expect(search(entries, "remap").map((h) => h.entry.u)).toEqual([
      "/docs/a/",
      "/docs/b/",
      "/docs/c/",
    ]);
    expect(search(entries, "remapping conservative").map((h) => h.entry.u)).toEqual(["/docs/a/"]);
    expect(search(entries, "r")).toEqual([]);
  });

  it("ignores case and accents", () => {
    expect(terms("ZÜRICH, Remap")).toEqual(["zurich", "remap"]);
    expect(search(entries, "zurich").map((h) => h.entry.u)).toEqual(["/docs/c/"]);
  });

  it("limits to the chosen sections, and lists their pages once each without a query", () => {
    const scoped = entries.map((e, i) => ({ ...e, s: i === 2 ? "Other" : "Docs" }));
    expect(inSections(scoped, new Set()).length).toBe(3);
    expect(inSections(scoped, new Set(["Other"])).map((e) => e.u)).toEqual(["/docs/c/"]);
    const twice = [...scoped, { ...scoped[0]!, h: "Again", nh: "again" }];
    expect(browse(inSections(twice, new Set(["Docs"]))).map((h) => h.entry.u)).toEqual([
      "/docs/a/",
      "/docs/b/",
    ]);
  });

  it("takes a snippet around the first match", () => {
    const text = `${"x ".repeat(200)}needle ${"y ".repeat(200)}`;
    const cut = snippet(text, ["needle"]);
    expect(cut).toContain("needle");
    expect(cut.startsWith("…")).toBe(true);
    expect(cut.length).toBeLessThan(170);
  });
});

describe("the artifact", () => {
  it("ships the index, the control and the island when enabled", async () => {
    const out = join(tempRoot("site-search-on-"), "site");
    const result = await buildFixture(site(ON), out);
    expect(result.diagnostics.errors).toEqual([]);

    const index = readdirSync(join(out, "_portal")).filter((f) =>
      /^search-index\.[\w-]{8}\.json$/.test(f),
    );
    expect(index).toHaveLength(1);
    const manifest = JSON.parse(readFileSync(join(out, "portal-manifest.json"), "utf8"));
    const entry = manifest.files.find((f: { path: string }) => f.path === `_portal/${index[0]}`);
    expect(entry).toMatchObject({ mimeType: "application/json", cacheClass: "immutable" });
    expect(readFileSync(join(out, "checksums.sha256"), "utf8")).toContain(`_portal/${index[0]}`);
    expect(verifyArtifact(out).errors).toEqual([]);

    const html = readFileSync(join(out, "docs", "storage-concepts", "index.html"), "utf8");
    expect(html).toContain(`data-portal-sitesearch-index="/_portal/${index[0]}"`);
    expect(html).toContain('class="portal-sitesearch-open"');
    expect(html).toContain('placeholder="Search Waterpark"');
    expect(html).toMatch(/<input[^>]*role="combobox"/);
    // freva-web-nextgen#17: no keyboard shortcut, announced or shown.
    expect(html).not.toContain("aria-keyshortcuts");
    expect(html).not.toContain("portal-sitesearch-key");

    const evidence = result.evidence?.find((c) => c.id === "site-search");
    expect(evidence?.enabled).toBe(true);
    expect(evidence?.modules).toContain("builder:client/components/site-search.ts");

    // Same origin: the policy gains nothing for search.
    const policy = JSON.parse(readFileSync(join(out, "host-policy.json"), "utf8"));
    expect(policy.csp.portal["connect-src"]).toBe("'self'");
  }, 300_000);

  it("ships nothing of it when disabled", async () => {
    const out = join(tempRoot("site-search-off-"), "site");
    const result = await buildFixture(site(""), out);
    expect(result.diagnostics.errors).toEqual([]);
    expect(readdirSync(join(out, "_portal")).some((f) => f.startsWith("search-index."))).toBe(
      false,
    );
    const evidence = result.evidence?.find((c) => c.id === "site-search");
    expect(evidence?.enabled).toBe(false);
    expect(evidence?.modules).toEqual([]);
    const html = readFileSync(join(out, "index.html"), "utf8");
    expect(html).not.toContain("portal-sitesearch");
    for (const file of readdirSync(join(out, "_portal"))) {
      if (!/\.(css|js)$/.test(file)) continue;
      expect(readFileSync(join(out, "_portal", file), "utf8")).not.toMatch(
        /portal-sitesearch-open|search-index/,
      );
    }
  }, 300_000);

  it("names the island in the entry only when enabled", async () => {
    const on = await resolveFixture(site(ON));
    const off = await resolveFixture(site(""));
    expect(generateEntryModule(on.model!)).toContain("components/site-search.ts");
    expect(generateEntryModule(off.model!)).not.toContain("site-search");
  });

  it("warns when the header that would hold it is off", async () => {
    const { diagnostics } = await resolveFixture(site(ON, undefined, "false"));
    expect(codes(diagnostics.warnings)).toContain("FP1225");
  });
});
