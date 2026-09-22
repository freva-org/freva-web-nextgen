/**
 * Shared helpers for the two build steps. The pin lives in `upstream.json`, never in a script, so
 * the fetch, the build and the tests all read the same commit and cannot drift apart.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const UPSTREAM_DIR = resolve(PKG_ROOT, ".upstream");
export const DIST_DIR = resolve(PKG_ROOT, "dist");

/** The pinned upstream descriptor. */
export function readPin() {
  return JSON.parse(readFileSync(resolve(PKG_ROOT, "upstream.json"), "utf-8"));
}

/**
 * Where the upstream checkout lives. `FREVA_STAC_UPSTREAM_DIR` lets an air-gapped or mirrored
 * build point at a checkout it already has; the commit is still verified, so an override cannot
 * quietly substitute a different revision.
 */
export function upstreamDir() {
  const override = process.env.FREVA_STAC_UPSTREAM_DIR;
  return override ? resolve(override) : UPSTREAM_DIR;
}

/**
 * Where this run's compiled tree goes. `dist/` under the package is the standalone default and is
 * shared state: two preparations running at once would build into the same directory and each
 * would verify the other's files. `prepare.mjs` gives every run its own workspace and points this
 * at it, so the shared location is only ever used by a single-run standalone `npm run build:upstream`.
 */
export function distDir() {
  const override = process.env.FREVA_STAC_DIST_OUT;
  return override ? resolve(override) : DIST_DIR;
}

export function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

export function run(cmd, args, cwd, env = {}) {
  execFileSync(cmd, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
}

/**
 * Fail unless the checkout is exactly the pinned commit. This is the whole point of pinning: a tag
 * can be moved, a mirror can lag, and `main` drifts daily. Only the 40-character object name is
 * trusted.
 */
export function assertPinnedCommit(dir, pin) {
  if (!existsSync(resolve(dir, ".git"))) {
    throw new Error(
      `${dir} is not a git checkout, so its revision cannot be verified. ` +
        `Run 'npm run stac:prepare'.`,
    );
  }
  const head = git(["rev-parse", "HEAD"], dir);
  if (head !== pin.commit) {
    throw new Error(
      `The upstream checkout is at ${head} but the pin in upstream.json is ` +
        `${pin.commit} (${pin.tag}). Refusing to build an unpinned revision. ` +
        `See packages/stac-browser/UPSTREAM.md for the upgrade procedure.`,
    );
  }
  return head;
}
