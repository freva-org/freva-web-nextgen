// The bill of materials, checked against the things it claims to describe. A hand-written list of
// which DIRECT dependencies a reader receives fails silently: a name that is not a dependency of
// this package never appears in the output, and packages that demonstrably ship bytes - the
// dataset tree, imported by the browser sources, and the footer badge, whose `dist/` the builder
// copies into every artifact - go missing.
//
// These tests do not re-derive the list, because "which packages reach a reader" is a fact about
// the code and a script that guessed it would be a second opinion rather than an answer. They
// check the written list against the two places the answer is visible: what the browser sources
// import, and what each component says it owns.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { PACKAGE_ROOT } from "../../src/util/package.js";
import { COMPONENT_REGISTRY } from "../../src/components/registry.js";

interface Component {
  name: string;
  version: string;
  license: string;
  distributed: boolean;
  role: string;
}

let inventory: { components: Component[] };
let sbom: { components: { name: string; version: string; scope?: string; description?: string }[] };

beforeAll(() => {
  // Regenerated rather than read from a committed copy: a report that is only checked when
  // somebody remembers to run it is not a control.
  execFileSync(process.execPath, [join(PACKAGE_ROOT, "scripts", "sbom.mjs")], { stdio: "ignore" });
  inventory = JSON.parse(
    readFileSync(join(PACKAGE_ROOT, "reports", "licenses.json"), "utf8"),
  ) as typeof inventory;
  sbom = JSON.parse(
    readFileSync(join(PACKAGE_ROOT, "reports", "sbom.cdx.json"), "utf8"),
  ) as typeof sbom;
}, 120_000);

/** Bare package specifiers imported by code that runs in a reader's browser. */
function browserImports(): Set<string> {
  const found = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|js|astro|vue)$/.test(entry)) continue;
      // Comments first: a sentence containing "from" followed by a quoted phrase is not an
      // import statement.
      const source = readFileSync(full, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|\s)\/\/.*$/gm, "$1");
      const specifiers = [
        ...source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"'.][^"']*)["']/gm),
        ...source.matchAll(/\bimport\(\s*["']([^"'.][^"']*)["']\s*\)/g),
      ];
      for (const match of specifiers) {
        const specifier = match[1]!;
        if (specifier.startsWith("node:") || specifier.startsWith("virtual:")) continue;
        // The package name, not the subpath: `@scope/name/entry` is one package.
        const parts = specifier.split("/");
        found.add(specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!);
      }
    }
  };
  for (const dir of ["client", "astro/src"]) {
    const full = join(PACKAGE_ROOT, ...dir.split("/"));
    if (existsSync(full)) walk(full);
  }
  return found;
}

describe("what the inventory says a reader receives", () => {
  it("covers every package the browser sources import", () => {
    const distributed = new Set(
      inventory.components.filter((c) => c.distributed).map((c) => c.name),
    );
    const missing = [...browserImports()].filter((name) => !distributed.has(name));
    expect(missing, `imported by browser code but not marked distributed: ${missing}`).toEqual([]);
  });

  it("covers every npm package a component declares that it owns", () => {
    const distributed = new Set(
      inventory.components.filter((c) => c.distributed).map((c) => c.name),
    );
    const owned = new Set<string>();
    for (const registration of Object.values(COMPONENT_REGISTRY)) {
      for (const root of registration.ownedModuleRoots) {
        if (!root.startsWith("pkg:npm/")) continue;
        owned.add(decodeURIComponent(root.slice("pkg:npm/".length)));
      }
    }
    expect(owned.size).toBeGreaterThan(0);
    const missing = [...owned].filter((name) => !distributed.has(name));
    expect(missing, `declared by a component but not marked distributed: ${missing}`).toEqual([]);
  });

  it("reaches past the direct dependencies", () => {
    // Why the lockfile is resolved: a package received only because something else pulls it in
    // is still a package received.
    const transitive = inventory.components.filter(
      (c) => c.distributed && c.role.startsWith("reached from"),
    );
    expect(transitive.length).toBeGreaterThan(0);
    // `jquery` is nobody's direct dependency here and every reader who opens the Python
    // playground receives it. A direct dependency that is nonetheless distributed is a separate
    // case, asserted below.
    expect(transitive.map((c) => c.name)).toContain("jquery");
  });

  it("does not describe a distributed package as build-time only", () => {
    // A direct dependency can be distributed without being a named root, reaching an artifact
    // because another root pulls it in. Flagging it distributed while calling it build-time only
    // is a row that contradicts itself.
    for (const component of inventory.components) {
      if (!component.distributed) continue;
      expect(component.role, `${component.name} is distributed and says otherwise`).not.toContain(
        "not distributed to a reader",
      );
    }
  });

  it("does not claim that build-time tooling reaches a reader", () => {
    // These run during a build and produce markup or bytes; none is shipped. Marking a build
    // tool as distributed is the opposite failure and just as misleading.
    for (const name of ["astro", "mermaid", "shiki", "playwright", "typescript", "vitest"]) {
      const entry = inventory.components.find((c) => c.name === name);
      if (!entry) continue;
      expect(entry.distributed, `${name} is marked distributed`).toBe(false);
    }
  });

  it("resolves a licence for everything it lists", () => {
    const unknown = inventory.components.filter((c) => c.license === "UNKNOWN");
    expect(unknown.map((c) => c.name)).toEqual([]);
  });
});

describe("the SBOM", () => {
  it("carries every distributed package as a required component", () => {
    const required = new Map(sbom.components.map((c) => [`${c.name}@${c.version}`, c]));
    for (const component of inventory.components.filter((c) => c.distributed)) {
      const entry = required.get(`${component.name}@${component.version}`);
      expect(entry, `${component.name} is missing from the SBOM`).toBeDefined();
      expect(entry!.scope).toBe("required");
    }
  });

  it("enumerates what is compiled into the prepared STAC application, not just its name", () => {
    const upstreamLock = join(PACKAGE_ROOT, "..", "stac-browser", ".upstream", "package-lock.json");
    if (!existsSync(upstreamLock)) return; // no upstream checkout here; the SBOM says so too

    const compiled = sbom.components.filter(
      (c) => c.description === "compiled into the prepared STAC Browser",
    );
    // A bill of materials that names `stac-browser@v5.0.0` and stops describes a tarball, not a
    // bundle: a consumer asking "does this artifact contain vue" is told no.
    expect(compiled.length).toBeGreaterThan(100);
    expect(compiled.map((c) => c.name)).toContain("vue");
    // And it is the lockfile the pinned build resolved against: the script refuses to enumerate
    // one whose digest the recipe does not record.
    const recipe = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, "..", "stac-browser", "upstream.json"), "utf8"),
    ) as { lockfileDigest: string };
    expect(recipe.lockfileDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
