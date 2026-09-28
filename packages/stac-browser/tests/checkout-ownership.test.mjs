// The recipe discards a checkout at the wrong revision and fetches it again. It may only do that
// to a checkout it fetched itself: the checkout directory can be supplied, and a supplied path
// that is somebody's repository must be refused before anything in it changes.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { CHECKOUT_MARKER, checkoutVerdict, claimCheckout, PKG_ROOT } from "../scripts/recipe.mjs";

const scratch = mkdtempSync(join(tmpdir(), "stac-checkout-"));
test.after(() => rmSync(scratch, { recursive: true, force: true }));

let n = 0;
const fresh = () => {
  const dir = join(scratch, `d${++n}`);
  mkdirSync(dir);
  return dir;
};
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" });

test("absent or empty: fetch into it", () => {
  assert.equal(checkoutVerdict(join(scratch, "absent")), "fetch");
  assert.equal(checkoutVerdict(fresh()), "fetch");
});

test("a checkout this recipe fetched: reuse it (and discard it at the wrong revision)", () => {
  const dir = fresh();
  git(dir, "init", "--quiet");
  claimCheckout(dir);
  assert.ok(existsSync(join(dir, ".git", CHECKOUT_MARKER)));
  assert.equal(checkoutVerdict(dir), "reuse");
});

test("anybody else's repository, any other directory, or a file: refuse", () => {
  const repo = fresh();
  git(repo, "init", "--quiet");
  assert.equal(checkoutVerdict(repo), "refuse");
  const notes = fresh();
  writeFileSync(join(notes, "notes.txt"), "mine\n");
  assert.equal(checkoutVerdict(notes), "refuse");
  const file = join(scratch, "a-file");
  writeFileSync(file, "x");
  assert.equal(checkoutVerdict(file), "refuse");
});

test("the package's own .upstream predates the marker and is still its own", () => {
  const dir = fresh();
  git(dir, "init", "--quiet");
  assert.equal(checkoutVerdict(dir, { ownDefault: true }), "reuse");
});

test("prepare.mjs refuses a supplied checkout it did not fetch, before touching it", () => {
  const repo = fresh();
  git(repo, "init", "--quiet");
  writeFileSync(join(repo, "work-in-progress.txt"), "not committed yet\n");
  const run = spawnSync(
    process.execPath,
    [resolve(PKG_ROOT, "scripts", "prepare.mjs"), "--out", join(scratch, "out")],
    {
      encoding: "utf8",
      env: { ...process.env, FREVA_STAC_CHECKOUT_DIR: repo, FREVA_STAC_UPSTREAM_DIR: "" },
    },
  );
  assert.notEqual(run.status, 0);
  assert.match(
    run.stderr,
    /is not a checkout this recipe fetched, so it is neither reused nor deleted/,
  );
  assert.equal(readFileSync(join(repo, "work-in-progress.txt"), "utf8"), "not committed yet\n");
  assert.equal(existsSync(join(repo, ".git", CHECKOUT_MARKER)), false);
});
