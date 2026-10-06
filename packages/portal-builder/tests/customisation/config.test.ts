// The typed customisation options: accepted when valid, refused with a location when not, and
// never able to hide a protected control, enable a feature or reach a route it does not own.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  cleanupFixtures,
  codes,
  FULL_EXAMPLE,
  MINIMAL_EXAMPLE,
  REPO_ROOT,
  resolveFixture,
  tempRoot,
  write,
  writeSite,
} from "../helpers/fixture.js";
import { buildSite } from "../../src/artifact/index.js";
import { resolveModel } from "../../src/model/resolve.js";
import { canonicalizeRoot } from "../../src/config/paths.js";
import type { ResolveResult } from "../../src/model/resolve.js";

afterAll(cleanupFixtures);

const WOFF2 = Buffer.concat([Buffer.from("wOF2"), Buffer.alloc(60)]);

const SERVICES = `services:
  dataApi:
    kind: databrowser
    baseUrl: /api/freva-nextgen/databrowser
  authBroker:
    kind: auth
    baseUrl: /api/freva-nextgen/auth/v2
components:
  data:
    kind: databrowser
    enabled: DATA
    service: dataApi
    route: /data/
  login:
    kind: auth
    enabled: AUTH
    service: authBroker
    options:
      callbackPath: /auth/callback/
      expectedIssuer: https://identity.example.org/realms/portal
`;

interface Options {
  chrome?: string;
  theme?: string;
  navigation?: string;
  landing?: string;
  data?: boolean;
  auth?: boolean;
  files?: Record<string, string | Buffer>;
}

/** A site with the Data Browser and auth available, and the YAML a test is about. */
function site(options: Options = {}): string {
  const root = tempRoot("portal-custom-");
  writeSite(root, {
    ...(options.landing ? { landing: options.landing } : {}),
    content: {
      "content/guide.md": "---\ntitle: Guide\n---\n\n## One\n\nText.\n\n## Two\n\nText.\n",
    },
    extra: [
      "rendering:\n  profile: portal-content-v1\n  sources:\n    - root: ./content\n      mount: /docs/",
      options.chrome
        ? `chrome:\n${options.chrome}`
            .replace("  header:\n", "  header:\n    enabled: true\n")
            .replace("  footer:\n", "  footer:\n    enabled: true\n")
        : "",
      options.navigation ? `navigation:\n${options.navigation}` : "",
      SERVICES.replace("DATA", String(options.data ?? true)).replace(
        "AUTH",
        String(options.auth ?? false),
      ),
    ].join("\n"),
  });
  if (options.theme) {
    const config = readFileSync(join(root, "portal.yaml"), "utf8");
    write(
      root,
      "portal.yaml",
      config.replace("  preset: default", `  preset: default\n${options.theme}`),
    );
  }
  for (const [path, content] of Object.entries(options.files ?? {})) {
    if (typeof content === "string") write(root, path, content);
    else write(root, path, content.toString("latin1"));
  }
  return root;
}

function errorAt(result: ResolveResult, code: string) {
  return result.diagnostics.items.find((d) => d.code === code && d.severity === "error");
}

describe("configurations without customisation", () => {
  it.each([
    ["minimal", MINIMAL_EXAMPLE],
    ["full", FULL_EXAMPLE],
  ])("the %s example resolves with no customisation model", async (_name, root) => {
    const result = await resolveModel({
      sourceRoot: canonicalizeRoot(root),
      configPath: join(root, "portal.yaml"),
      ...(root === FULL_EXAMPLE
        ? { stacMaterialsDir: join(REPO_ROOT, "packages", "stac-browser", "materials") }
        : {}),
    });
    if (!result.model) return; // the full example needs prepared STAC materials
    expect(result.model.customisation).toBeUndefined();
    expect(result.model.customisationFiles).toBeUndefined();
    expect(result.model.routes.every((route) => route.slots === undefined)).toBe(true);
  });
});

describe("chrome.header", () => {
  it("accepts a variant, sticky, transparentOverHero, a logo with variants and an item order", async () => {
    const root = site({
      auth: true,
      chrome: `  header:
    variant: split
    sticky: false
    transparentOverHero: true
    logo:
      src: ./brand/logo.svg
      dark: ./brand/logo.svg
      alt: Brand
    items: [brand, links, navToggle, themeToggle, auth]`,
      files: {
        "brand/logo.svg": readFileSync(join(MINIMAL_EXAMPLE, "assets", "logo.svg"), "utf8"),
      },
    });
    const result = await resolveFixture(root);
    expect(codes(result.diagnostics).filter((c) => c.startsWith("FP1"))).not.toContain("FP1230");
    const custom = result.model!.customisation!;
    expect(custom.header).toMatchObject({
      variant: "split",
      sticky: false,
      transparentOverHero: true,
      items: ["brand", "links", "navToggle", "themeToggle", "auth"],
    });
    expect(custom.header.logo!.src).toMatch(/^\/_portal\/site\/logo\.[0-9a-f]{8}\.svg$/);
    expect(result.model!.inputs.some((i) => i.role === "customisation-asset")).toBe(true);
  });

  it("refuses an unknown variant at its pointer", async () => {
    const result = await resolveFixture(site({ chrome: "  header:\n    variant: fancy" }));
    const diagnostic = errorAt(result, "FP1104")!;
    expect(diagnostic.file).toBe("portal.yaml");
    expect(diagnostic.position?.line).toBeGreaterThan(0);
  });

  it("refuses an order that leaves out the menu button", async () => {
    const result = await resolveFixture(
      site({ chrome: "  header:\n    items: [brand, links, themeToggle]" }),
    );
    expect(errorAt(result, "FP1230")?.pointer).toBe("/chrome/header/items");
  });

  it("refuses an order that leaves out the account control while auth is enabled", async () => {
    const result = await resolveFixture(
      site({ auth: true, chrome: "  header:\n    items: [brand, links, navToggle]" }),
    );
    expect(errorAt(result, "FP1230")?.message).toMatch(/account control/);
  });

  it("accepts leaving out auth when a headerExtra template places it", async () => {
    const result = await resolveFixture(
      site({
        auth: true,
        chrome:
          "  header:\n    items: [brand, links, navToggle]\n  slots:\n    headerExtra: ./t/extra.html",
        files: { "t/extra.html": `<span class="site-account">{% part "auth" %}</span>` },
      }),
    );
    expect(errorAt(result, "FP1230")).toBeUndefined();
    expect(result.model!.customisation!.movedParts).toContain("auth");
  });

  it("refuses leaving out the links while the navigation is header-only", async () => {
    const result = await resolveFixture(
      site({ chrome: "  header:\n    items: [brand, navToggle]" }),
    );
    expect(errorAt(result, "FP1230")?.message).toMatch(/links/);
    const side = await resolveFixture(
      site({
        chrome: "  header:\n    items: [brand, navToggle]",
        navigation: "  placement: side\n  header:\n    - href: /docs/guide/\n      label: Guide",
      }),
    );
    expect(errorAt(side, "FP1230")).toBeUndefined();
  });

  it("refuses a part placed by a template and also listed as an item", async () => {
    const result = await resolveFixture(
      site({
        chrome:
          "  header:\n    items: [brand, links, navToggle, themeToggle]\n  slots:\n    headerExtra: ./t/extra.html",
        files: { "t/extra.html": `{% part "theme-toggle" %}` },
      }),
    );
    expect(errorAt(result, "FP1913")?.pointer).toBe("/chrome/header/items");
  });
});

describe("chrome.footer", () => {
  it("accepts a variant, columns, logos and an order", async () => {
    const result = await resolveFixture(
      site({
        chrome: `  footer:
    variant: columns
    columns: 3
    order: [groups, logos, about]
    logos:
      - src: ./brand/logo.svg
        alt: Partner
        href: https://partner.example.org/`,
        files: {
          "brand/logo.svg": readFileSync(join(MINIMAL_EXAMPLE, "assets", "logo.svg"), "utf8"),
        },
      }),
    );
    expect(result.model!.customisation!.footer).toMatchObject({
      variant: "columns",
      columns: 3,
      order: ["groups", "logos", "about"],
      logos: [{ alt: "Partner", href: "https://partner.example.org/", external: true }],
    });
  });

  it("refuses too many columns and an unknown section", async () => {
    const result = await resolveFixture(
      site({ chrome: "  footer:\n    columns: 9\n    order: [about, sidebar]" }),
    );
    expect(
      result.diagnostics.items.filter((d) => d.code === "FP1104").length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("refuses footer slots on a bar-only footer, and warns about sections a minimal footer drops", async () => {
    const barOnly = await resolveFixture(
      site({
        chrome: "  footer:\n    variant: bar-only\n  slots:\n    footerTop: ./t/top.html",
        files: { "t/top.html": "<p>Funded.</p>" },
      }),
    );
    expect(errorAt(barOnly, "FP1913")?.pointer).toBe("/chrome/slots/footerTop");
    const minimal = await resolveFixture(
      site({ chrome: "  footer:\n    variant: minimal\n    order: [about, groups]" }),
    );
    expect(minimal.diagnostics.items.find((d) => d.code === "FP1233")?.severity).toBe("warning");
  });
});

describe("theme.fonts, tokens and the stylesheet", () => {
  it("publishes a local WOFF2 font as a hashed same-origin file with @font-face", async () => {
    const result = await resolveFixture(
      site({
        theme: `  fonts:
    - family: Site Sans
      src: ./brand/site.woff2
  tokens:
    fontBody: Site Sans
    typeScale: large
    spaceScale: tight
    contentWidth: 1200
    radius: none
    borderWidth: thick
    shadow: none
    dark:
      shadow: strong`,
        files: { "brand/site.woff2": WOFF2 },
      }),
    );
    expect(errorAt(result, "FP1231")).toBeUndefined();
    const model = result.model!;
    const font = model.customisationFiles!.find((f) => f.file.endsWith(".woff2"))!;
    expect(font.file).toMatch(/^_portal\/site\/fonts\/site\.[0-9a-f]{8}\.woff2$/);
    expect(model.inputs.find((i) => i.role === "font")?.path).toBe("brand/site.woff2");
    expect(model.theme.css).toContain('--font-ui: "Site Sans"');
    expect(model.theme.css).toContain("--portal-type-scale: 1.07");
    expect(model.theme.css).toContain("--content-max: 1200px");
    const sheet = model.customisationFiles!.find((f) => f.file.startsWith("_portal/site-style."))!;
    expect(sheet.cacheClass).toBe("immutable");
  });

  it("refuses a font that is not WOFF2, by extension or by content", async () => {
    const byName = await resolveFixture(
      site({
        theme: "  fonts:\n    - family: Site Sans\n      src: ./brand/site.ttf",
        files: { "brand/site.ttf": WOFF2 },
      }),
    );
    expect(errorAt(byName, "FP1231")?.pointer).toBe("/theme/fonts/0/src");
    const byContent = await resolveFixture(
      site({
        theme: "  fonts:\n    - family: Site Sans\n      src: ./brand/site.woff2",
        files: { "brand/site.woff2": "not a font" },
      }),
    );
    expect(errorAt(byContent, "FP1231")).toBeDefined();
  });

  it("refuses a font family name that could break out of the declaration", async () => {
    const result = await resolveFixture(
      site({
        theme: '  fonts:\n    - family: "x\\"; } body { color: red"\n      src: ./brand/site.woff2',
        files: { "brand/site.woff2": WOFF2 },
      }),
    );
    expect(errorAt(result, "FP1104")).toBeDefined();
  });

  it("refuses a stylesheet outside the source root and an unknown profile", async () => {
    const escape = await resolveFixture(
      site({ theme: "  stylesheet:\n    profile: portal-style-v1\n    path: ../outside.css" }),
    );
    expect(
      escape.diagnostics.items.some(
        (d) => d.severity === "error" && d.pointer === "/theme/stylesheet/path",
      ),
    ).toBe(true);
    const profile = await resolveFixture(
      site({
        theme: "  stylesheet:\n    profile: portal-style-v2\n    path: ./site.css",
        files: { "site.css": "" },
      }),
    );
    expect(errorAt(profile, "FP1104")).toBeDefined();
  });

  it("records the stylesheet and templates in the input manifest", async () => {
    const result = await resolveFixture(
      site({
        theme: "  stylesheet:\n    profile: portal-style-v1\n    path: ./brand/site.css",
        chrome: "  slots:\n    footerTop: ./t/top.html",
        files: { "brand/site.css": ".site-a { color: red; }", "t/top.html": "<p>Funded.</p>" },
      }),
    );
    const roles = result.model!.inputs.map((i) => `${i.role}:${i.path}`);
    expect(roles).toContain("stylesheet:brand/site.css");
    expect(roles).toContain("template:t/top.html");
    expect(result.model!.customisationEvidence!.templates[0]).toMatchObject({
      slot: "footerTop",
      source: "t/top.html",
    });
  });

  it("prunes rules for disabled features and records them as evidence", async () => {
    const result = await resolveFixture(
      site({
        data: false,
        theme: "  stylesheet:\n    profile: portal-style-v1\n    path: ./brand/site.css",
        files: {
          "brand/site.css": `[data-part="block-component-search"] { color: red; }\n[data-part="header-search"] { color: red; }\n.site-a { color: blue; }`,
        },
      }),
    );
    const evidence = result.model!.customisationEvidence!.stylesheet!;
    expect(evidence.prunedRules.map((r) => r.features[0])).toEqual(["databrowser", "site-search"]);
    expect(result.diagnostics.items.filter((d) => d.code === "FP1906")).toHaveLength(2);
  });

  it("renders a disabled feature's template part as nothing and records it", async () => {
    const result = await resolveFixture(
      site({
        chrome: "  slots:\n    headerExtra: ./t/extra.html",
        files: { "t/extra.html": `<span class="site-a">{% part "search" %}</span>` },
      }),
    );
    expect(result.model!.customisationEvidence!.templates[0]!.emptyParts).toEqual([
      { part: "search", feature: "site-search" },
    ]);
    expect(result.diagnostics.items.find((d) => d.code === "FP1915")?.severity).toBe("info");
    const home = result.model!.routes.find((r) => r.path === "/")!;
    expect(JSON.stringify(home.slots)).not.toContain('"part":"search"');
  });

  it("scans templates and stylesheets for credentials", async () => {
    const result = await resolveFixture(
      site({
        theme: "  stylesheet:\n    profile: portal-style-v1\n    path: ./brand/site.css",
        chrome: "  slots:\n    footerTop: ./t/top.html",
        files: {
          "brand/site.css": `.site-a::before { content: "api_key=0123456789"; }`,
          "t/top.html": "<p>client_secret: abc</p>",
        },
      }),
    );
    const files = result.diagnostics.items.filter((d) => d.code === "FP1210").map((d) => d.file);
    expect(files).toEqual(expect.arrayContaining(["brand/site.css", "t/top.html"]));
  });
});

describe("landing layout", () => {
  const landing = (blocks: string, layout = "") => `schemaVersion: 1
title: Test
${layout}blocks:
${blocks}`;

  it("places blocks on the 12-column grid with spans that default down the breakpoints", async () => {
    const result = await resolveFixture(
      site({
        landing: landing(
          `  - type: hero
    heading: Hello
    span: { md: 6 }
    width: narrow
    align: center
  - type: callout
    level: note
    body: Hi.
    section: more
    background: accent`,
          "layout:\n  sections:\n    - id: more\n      heading: More\n      background: surface\n",
        ),
      }),
    );
    const home = result.model!.landings[0]!;
    expect(home.layout!.sections).toEqual([
      { id: "more", heading: "More", background: { fill: "surface" } },
    ]);
    expect(home.blocks[0]!.placement).toEqual({
      span: { base: 12, md: 6, lg: 6 },
      width: "narrow",
      align: "center",
    });
    expect(home.blocks[1]!.placement).toMatchObject({
      section: "more",
      background: { fill: "accent" },
    });
  });

  it("refuses an undeclared section and a duplicate section at their pointers", async () => {
    const result = await resolveFixture(
      site({
        landing: landing(
          "  - type: hero\n    heading: Hello\n    section: nowhere\n",
          "layout:\n  sections:\n    - id: a\n    - id: a\n",
        ),
      }),
    );
    expect(errorAt(result, "FP1201")?.pointer).toBe("/blocks/0/section");
    expect(errorAt(result, "FP1208")?.pointer).toBe("/layout/sections/1/id");
  });

  it("refuses a span outside 1-12", async () => {
    const result = await resolveFixture(
      site({ landing: landing("  - type: hero\n    heading: Hello\n    span: { lg: 13 }\n") }),
    );
    expect(errorAt(result, "FP1104")).toBeDefined();
  });
});

describe("action intents", () => {
  const hero = (action: string) => `schemaVersion: 1
title: Test
blocks:
  - type: hero
    heading: Hello
    actions:
${action}`;

  it("serializes select-facet and open-dataset into the Data Browser's search intent", async () => {
    const result = await resolveFixture(
      site({
        landing: hero(`      - label: Rain
        intent: select-facet
        component: data
        facets: { variable: pr }
      - label: One dataset
        intent: open-dataset
        component: data
        dataset: reanalysis-daily`),
      }),
    );
    const actions = result.model!.landings[0]!.blocks[0]!.actions!;
    expect(actions[0]!.href).toMatch(/^\/data\/\?/);
    expect(decodeURIComponent(actions[0]!.href)).toContain("pr");
    // The free text is the Data Browser's file glob, with its own escaping.
    expect(decodeURIComponent(actions[1]!.href)).toMatch(/file=\*reanalysis\\?-daily\*/);
  });

  it("omits an intent whose component is disabled, with an info diagnostic", async () => {
    const result = await resolveFixture(
      site({
        data: false,
        landing: hero(`      - label: Rain
        intent: select-facet
        component: data
        facets: { variable: pr }`),
      }),
    );
    expect(result.model!.landings[0]!.blocks[0]!.actions ?? []).toEqual([]);
    expect(result.diagnostics.items.find((d) => d.code === "FP1202")?.severity).toBe("info");
  });

  it("refuses an intent aimed at a component of the wrong kind", async () => {
    const result = await resolveFixture(
      site({
        auth: true,
        landing: hero(`      - label: Rain
        intent: select-facet
        component: login
        facets: { variable: pr }`),
      }),
    );
    expect(errorAt(result, "FP1232")).toBeDefined();
  });

  it("refuses an unknown example and a mix of intent and href", async () => {
    const unknown = await resolveFixture(
      site({
        landing: hero(`      - label: Run
        intent: run-example
        example: "content:docs/guide.md#9"`),
      }),
    );
    expect(errorAt(unknown, "FP1201")).toBeDefined();
    const mixed = await resolveFixture(
      site({
        landing: hero(`      - label: Rain
        href: /x/
        intent: select-facet
        facets: { variable: pr }`),
      }),
    );
    expect(errorAt(mixed, "FP1104")).toBeDefined();
  });
});

describe("review findings", () => {
  it("refuses a build whose output tree holds a customisation source, before writing", async () => {
    const root = site({
      theme: "  stylesheet:\n    profile: portal-style-v1\n    path: ./output/site.css",
      files: { "output/site.css": ".site-a { color: red; }" },
    });
    const result = await buildSite({
      sourceRoot: canonicalizeRoot(root),
      configPath: join(root, "portal.yaml"),
      outDir: join(root, "output"),
      quiet: true,
    });
    expect(result.outDir).toBeUndefined();
    expect(codes(result.diagnostics)).toContain("FP1003");
    expect(readFileSync(join(root, "output", "site.css"), "utf8")).toContain(".site-a");
  });

  it.each([
    ["a font", "  fonts:\n    - family: Site Sans\n      src: ./output/site.woff2"],
    ["a template", ""],
  ])("refuses an output tree that holds %s", async (name, theme) => {
    const root = site({
      ...(theme ? { theme } : { chrome: "  slots:\n    footerTop: ./output/top.html" }),
      files: { "output/site.woff2": WOFF2, "output/top.html": "<p>Funded.</p>" },
    });
    const result = await resolveFixture(root, { outDir: join(root, "output") });
    expect(codes(result.diagnostics), name).toContain("FP1003");
  });

  it("refuses an output tree that holds an image a stylesheet references", async () => {
    const root = site({
      theme: "  stylesheet:\n    profile: portal-style-v1\n    path: ./brand/site.css",
      files: {
        "brand/site.css": '.site-a { background-image: url("../output/wave.svg"); }',
        "output/wave.svg": readFileSync(join(MINIMAL_EXAMPLE, "assets", "logo.svg"), "utf8"),
      },
    });
    const out = join(root, "output");
    const result = await buildSite({
      sourceRoot: canonicalizeRoot(root),
      configPath: join(root, "portal.yaml"),
      outDir: out,
      quiet: true,
    });
    expect(result.outDir).toBeUndefined();
    expect(codes(result.diagnostics)).toContain("FP1003");
    expect(existsSync(join(out, "wave.svg"))).toBe(true);
  });

  it("refuses footerColumns where the footer has no link groups, and keeps the legal links", async () => {
    for (const footer of ["    variant: minimal", "    order: [about, legal]"]) {
      const result = await resolveFixture(
        site({
          chrome: `  footer:\n${footer}\n    legalLinks:\n      - label: Privacy\n        href: https://example.org/privacy/\n  slots:\n    footerColumns: ./t/cols.html`,
          files: { "t/cols.html": '<div class="site-c">{% part "legal-links" %}</div>' },
        }),
      );
      expect(errorAt(result, "FP1913")?.pointer, footer).toBe("/chrome/slots/footerColumns");
    }
  });

  it("moves the legal links only out of a footer slot that renders", async () => {
    const result = await resolveFixture(
      site({
        chrome:
          "  footer:\n    legalLinks:\n      - label: Privacy\n        href: https://example.org/privacy/\n  slots:\n    footerBottom: ./t/bottom.html",
        files: { "t/bottom.html": '<div class="site-c">{% part "legal-links" %}</div>' },
      }),
    );
    expect(result.model!.customisation!.movedParts).toContain("legal-links");
  });

  it("accepts a fragment link to an element on every page, and refuses any other", async () => {
    const ok = await resolveFixture(
      site({
        chrome: "  slots:\n    footerTop: ./t/top.html",
        files: { "t/top.html": '<p><a href="#portal-main">Content</a> <a href="#top">Top</a></p>' },
      }),
    );
    expect(errorAt(ok, "FP1917")).toBeUndefined();
    const home = ok.model!.routes.find((r) => r.path === "/")!;
    expect(JSON.stringify(home.slots)).toContain('href=\\"#portal-main\\"');
    const bad = await resolveFixture(
      site({
        chrome: "  slots:\n    footerTop: ./t/top.html",
        files: { "t/top.html": '<p><a href="#nowhere">Gone</a></p>' },
      }),
    );
    expect(errorAt(bad, "FP1917")?.file).toBe("t/top.html");
  });

  it("does not publish a remote URL as an image through a template field", async () => {
    const root = site({
      chrome: "  slots:\n    footerTop: ./t/top.html",
      files: { "t/top.html": '<p><img src="{{ site.institution.url }}" alt="Logo"></p>' },
    });
    const config = readFileSync(join(root, "portal.yaml"), "utf8");
    write(
      root,
      "portal.yaml",
      config.replace(
        "  title: Test Site\n",
        "  title: Test Site\n  institution:\n    name: Centre\n    url: https://cdn.example.org/logo.png\n",
      ),
    );
    const result = await resolveFixture(root);
    expect(errorAt(result, "FP1912")?.file).toBe("t/top.html");
  });

  it("builds a slot template with a <picture> over the header logo's variants", async () => {
    const logo = readFileSync(join(MINIMAL_EXAMPLE, "assets", "logo.svg"), "utf8");
    const root = site({
      chrome: `  header:
    logo:
      src: ./brand/logo.svg
      dark: ./brand/logo-dark.svg
      alt: Brand
  slots:
    footerTop: ./t/top.html`,
      files: {
        "brand/logo.svg": logo,
        "brand/logo-dark.svg": logo.replace("#1f6f8b", "#9fd3e6"),
        "t/top.html": `<picture>
  <source media="(prefers-color-scheme: dark)" srcset="{{ logo.dark }}">
  <img src="{{ logo.src }}" alt="Logo">
</picture>`,
      },
    });
    const out = join(tempRoot("portal-picture-"), "site");
    const result = await buildSite({
      sourceRoot: canonicalizeRoot(root),
      configPath: join(root, "portal.yaml"),
      outDir: out,
      quiet: true,
    });
    expect(
      result.diagnostics.items.filter((d) => d.severity === "error").map((d) => d.code),
    ).toEqual([]);
    const home = readFileSync(join(out, "index.html"), "utf8");
    expect(home).toMatch(
      /<source media="\(prefers-color-scheme: dark\)" srcset="\/_portal\/site\/logo-dark\.[0-9a-f]{8}\.svg"/,
    );
    expect(home).toMatch(/<img src="\/_portal\/site\/logo\.[0-9a-f]{8}\.svg" alt="Logo"/);
  });

  it("refuses an item between links and the menu button, which form one landmark", async () => {
    const apart = await resolveFixture(
      site({ auth: true, chrome: "  header:\n    items: [brand, links, auth, navToggle]" }),
    );
    expect(errorAt(apart, "FP1234")?.pointer).toBe("/chrome/header/items");
    const together = await resolveFixture(
      site({ auth: true, chrome: "  header:\n    items: [brand, navToggle, links, auth]" }),
    );
    expect(errorAt(together, "FP1234")).toBeUndefined();
  });
});
