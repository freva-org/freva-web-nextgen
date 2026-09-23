// The framework repository holds generic software and fictional fixtures. A test cannot know
// whether a logo belongs to a real institute; what it can do is hold the boundary that makes the
// mistake hard: site inputs exist only under `examples/`, those examples are declared fictional,
// and no theme preset carries a project's name, endpoint or asset.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../helpers/fixture.js";
import { THEME_PRESETS } from "../../src/themes/registry.js";

const IGNORED = new Set([
  "node_modules",
  ".git",
  "dist",
  "dist-test",
  "build",
  "coverage",
  "materials",
  ".upstream",
  ".astro",
  "reports",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(relative(REPO_ROOT, full));
  }
  return out;
}

describe("the framework repository", () => {
  const files = walk(REPO_ROOT);

  it("contains site configuration only under examples/", () => {
    const configs = files.filter((f) => f.endsWith("portal.yaml"));
    expect(configs.length).toBeGreaterThan(0);
    for (const config of configs) {
      expect(config.startsWith("examples/")).toBe(true);
    }
  });

  it("declares every example site as fictional", () => {
    for (const example of readdirSync(join(REPO_ROOT, "examples"))) {
      const readme = join(REPO_ROOT, "examples", example, "README.md");
      expect(existsSync(readme)).toBe(true);
      expect(readFileSync(readme, "utf8").toLowerCase()).toContain("fictional");
    }
  });

  it("uses example.org for every site identity, so no real hostname is implied", () => {
    for (const config of files.filter((f) => f.endsWith("portal.yaml"))) {
      const text = readFileSync(join(REPO_ROOT, config), "utf8");
      const urls = [...text.matchAll(/https:\/\/([a-z0-9.-]+)/g)].map((m) => m[1]!);
      for (const host of urls) {
        expect(host.endsWith("example.org")).toBe(true);
      }
    }
  });

  it("keeps theme presets free of names, endpoints, assets and feature choices", () => {
    for (const [name, preset] of Object.entries(THEME_PRESETS)) {
      const serialized = JSON.stringify(preset);
      expect(serialized).not.toMatch(/https?:\/\//);
      expect(serialized).not.toMatch(/\.(svg|png|ico|woff2?)/);
      expect(serialized).not.toMatch(/enabled|route|service|component/i);
      // A preset's own name is the only project-shaped word allowed in it.
      const words = serialized.toLowerCase().replace(new RegExp(name, "g"), "");
      expect(words).not.toContain("freva-web");
      expect(words).not.toContain("institute");
    }
  });

  // `scripts/bootstrap.mjs` has to build a workspace package before anything that imports it.
  // Every workspace package here is consumed from its `dist/`, and a clean extraction has none,
  // because `npm ci` links the workspaces but runs no build. So the script's `BUILD_ORDER` is a
  // topological order, and a missing or late entry is not a slow build but a fresh clone that
  // cannot be bootstrapped at all - invisible in a working checkout, which already has the
  // `dist/` on disk. This reads the list out of the script and checks it against the real
  // dependency graph, so a new workspace dependency cannot be added without being ordered.
  it("builds every workspace dependency before the package that imports it", () => {
    const script = readFileSync(join(REPO_ROOT, "scripts", "bootstrap.mjs"), "utf8");
    const block = /const BUILD_ORDER = \[([\s\S]*?)\];/.exec(script);
    expect(block, "BUILD_ORDER is no longer a literal array in bootstrap.mjs").not.toBeNull();
    const order = [...block![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    expect(order.length).toBeGreaterThan(1);

    // Where each workspace package lives, by its published name.
    const locations = new Map<string, string>();
    for (const dir of readdirSync(join(REPO_ROOT, "packages"))) {
      const manifest = join(REPO_ROOT, "packages", dir, "package.json");
      if (!existsSync(manifest)) continue;
      const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string };
      if (parsed.name) locations.set(parsed.name, manifest);
    }

    // Workspace packages that need no build. `@freva-org/freva-badge` ships a committed `dist/`
    // - artwork and a vendored runtime replaced wholesale rather than compiled - and its `build`
    // script says so. An explicit list rather than a git query, because this has to hold in an
    // extracted archive with no `.git` at all.
    const VENDORED_DIST = new Set(["@freva-org/freva-badge"]);

    for (const [index, name] of order.entries()) {
      const manifest = locations.get(name);
      expect(manifest, `${name} is in BUILD_ORDER but is not a workspace package`).toBeDefined();
      const parsed = JSON.parse(readFileSync(manifest!, "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const dependencies = Object.keys({ ...parsed.dependencies, ...parsed.devDependencies });
      for (const dependency of dependencies) {
        if (!locations.has(dependency) || VENDORED_DIST.has(dependency)) continue;
        const at = order.indexOf(dependency);
        expect(
          at,
          `${name} depends on ${dependency}, which bootstrap.mjs never builds`,
        ).toBeGreaterThanOrEqual(0);
        expect(
          `${dependency} before ${name}: ${at < index}`,
          `${name} is built before its dependency ${dependency}`,
        ).toBe(`${dependency} before ${name}: true`);
      }
    }
  });

  it("keeps the example sites small enough to read", () => {
    for (const file of files.filter((f) => f.startsWith("examples/"))) {
      const size = statSync(join(REPO_ROOT, file)).size;
      expect(`${file}: ${size < 200_000}`).toBe(`${file}: true`);
    }
  });
});
