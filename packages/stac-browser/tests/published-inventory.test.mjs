/**
 * What the generally published artifacts may contain, checked against the real thing: Freva
 * offers STAC Browser without putting the compiled third-party application into every published
 * artifact. That claim is about bytes, so it is checked against `npm pack`'s own file list and
 * the builder image's Dockerfile, not .gitignore: git tracking says nothing about what npm ships.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Shapes that only a compiled STAC Browser produces. */
const COMPILED = [
  /(^|\/)materials\//,
  /(^|\/)\.upstream(\/|$)/,
  /assets\/index-[A-Za-z0-9_-]+\.(js|css)$/,
  /(^|\/)mockServiceWorker\.js$/,
  /(^|\/)runtime-config\.js$/,
];

function packed(workspace) {
  const json = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: join(REPO, "packages", workspace),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return JSON.parse(json)[0].files.map((f) => f.path);
}

// The consumers - the portal builder's tarball and its builder image - are checked when they are
// in this checkout, and skipped by name when they are not: this workspace can land first.
const PORTAL_BUILDER = join(REPO, "packages", "portal-builder", "package.json");
const BUILDER_DOCKERFILE = join(REPO, "container", "portal-builder", "Dockerfile");

for (const workspace of ["stac-browser", "portal-builder"]) {
  const absent = workspace === "portal-builder" && !existsSync(PORTAL_BUILDER);
  test(
    `the ${workspace} tarball carries no compiled STAC Browser`,
    {
      skip: absent && "no portal-builder workspace in this checkout",
    },
    () => {
      const files = packed(workspace);
      assert.ok(files.length > 0, "npm pack listed no files at all");
      const offenders = files.filter((path) => COMPILED.some((pattern) => pattern.test(path)));
      assert.deepEqual(
        offenders,
        [],
        `${workspace} would publish compiled upstream material: ${offenders.slice(0, 5).join(", ")}`,
      );
    },
  );
}

test("the stac-browser tarball still carries the recipe", () => {
  // The other half of the claim: what is removed is the application, not the ability to build it.
  // A deployment gets the pin, the reviewed patches and the scripts, and forks nothing.
  const files = packed("stac-browser");
  for (const required of [
    "upstream.json",
    "adapter-contract.json",
    "scripts/prepare.mjs",
    "scripts/recipe.mjs",
    "scripts/pin.mjs",
    "LICENSE",
  ]) {
    assert.ok(files.includes(required), `the recipe is missing ${required}`);
  }
  assert.ok(
    files.filter((f) => f.startsWith("patches/")).length >= 4,
    "the reviewed patch series is not published, so a deployment could not build the feature",
  );
});

test(
  "the base builder image prepares no STAC materials",
  {
    skip: !existsSync(BUILDER_DOCKERFILE) && "no portal-builder image in this checkout",
  },
  () => {
    const dockerfile = readFileSync(BUILDER_DOCKERFILE, "utf8");
    // Read as instructions, not as prose: the comments in that file talk about STAC at length.
    const instructions = dockerfile
      .split("\n")
      .filter((line) => /^\s*(RUN|COPY|ENV)\b/i.test(line) || /^\s+&&/.test(line));
    const offenders = instructions.filter((line) =>
      /stac-materials|prepare:materials|prepare\.mjs|-w @freva-org\/stac-browser/.test(line),
    );
    assert.deepEqual(
      offenders,
      [],
      "the builder image builds or copies STAC materials:\n  " + offenders.join("\n  "),
    );
  },
);
