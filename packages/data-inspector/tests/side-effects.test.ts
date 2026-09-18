import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

// Every local module reachable from an entry, following relative imports only.
function reach(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/\bfrom\s+"(\.[^"]+)"|\bimport\s+"(\.[^"]+)"/g)) {
      const spec = m[1] ?? m[2];
      for (const candidate of [`${spec}.ts`, `${spec}/index.ts`, spec]) {
        const target = resolve(dirname(file), candidate);
        if (existsSync(target) && target.endsWith(".ts")) {
          queue.push(target);
          break;
        }
      }
    }
  }
  return [...seen];
}

describe("what importing this package registers", () => {
  // `./core` is the data side, importable where there is no DOM, which is what lets a
  // consumer that only wants the metadata reader keep three custom elements out of its
  // bundle and run it under plain Node.
  // The guarantee is checked on the import graph rather than on a live registry: a
  // registry is global, so a sibling test that imported the root would decide this one.
  it("core reaches neither a registration nor an HTMLElement subclass", () => {
    const offenders = reach(resolve(SRC, "core.ts")).filter((f) => {
      const text = readFileSync(f, "utf8");
      // `extends HTMLElement` is evaluated at module scope, so it throws where there
      // is no DOM - which is the whole point of this entry existing.
      return text.includes("customElements.define") || text.includes("extends HTMLElement");
    });
    expect(offenders.map((f) => f.slice(SRC.length + 1))).toEqual([]);
  });

  it("the registration lives in exactly one module, and the root pulls it in", () => {
    const defining = reach(resolve(SRC, "index.ts")).filter((f) =>
      readFileSync(f, "utf8").includes("customElements.define"),
    );
    expect(defining.map((f) => f.slice(SRC.length + 1))).toEqual(["elements.ts"]);
  });

  it("the export map and sideEffects agree about which entries register", () => {
    const pkg = JSON.parse(readFileSync(resolve(SRC, "../package.json"), "utf8"));
    expect(Object.keys(pkg.exports).sort()).toEqual([
      ".",
      "./core",
      "./elements",
      "./package.json",
    ]);
    // The SOURCES are named as well as the outputs, and that is not decoration: the
    // library build reads this field too, so with only `./dist/*` here rollup treated
    // `src/elements.ts` as pure and deleted the root's registration from `index.mjs`.
    expect([...pkg.sideEffects].sort()).toEqual([
      "./dist/elements.cjs",
      "./dist/elements.mjs",
      "./dist/index.cjs",
      "./dist/index.mjs",
      "./src/elements.ts",
      "./src/index.ts",
    ]);
  });
});
