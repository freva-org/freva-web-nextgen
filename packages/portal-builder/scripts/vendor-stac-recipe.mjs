#!/usr/bin/env node
// Copy Freva's STAC Browser RECIPE into this package, so `freva-portal-builder prepare-stac` works
// from an npm install without a checkout of this repository.
//
// `@freva-org/stac-browser` is private and never published: the pin, the patch series, the
// preparation scripts and the licence evidence, never the compiled application. This copies that
// allow-list (the workspace's own `files`, minus tests) into `stac-recipe/`, which package.json
// `files` publishes. Run by `prepack`; generated, not committed. In a workspace checkout the CLI
// reads `packages/stac-browser` directly.
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = resolve(PKG, "..", "stac-browser");
const TARGET = join(PKG, "stac-recipe");

/** Everything the recipe needs to run, and nothing it only needs to be tested. */
export const RECIPE_FILES = [
  "scripts",
  "patches",
  "upstream.json",
  "adapter-contract.json",
  "LICENSE",
  "LICENSES",
  "THIRD_PARTY_NOTICES.md",
  "UPSTREAM.md",
  "PATCH_PROVENANCE.md",
  ".nvmrc",
];

export function vendorStacRecipe({ source = SOURCE, target = TARGET } = {}) {
  if (!existsSync(join(source, "upstream.json"))) {
    throw new Error(`No STAC Browser recipe at ${source}; run this from a repository checkout.`);
  }
  const own = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  for (const entry of RECIPE_FILES) {
    // The workspace's own allow-list is the authority on what the recipe is; a file this list
    // names and that one does not is a mistake here, not a reason to publish more.
    if (!own.files.includes(entry)) {
      throw new Error(`'${entry}' is not in @freva-org/stac-browser's own "files" allow-list.`);
    }
  }
  rmSync(target, { recursive: true, force: true });
  for (const entry of RECIPE_FILES) {
    cpSync(join(source, entry), join(target, entry), { recursive: true });
  }
  // ESM scripts need a package scope that says so, and the recipe's version is what the
  // provenance record names. Nothing here is installable on its own.
  writeFileSync(
    join(target, "package.json"),
    `${JSON.stringify({ name: own.name, private: true, version: own.version, type: "module" }, null, 2)}\n`,
  );
  return target;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = vendorStacRecipe();
  // stderr: this runs inside `npm pack --json`, whose stdout is the JSON a caller parses.
  process.stderr.write(`vendored the STAC Browser recipe into ${target}\n`);
}
