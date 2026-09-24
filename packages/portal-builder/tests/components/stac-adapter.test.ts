// The STAC adapter contract. The adapter, not upstream's option list, is the public contract, so
// these tests assert what the consumer *cannot* reach: no upstream option name in YAML, no
// `runtime-config.js` in the artifact, no consumer JavaScript, and history/base behaviour that is
// derived rather than configured.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  cleanupFixtures,
  codes,
  resolveFixture,
  tempRoot,
  write,
  writeSite,
} from "../helpers/fixture.js";
import { buildFixture, writeMatrixSite, STAC_MATERIALS } from "../helpers/site.js";
import {
  derivePathPrefix,
  generateAdapterModule,
} from "../../src/components/stac-browser/adapter.js";
import type { StacOptions } from "../../src/model/types.js";

afterAll(cleanupFixtures);

const OPTIONS: StacOptions = {
  chrome: {
    title: "Example Catalog",
    footerLinks: [{ label: "Institute", href: "https://www.example.org/" }],
  },
  access: { externalCatalogs: "deny", basemapOrigins: [] },
  rootPage: {},
  linkPolicy: {
    canonicalizeAdvertisedRoot: true,
    hiddenRelations: ["service-desc"],
    rootAliases: [],
  },
  historyMode: "hash",
  pathPrefix: "/site/catalog/",
  catalogUrl: "https://catalog.example.org/stac/",
};

describe.skipIf(!STAC_MATERIALS)("the generated adapter module", () => {
  it("maps closed portal options onto upstream configuration", () => {
    const source = generateAdapterModule({
      options: OPTIONS,
      entryUrl: "/site/stac/assets/index.js",
      styleUrls: ["/site/stac/assets/index.css"],
      mountId: "stac-browser-mount",
    });
    expect(source).toContain('"catalogTitle": "Example Catalog"');
    expect(source).toContain('"catalogUrl": "https://catalog.example.org/stac/"');
    expect(source).toContain('"allowExternalAccess": false');
    expect(source).toContain('"historyMode": "hash"');
    expect(source).toContain('"pathPrefix": "/site/catalog/"');
    expect(source).toContain("export function preprocessSTAC");
  });

  it("derives the upstream path prefix from the canonical base and the route", () => {
    expect(derivePathPrefix("/", "/catalog/")).toBe("/catalog/");
    expect(derivePathPrefix("/site/", "/catalog/")).toBe("/site/catalog/");
    expect(derivePathPrefix("/site/", "/browse/stac/")).toBe("/site/browse/stac/");
  });

  // The rule that an unlisted origin is never guessed to be an alias lives in
  // stac-adapter-contract.test.ts, where the module is loaded and `preprocessSTAC` is called with
  // a cross-origin link. Matching a line of the generated text here would prove only that the
  // line is spelled a certain way.
});

describe.skipIf(!STAC_MATERIALS)("what the consumer schema refuses", () => {
  it.each([
    ["an opaque upstream option map", "      upstreamOptions:\n        catalogTitle: x\n"],
    ["an SB_CONFIG path", "      sbConfig: ./stac.config.mjs\n"],
    ["a JavaScript hook", "      preprocessSTAC: ./hook.mjs\n"],
    ["an unreviewed access mode", "      access:\n        externalCatalogs: allow\n"],
    ["a history-mode override", "      historyMode: history\n"],
    ["a pathPrefix override", "      pathPrefix: /elsewhere/\n"],
  ])("refuses %s", async (_name, snippet) => {
    const root = tempRoot();
    writeSite(root, {
      extra: `services:
  publicCatalog:
    kind: stac
    catalogUrl: https://catalog.example.org/stac/
components:
  catalog:
    kind: stac-browser
    enabled: false
    options:
${snippet}`,
    });
    const result = await resolveFixture(root);
    expect(codes(result.diagnostics)).toContain("FP1104");
  });

  it("renders rootPage.intro through portal-content-v1 rather than injecting it as config", async () => {
    const root = tempRoot();
    write(root, "content/_fragments/intro.md", "Catalog **intro**.\n");
    writeSite(root, {
      extra: `rendering:
  profile: portal-content-v1
  sources:
    - root: ./content
      mount: /docs/
      files:
        include: ["**/*.md"]
        exclude: ["_fragments/**"]
services:
  publicCatalog:
    kind: stac
    catalogUrl: https://catalog.example.org/stac/
components:
  catalog:
    kind: stac-browser
    enabled: false
    options:
      rootPage:
        intro: ./content/_fragments/intro.md
`,
    });
    const result = await resolveFixture(root);
    expect(result.diagnostics.errors).toEqual([]);
    const options = result.model!.components[0]!.options as StacOptions;
    expect(options.rootPage.introHtml).toBe("<p>Catalog <strong>intro</strong>.</p>");
  });
});

describe.skipIf(!STAC_MATERIALS)("the built artifact", () => {
  it("ships prepared materials with no runtime configuration file", async () => {
    const root = writeMatrixSite({
      databrowser: false,
      stac: true,
      auth: false,
      canonicalUrl: "https://portal.example.org/site/",
    });
    const out = join(tempRoot("portal-stac-out-"), "site");
    const result = await buildFixture(root, out);
    expect(result.diagnostics.errors).toEqual([]);

    expect(existsSync(join(out, "stac"))).toBe(true);
    expect(existsSync(join(out, "stac", "runtime-config.js"))).toBe(false);
    expect(existsSync(join(out, "stac", "index.html"))).toBe(false);

    // The component route is a real file, so a hash reload needs no SPA fallback.
    const page = readFileSync(join(out, "catalog", "index.html"), "utf8");
    expect(page).toContain('id="stac-browser-mount"');

    // The compiler may emit the island entry as a file or inline it into the document; either
    // way the adapter's derived values must be in the artifact.
    const bundles = readdirSync(join(out, "_portal")).filter((f) => f.endsWith(".js"));
    const shipped = [
      ...bundles.map((f) => readFileSync(join(out, "_portal", f), "utf8")),
      readFileSync(join(out, "catalog", "index.html"), "utf8"),
    ].join("\n");
    expect(shipped).toContain("hash");
    expect(shipped).toContain("/site/catalog/");

    const input = JSON.parse(readFileSync(join(out, "input-manifest.json"), "utf8")) as {
      stac: {
        upstream: { tag: string; commit: string };
        patches: unknown[];
        preparedDigest: string;
      };
    };
    expect(input.stac.upstream.tag).toMatch(/^v\d/);
    expect(input.stac.upstream.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(input.stac.preparedDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Array.isArray(input.stac.patches)).toBe(true);
  }, 120_000);
});

// One page, one name. A component route carries three titles: the page title in the shell and
// the browser tab, the chrome title the mounted application draws, and the title the portal
// projects onto the STAC root document. Untied, they diverge into a page called "Catalog", an
// application header called "Example Catalog" and a root document called "Example Research
// Catalog", with a browser tab or a search result showing only the framework's generic default.
describe("the component route's title and description surfaces", () => {
  const site = (options: string): string => `services:
  publicCatalog:
    kind: stac
    catalogUrl: https://catalog.example.org/stac/
components:
  catalog:
    kind: stac-browser
    enabled: false
${options}`;

  async function routeFor(extra: string): Promise<{ title: string; description: string }> {
    const root = tempRoot();
    writeSite(root, { extra });
    const result = await resolveFixture(root);
    expect(result.diagnostics.errors).toEqual([]);
    const component = result.model!.components[0]!;
    return { title: component.title, description: component.description };
  }

  it("falls back to the framework default only when the deployment has stated nothing", async () => {
    expect(await routeFor(site("    options: {}\n"))).toEqual({
      title: "Catalog",
      description: "Browse the STAC catalog.",
    });
  });

  it("prefers the name the deployment gave the catalogue over the generic default", async () => {
    expect(
      (
        await routeFor(
          site(`    options:
      chrome:
        title: Example Catalog
`),
        )
      ).title,
    ).toBe("Example Catalog");
  });

  it("prefers the root document's title over the application's chrome title", async () => {
    // Both name the same thing, but `rootPage.title` is what a visitor reads at the top of the
    // catalogue, so it is the more specific statement of what this page is.
    expect(
      (
        await routeFor(
          site(`    options:
      chrome:
        title: Example Catalog
      rootPage:
        title: Example Research Catalog
`),
        )
      ).title,
    ).toBe("Example Research Catalog");
  });

  it("still lets the route's own title win, because that field names the route", async () => {
    expect(
      (
        await routeFor(
          `services:
  publicCatalog:
    kind: stac
    catalogUrl: https://catalog.example.org/stac/
components:
  catalog:
    kind: stac-browser
    enabled: false
    title: Data Catalogue
    options:
      chrome:
        title: Example Catalog
      rootPage:
        title: Example Research Catalog
`,
        )
      ).title,
    ).toBe("Data Catalogue");
  });

  it("takes the meta description from the stated root description, never from the introduction", async () => {
    // `intro` is deliberately not a source: it is rendered HTML for a region of the page, can be
    // paragraphs long, and a meta description assembled by stripping its tags is a fabricated
    // summary rather than a stated one. A deployment supplying only an introduction keeps the
    // framework's description.
    const stated = await routeFor(
      site(`    options:
      rootPage:
        description: Reanalysis and model output published by the institute.
`),
    );
    expect(stated.description).toBe("Reanalysis and model output published by the institute.");
  });
});
