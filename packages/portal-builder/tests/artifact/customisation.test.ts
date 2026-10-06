// The customisation capabilities, end to end on the two fixture portals (examples/centre-a and
// examples/centre-b): what they publish is hashed, listed, checksummed and verified; the policy is
// the one the same portal has without them; the evidence records what was pruned or left empty;
// two builds are identical; a rejected stylesheet leaves the previous artifact in place; and a
// portal that uses none of it publishes nothing of it.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postcss from "postcss";
import { parse, stringify } from "yaml";
import { buildSite } from "../../src/artifact/index.js";
import { canonicalizeRoot } from "../../src/config/paths.js";
import { verifyArtifact } from "../../src/verify/verify.js";
import { buildFixture, STAC_MATERIALS, writeMatrixSite } from "../helpers/site.js";
import {
  cleanupFixtures,
  codes,
  MINIMAL_EXAMPLE,
  REPO_ROOT,
  tempRoot,
} from "../helpers/fixture.js";

afterAll(cleanupFixtures);

const CENTRE_A = join(REPO_ROOT, "examples", "centre-a");
const CENTRE_B = join(REPO_ROOT, "examples", "centre-b");

async function build(root: string, out: string) {
  return buildSite({
    sourceRoot: canonicalizeRoot(root),
    configPath: join(root, "portal.yaml"),
    outDir: out,
    quiet: true,
    release: true,
    sourceDateEpoch: 1_760_000_000,
  });
}

function listFiles(dir: string, prefix = ""): string[] {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? listFiles(dir, path) : [path];
  });
}

const json = (dir: string, name: string) => JSON.parse(readFileSync(join(dir, name), "utf8"));
const html = (dir: string) => listFiles(dir).filter((f) => f.endsWith(".html"));

/** A copy of a fixture with every customisation option taken out. */
function plainCopy(source: string): string {
  const root = tempRoot("portal-plain-");
  cpSync(source, root, { recursive: true });
  const config = parse(readFileSync(join(root, "portal.yaml"), "utf8"));
  for (const key of ["variant", "sticky", "transparentOverHero", "logo", "items"]) {
    delete config.chrome?.header?.[key];
  }
  for (const key of ["variant", "columns", "logos", "order"]) delete config.chrome?.footer?.[key];
  delete config.chrome?.slots;
  delete config.theme.stylesheet;
  delete config.theme.fonts;
  for (const key of ["fontBody", "fontHeading", "fontMono", "typeScale", "spaceScale"]) {
    delete config.theme.tokens?.[key];
  }
  for (const key of ["contentWidth", "radius", "borderWidth", "shadow"]) {
    delete config.theme.tokens?.[key];
  }
  delete config.navigation?.placement;
  writeFileSync(join(root, "portal.yaml"), stringify(config));
  const landingPath = join(root, "landings", "home.yaml");
  const landing = parse(readFileSync(landingPath, "utf8"));
  delete landing.layout;
  for (const block of landing.blocks) {
    for (const key of ["section", "span", "width", "align", "background"]) delete block[key];
  }
  writeFileSync(landingPath, stringify(landing));
  return root;
}

let outA = "";
let outB = "";
let outPlainA = "";
let outMinimal = "";

beforeAll(async () => {
  const work = tempRoot("portal-custom-art-");
  outA = join(work, "a");
  outB = join(work, "b");
  outPlainA = join(work, "plain-a");
  outMinimal = join(work, "minimal");
  for (const [root, out] of [
    [CENTRE_A, outA],
    [CENTRE_B, outB],
    [plainCopy(CENTRE_A), outPlainA],
    [MINIMAL_EXAMPLE, outMinimal],
  ] as const) {
    const result = await build(root, out);
    expect(result.outDir, `${root}: ${codes(result.diagnostics).join(", ")}`).toBe(out);
  }
}, 600_000);

describe("the published customisation files", () => {
  it("hashes the site stylesheet by its content and links it after the framework's stylesheets", () => {
    for (const out of [outA, outB]) {
      const sheets = listFiles(out).filter((f) =>
        /^_portal\/site-style\.[0-9a-f]{8}\.css$/.test(f),
      );
      expect(sheets).toHaveLength(1);
      const bytes = readFileSync(join(out, sheets[0]!));
      const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 8);
      expect(sheets[0]).toBe(`_portal/site-style.${hash}.css`);
      expect(bytes.toString("utf8")).toMatch(/^@layer portal-framework, portal-site;/);
      for (const page of html(out)) {
        const text = readFileSync(join(out, page), "utf8");
        const links = [...text.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map(
          (m) => m[1]!,
        );
        expect(links.at(-1), page).toMatch(new RegExp(`/${sheets[0]!.replace(/\./g, "\\.")}$`));
      }
    }
  });

  it("puts every compiled framework stylesheet in the framework layer", () => {
    for (const file of listFiles(outA).filter((f) => /^_portal\/.*\.css$/.test(f))) {
      if (file.includes("site-style")) continue;
      expect(readFileSync(join(outA, file), "utf8"), file).toMatch(/^@layer portal-framework\{/);
    }
  });

  it("publishes fonts and images as hashed same-origin files, listed and checksummed", () => {
    const manifest = json(outB, "portal-manifest.json");
    const checksums = readFileSync(join(outB, "checksums.sha256"), "utf8");
    const published = listFiles(outB).filter((f) => f.startsWith("_portal/site"));
    expect(
      published.some((f) => /^_portal\/site\/fonts\/poppins-regular\.[0-9a-f]{8}\.woff2$/.test(f)),
    ).toBe(true);
    for (const file of published) {
      const entry = manifest.files.find((f: { path: string }) => f.path === file);
      expect(entry, file).toBeDefined();
      expect(entry.cacheClass).toBe("immutable");
      expect(checksums).toContain(`  ${file}\n`);
    }
    const font = manifest.files.find((f: { path: string }) => f.path.endsWith(".woff2"));
    expect(font.mimeType).toBe("font/woff2");
  });

  it("records the stylesheet, the templates, the fonts and the images as inputs", () => {
    const inputs = json(outB, "input-manifest.json").sources as {
      ref: { path?: string };
      role: string;
    }[];
    const byRole = (role: string) => inputs.filter((i) => i.role === role).map((i) => i.ref.path);
    expect(byRole("stylesheet")).toEqual(["brand/site.css"]);
    expect(byRole("font").sort()).toEqual([
      "brand/poppins-bold.woff2",
      "brand/poppins-regular.woff2",
    ]);
    expect(byRole("template").sort()).toEqual([
      "templates/aside.html",
      "templates/footer-bottom.html",
      "templates/footer-top.html",
      "templates/header-extra.html",
      "templates/section.html",
    ]);
    const a = json(outA, "input-manifest.json").sources as {
      ref: { path?: string };
      role: string;
    }[];
    expect(a.filter((i) => i.role === "customisation-asset").length).toBeGreaterThanOrEqual(6);
  });

  it("verifies", () => {
    for (const out of [outA, outB]) expect(verifyArtifact(out).errors).toEqual([]);
  });
});

describe("the policy", () => {
  it("is exactly the policy of the same portal without customisation", () => {
    expect(json(outA, "host-policy.json").csp).toEqual(json(outPlainA, "host-policy.json").csp);
  });

  it("adds no inline style, no style attribute and no inline script", () => {
    for (const out of [outA, outB]) {
      for (const page of html(out)) {
        const text = readFileSync(join(out, page), "utf8");
        expect(text, page).not.toMatch(/<style[\s>]/);
        expect(text, page).not.toMatch(/\sstyle="/);
      }
    }
    const scripts = (out: string) =>
      html(out).flatMap((page) =>
        [...readFileSync(join(out, page), "utf8").matchAll(/<script(?![^>]*\ssrc=)[^>]*>/g)].map(
          (m) => m[0],
        ),
      );
    expect(new Set(scripts(outA))).toEqual(new Set(scripts(outPlainA)));
  });

  it("references no other origin from the site stylesheet or the slot markup", () => {
    for (const out of [outA, outB]) {
      const sheet = listFiles(out).find((f) => f.startsWith("_portal/site-style."))!;
      const urls = [...readFileSync(join(out, sheet), "utf8").matchAll(/url\("?([^")]+)"?\)/g)].map(
        (m) => m[1]!,
      );
      expect(urls.length).toBeGreaterThan(0);
      for (const url of urls) expect(url, url).toMatch(/^\/[^/]/);
      for (const page of html(out)) {
        const text = readFileSync(join(out, page), "utf8");
        for (const m of text.matchAll(/\s(?:src|srcset)="([^"]+)"/g)) {
          expect(m[1], `${page}: ${m[1]}`).toMatch(/^\/[^/]/);
        }
      }
    }
  });
});

describe("the evidence", () => {
  it("records pruned stylesheet rules and the slot templates", () => {
    const evidence = json(outB, "component-evidence.json").customisation;
    expect(evidence.stylesheet.source).toBe("brand/site.css");
    expect(evidence.stylesheet.file).toMatch(/^_portal\/site-style\.[0-9a-f]{8}\.css$/);
    expect(evidence.stylesheet.prunedRules).toEqual([
      { selector: '[data-part="block-dataset-tree"]', features: ["dataset-tree"], line: 36 },
    ]);
    expect(evidence.templates.map((t: { slot: string }) => t.slot)).toEqual([
      "headerExtra",
      "footerTop",
      "footerBottom",
      "landingSectionShell",
      "proseAside",
    ]);
    const sheet = readFileSync(join(outB, evidence.stylesheet.file), "utf8");
    expect(sheet).not.toContain("block-dataset-tree");
  });

  it("is absent on a portal that uses no customisation", () => {
    expect(json(outMinimal, "component-evidence.json").customisation).toBeUndefined();
  });
});

describe("the rendered fixtures", () => {
  it("A: centred sticky logo header, transparent over the hero, a columns footer with logos", () => {
    const home = readFileSync(join(outA, "index.html"), "utf8");
    expect(home).toMatch(/<html[^>]*data-portal-header="centered"/);
    expect(home).toMatch(/<html[^>]*data-portal-overlay="hero"/);
    expect(home).not.toMatch(/data-portal-sticky=/);
    expect(home).toContain('data-part="header-logo"');
    expect(home).toContain('data-portal-theme-only="dark"');
    expect(home).toMatch(/<footer[^>]*data-variant="columns"[^>]*data-columns="4"/);
    expect((home.match(/data-part="footer-logo"/g) ?? []).length).toBe(4);
    expect((home.match(/data-part="block"/g) ?? []).length).toBe(6);
    expect(home).toContain('data-span-lg="4"');
    const guide = readFileSync(join(outA, "docs", "guide", "index.html"), "utf8");
    expect(guide).not.toMatch(/data-portal-overlay/);
  });

  it("B: split header with side navigation, a minimal footer from templates, a laid-out landing", () => {
    const home = readFileSync(join(outB, "index.html"), "utf8");
    expect(home).toMatch(/<html[^>]*data-portal-nav="side"/);
    expect(home).toContain('data-part="side-nav"');
    expect(home).toContain('data-portal-links="hidden"');
    expect(home).toMatch(/<footer[^>]*data-variant="minimal"/);
    expect(home).toContain("Funding.");
    expect(home).toContain("1 Harbour Road");
    expect(home).toContain("© 2025 Centre B Observatory");
    // The theme toggle moved into headerExtra, once.
    expect((home.match(/class="portal-theme-toggle"/g) ?? []).length).toBe(1);
    expect(home).toMatch(/data-part="header-extra"[\s\S]*portal-theme-toggle/);
    // Legal links placed by footerBottom are not repeated.
    expect((home.match(/data-part="footer-legal"/g) ?? []).length).toBe(1);
    // The search block comes before the hero, and the hero is the page's one h1.
    expect(home.indexOf('data-part="block-component-search"')).toBeLessThan(
      home.indexOf('data-part="block-hero"'),
    );
    expect((home.match(/<h1[\s>]/g) ?? []).length).toBe(1);
    expect(home).toContain('class="site-section-title"');
    const methods = readFileSync(join(outB, "docs", "methods", "index.html"), "utf8");
    expect(methods).toContain('data-part="prose-aside"');
    expect(methods).toContain('<a href="#quality-control">Quality control</a>');
  });

  it("protected controls are present on every route", () => {
    for (const out of [outA, outB]) {
      for (const page of html(out).filter((p) => !/^\d{3}\.html$/.test(p))) {
        const text = readFileSync(join(out, page), "utf8");
        expect(text, page).toContain('data-part="skip-link"');
        expect(text, page).toContain('data-part="nav-toggle"');
        expect(text, page).toContain('data-part="header-auth"');
        expect(text, page).toContain('data-part="main"');
      }
    }
  });
});

describe("a portal without customisation", () => {
  it("publishes none of it", () => {
    const files = listFiles(outMinimal);
    expect(files.some((f) => f.includes("site-style") || f.startsWith("_portal/site/"))).toBe(
      false,
    );
    for (const file of files.filter((f) => f.endsWith(".css"))) {
      expect(readFileSync(join(outMinimal, file), "utf8"), file).not.toContain("@layer portal");
      expect(readFileSync(join(outMinimal, file), "utf8"), file).not.toContain("portal-grid");
    }
    for (const page of html(outMinimal)) {
      const text = readFileSync(join(outMinimal, page), "utf8");
      expect(text, page).not.toMatch(/data-part=|data-portal-header=|portal-sidenav/);
    }
  });
});

describe("reproducibility and failure", () => {
  it("builds B twice to the same bytes", async () => {
    const again = join(tempRoot("portal-custom-again-"), "b");
    const result = await build(CENTRE_B, again);
    expect(result.outDir).toBe(again);
    expect(readFileSync(join(again, "checksums.sha256"), "utf8")).toBe(
      readFileSync(join(outB, "checksums.sha256"), "utf8"),
    );
  }, 300_000);

  it("leaves the previous artifact in place when the stylesheet is rejected", async () => {
    const root = tempRoot("portal-custom-bad-");
    cpSync(CENTRE_A, root, { recursive: true });
    const out = join(tempRoot("portal-custom-atomic-"), "site");
    expect((await build(root, out)).outDir).toBe(out);
    const before = readFileSync(join(out, "checksums.sha256"), "utf8");
    writeFileSync(
      join(root, "brand", "site.css"),
      `@import url("https://cdn.example.org/x.css");\n`,
    );
    const result = await build(root, out);
    expect(result.outDir).toBeUndefined();
    const diagnostic = result.diagnostics.items.find((d) => d.code === "FP1903")!;
    expect(diagnostic.file).toBe("brand/site.css");
    expect(diagnostic.position).toEqual({ line: 1, column: 1 });
    expect(readFileSync(join(out, "checksums.sha256"), "utf8")).toBe(before);
    expect(existsSync(`${out}.backup`)).toBe(false);
  }, 300_000);

  it("refuses a template that tries to run script, before anything is written", async () => {
    const root = tempRoot("portal-custom-script-");
    cpSync(CENTRE_B, root, { recursive: true });
    mkdirSync(join(root, "templates"), { recursive: true });
    writeFileSync(
      join(root, "templates", "footer-top.html"),
      `<p class="site-funding"><img src="./x.svg" alt="" onerror="alert(1)"></p>\n`,
    );
    const out = join(tempRoot("portal-custom-script-out-"), "site");
    const result = await build(root, out);
    expect(codes(result.diagnostics)).toContain("FP1914");
    expect(existsSync(out)).toBe(false);
  }, 300_000);
});

/** Whether a rule sits inside an `@layer` block. */
function insideLayer(rule: postcss.Rule): boolean {
  for (let node: postcss.Node | undefined = rule.parent; node; node = node.parent as postcss.Node) {
    if (node.type === "atrule" && (node as postcss.AtRule).name === "layer") return true;
  }
  return false;
}

describe("third-party styles beside a layered framework", () => {
  it.skipIf(!STAC_MATERIALS)(
    "puts STAC's stylesheets and the tree's adopted sheet in the framework layer, and keeps the Data Browser host sheet beside its runtime styles",
    async () => {
      const root = writeMatrixSite({
        databrowser: true,
        stac: true,
        auth: false,
        datasetTree: true,
      });
      writeFileSync(join(root, "site.css"), '[data-part="card"] { color: #123456; }\n');
      const config = readFileSync(join(root, "portal.yaml"), "utf8");
      writeFileSync(
        join(root, "portal.yaml"),
        config.replace(
          "  preset: default",
          "  preset: default\n  stylesheet:\n    profile: portal-style-v1\n    path: ./site.css",
        ),
      );
      const out = join(tempRoot("portal-layers-"), "site");
      const result = await buildFixture(root, out);
      expect(result.outDir, codes(result.diagnostics).join(", ")).toBe(out);
      const files = listFiles(out);

      // Upstream STAC, copied: in the framework layer, where freva-stac.css is.
      const stacSheets = files.filter((f) => f.startsWith("stac/") && f.endsWith(".css"));
      expect(stacSheets.length).toBeGreaterThan(0);
      for (const sheet of stacSheets) {
        expect(readFileSync(join(out, sheet), "utf8"), sheet).toMatch(
          /^@layer portal-framework ?\{/m,
        );
      }

      // The Data Browser host rules: unlayered, beside the stylesheet the package injects.
      const compiled = files.filter(
        (f) => /^_portal\/.*\.css$/.test(f) && !f.includes("site-style"),
      );
      const hostRules = compiled.flatMap((file) => {
        const found: { file: string; layered: boolean }[] = [];
        postcss.parse(readFileSync(join(out, file), "utf8")).walkRules((rule) => {
          if (!rule.selector.includes("#portal-databrowser-mount .freva-db")) return;
          found.push({ file, layered: insideLayer(rule) });
        });
        return found;
      });
      expect(hostRules.length).toBeGreaterThan(0);
      expect(hostRules.every((r) => !r.layered)).toBe(true);
      // freva-stac.css itself, compiled, is layered.
      const stacHost = compiled.some((file) => {
        let layered = false;
        postcss.parse(readFileSync(join(out, file), "utf8")).walkRules((rule) => {
          if (rule.selector.includes("stac-browser-mount") && insideLayer(rule)) layered = true;
        });
        return layered;
      });
      expect(stacHost).toBe(true);

      // The dataset tree's `?inline` sheet travels inside its island chunk, layered.
      const treeChunk = files
        .filter((f) => f.startsWith("_portal/") && f.endsWith(".js"))
        .map((f) => readFileSync(join(out, f), "utf8"))
        .find((code) => code.includes(".dataset-tree") && code.includes("adoptedStyleSheets"));
      expect(treeChunk).toBeDefined();
      expect(treeChunk).toContain("@layer portal-framework");
      expect(verifyArtifact(out).errors).toEqual([]);
    },
    300_000,
  );
});
