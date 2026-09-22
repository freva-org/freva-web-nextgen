/**
 * No workspace may run STAC preparation from an install hook. `prepare` is an npm LIFECYCLE name,
 * run on every `npm ci` and `npm install`; fetching and compiling a third-party application, with
 * its ~800 dependencies, must happen only for a deployment that has enabled the component. An
 * orchestrator under a lifecycle name would invert that while looking correct in every file.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Names npm executes on its own during install, plus the implicit pre/post pairs. */
const INSTALL_HOOKS = [
  "preinstall",
  "install",
  "postinstall",
  "prepare",
  "prepublish",
  "preprepare",
  "postprepare",
];

function manifests() {
  const out = [["package.json", join(REPO, "package.json")]];
  const packages = join(REPO, "packages");
  for (const entry of readdirSync(packages, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(packages, entry.name, "package.json");
    try {
      readFileSync(file);
      out.push([`packages/${entry.name}/package.json`, file]);
    } catch {
      // a directory without a manifest is not a workspace
    }
  }
  return out;
}

/**
 * The one install hook this repository allows, stated exactly. Husky installs local git hooks,
 * touches nothing outside the checkout, and is allow-listed by COMMAND not name, so replacing it
 * with something that does more work fails here. `husky` is a devDependency, so an `--omit=dev`
 * install has no binary and the `|| echo` half of the string exits zero - fetching nothing.
 */
const ALLOWED = new Map([
  [
    "package.json\u0000prepare",
    'husky || echo "husky not installed - git hooks were not set up. That is expected for a build-only or --omit=dev install; run npm ci at the repo root to get them."',
  ],
]);

test("no workspace runs anything from an npm install hook", () => {
  for (const [label, file] of manifests()) {
    const scripts = JSON.parse(readFileSync(file, "utf8")).scripts ?? {};
    for (const hook of INSTALL_HOOKS) {
      if (scripts[hook] === undefined) continue;
      const allowance = ALLOWED.get(`${label}\u0000${hook}`);
      assert.equal(
        scripts[hook],
        allowance,
        allowance === undefined
          ? `${label} defines '${hook}', which npm runs during 'npm ci'. Ordinary bootstrap must ` +
              "not fetch, patch, compile or install anything on behalf of an optional feature."
          : `${label}'s '${hook}' hook is no longer '${allowance}'. An install hook runs on every ` +
              "checkout; a new one needs its own reason.",
      );
    }
  }
});

test("the STAC preparation command is not reachable from an install hook", () => {
  for (const [label, file] of manifests()) {
    const scripts = JSON.parse(readFileSync(file, "utf8")).scripts ?? {};
    for (const [name, command] of Object.entries(scripts)) {
      if (!INSTALL_HOOKS.includes(name)) continue;
      assert.ok(
        !/stac|prepare\.mjs/i.test(String(command)),
        `${label} reaches STAC preparation from the install hook '${name}'.`,
      );
    }
  }
});
