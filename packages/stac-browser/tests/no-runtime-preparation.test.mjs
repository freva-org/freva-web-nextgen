/**
 * The production server never fetches, patches, installs or compiles anything. "Build when
 * requested" means deployment build time. This asserts that where it would be violated: in the
 * artifact a deployment serves, and in the preparation scripts, which only an explicit command
 * may reach.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PKG = join(REPO, "packages", "stac-browser");

test("the prepared materials contain no executable preparation machinery", (t) => {
  const materials = process.env.FREVA_PORTAL_STAC_MATERIALS ?? join(PKG, "materials");
  let files;
  try {
    files = JSON.parse(readFileSync(join(materials, "materials.json"), "utf8")).files.map(
      (f) => f.path,
    );
  } catch {
    // No prepared materials in this checkout, which is the ordinary state.
    t.skip("no prepared materials");
    return;
  }
  // A script that could fetch or build has no place in a directory copied into a public artifact.
  for (const path of files) {
    assert.ok(
      !/(^|\/)(prepare|build|fetch|upgrade|recipe)\.mjs$/.test(path),
      `prepared materials contain the preparation script ${path}`,
    );
    assert.ok(!/(^|\/)package-lock\.json$/.test(path), `prepared materials contain ${path}`);
    assert.ok(!/(^|\/)\.git(\/|$)/.test(path), `prepared materials contain git metadata: ${path}`);
    assert.ok(!/node_modules\//.test(path), `prepared materials contain ${path}`);
  }
});

test("preparation is reachable only from an explicit command", () => {
  const pkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"));
  const entry = Object.entries(pkg.scripts ?? {}).find(([, cmd]) =>
    String(cmd).includes("prepare.mjs"),
  );
  assert.ok(entry, "no script runs the preparation orchestrator at all");
  const [name] = entry;
  // Not a lifecycle name, and not something npm decides to run on its own.
  assert.ok(
    !["prepare", "prepublish", "prepublishOnly", "prepack", "install", "postinstall"].includes(
      name,
    ),
    `preparation is bound to the npm lifecycle script '${name}'`,
  );
});

test("the recipe scripts are not imported by anything the portal builder ships", () => {
  // An import into the builder's dist is a path by which a runtime could run preparation code.
  const dist = join(REPO, "packages", "portal-builder", "dist");
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".js")) {
        const text = readFileSync(path, "utf8");
        assert.ok(
          !/stac-browser\/scripts\//.test(text),
          `${path} references the preparation scripts`,
        );
      }
    }
  };
  try {
    statSync(dist);
  } catch {
    return; // not built in this checkout
  }
  walk(dist);
});
