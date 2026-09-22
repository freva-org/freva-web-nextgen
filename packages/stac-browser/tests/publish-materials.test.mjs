/**
 * Where a prepared tree may be written, and how it gets there. A destination must never be
 * deleted recursively just because `--out` named it: without an emptiness check, confinement and
 * confirmation, `npm run stac:prepare -- --out ~/work` takes `~/work` with it. Nor may it be torn
 * mid-assembly, or an interrupted run leaves a tree that looks prepared and is not. These are
 * unit tests against `publish.mjs` because the failure cases are destructive by definition.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertPublishable, publishStaged } from "../scripts/publish.mjs";

const scratch = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "stac-publish-"));
  scratch.push(dir);
  return dir;
};
process.on("exit", () => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const materials = (dir, extra = {}) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "materials.json"),
    JSON.stringify({ kind: "stac-browser-materials", files: [], ...extra }),
  );
  return dir;
};

test("a destination that is not a previous prepared tree is refused, not emptied", () => {
  const root = temp();
  const destination = join(root, "work");
  mkdirSync(destination, { recursive: true });
  writeFileSync(join(destination, "thesis.txt"), "eight months of work");

  assert.throws(
    () => assertPublishable(destination, { packageRoot: root }),
    /not empty and has no materials\.json/,
  );
  // The check is not merely advisory: nothing was touched.
  assert.deepEqual(readdirSync(destination), ["thesis.txt"]);
  assert.equal(readFileSync(join(destination, "thesis.txt"), "utf-8"), "eight months of work");
});

test("an empty or absent destination is fine, and a previous tree is replaceable", () => {
  const root = temp();
  assert.equal(assertPublishable(join(root, "new"), { packageRoot: root }).replaces, "nothing");
  mkdirSync(join(root, "empty"));
  assert.equal(
    assertPublishable(join(root, "empty"), { packageRoot: root }).replaces,
    "an empty directory",
  );
  assert.equal(
    assertPublishable(materials(join(root, "again")), { packageRoot: root }).replaces,
    "a previously prepared tree",
  );
});

test("a directory whose manifest is something else is refused", () => {
  const root = temp();
  const destination = join(root, "other");
  mkdirSync(destination);
  writeFileSync(join(destination, "materials.json"), JSON.stringify({ kind: "someone-elses" }));
  assert.throws(() => assertPublishable(destination, { packageRoot: root }), /someone-elses/);

  const broken = join(root, "broken");
  mkdirSync(broken);
  writeFileSync(join(broken, "materials.json"), "{ not json");
  assert.throws(() => assertPublishable(broken, { packageRoot: root }), /unreadable/);
});

test("the package's own directories and any parent of it are refused outright", () => {
  const root = temp();
  const packageRoot = join(root, "packages", "stac-browser");
  mkdirSync(packageRoot, { recursive: true });

  for (const [destination, pattern] of [
    [packageRoot, /package root/],
    [join(packageRoot, "dist"), /'dist' directory/],
    [join(packageRoot, ".upstream"), /'\.upstream' directory/],
    [join(packageRoot, "patches"), /'patches' directory/],
    [join(packageRoot, "node_modules"), /'node_modules' directory/],
    [root, /package root is inside it/],
    [resolve("/"), /filesystem root/],
  ]) {
    assert.throws(
      () => assertPublishable(destination, { packageRoot }),
      pattern,
      String(destination),
    );
  }
});

test("publishing is a rename, so the destination is never a mixture of two trees", () => {
  const root = temp();
  const destination = join(root, "materials");
  materials(destination, { treeDigest: "sha256:old" });
  writeFileSync(join(destination, "old-only.txt"), "from the previous run");

  const staging = join(root, "materials.staging-1-abcd");
  materials(staging, { treeDigest: "sha256:new" });
  writeFileSync(join(staging, "new-only.txt"), "from this run");

  publishStaged(staging, destination, { packageRoot: root });

  const listed = readdirSync(destination).sort();
  assert.deepEqual(listed, ["materials.json", "new-only.txt"]);
  assert.match(readFileSync(join(destination, "materials.json"), "utf-8"), /sha256:new/);
  // The staged directory is gone rather than left beside the destination.
  assert.equal(readdirSync(root).includes("materials.staging-1-abcd"), false);
  // And so is the displaced tree.
  assert.deepEqual(
    readdirSync(root).filter((name) => name.includes(".previous-")),
    [],
  );
});

test("a failed publish leaves the previous tree in place rather than gone", () => {
  const root = temp();
  const destination = join(root, "materials");
  materials(destination, { treeDigest: "sha256:old" });
  writeFileSync(join(destination, "old-only.txt"), "from the previous run");

  // The second rename fails after the first displaced the old tree - the window it must survive.
  assert.throws(() =>
    publishStaged(join(root, "materials.staging-missing"), destination, { packageRoot: root }),
  );
  assert.deepEqual(readdirSync(destination).sort(), ["materials.json", "old-only.txt"]);
  assert.match(readFileSync(join(destination, "materials.json"), "utf-8"), /sha256:old/);
});

test("two runs staging for the same destination do not share a staging directory", () => {
  // The staging name carries the pid and a random suffix so concurrent preparations aimed at one
  // destination assemble independently and the last complete tree wins. Separate processes cannot
  // be raced here, so this asserts the shape of that name.
  const source = readFileSync(
    new URL("../scripts/prepare-materials.mjs", import.meta.url),
    "utf-8",
  );
  assert.ok(
    source.includes('.staging-${process.pid}-${randomBytes(4).toString("hex")}'),
    "the staging directory name does not carry the pid and a random suffix",
  );
  // Comments stripped first: a nearby note quotes the call this forbids.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(
    code,
    /rmSync\(\s*MATERIALS/,
    "the destination is still being deleted before assembly",
  );
});
