#!/usr/bin/env node
/**
 * Move the pin. What the weekly `stac-browser-update` workflow runs before it tries a build.
 *
 *     node scripts/pin.mjs --commit <sha> --tag <vX.Y.Z>   point the recipe at a release
 *     node scripts/pin.mjs --materials <dir>               record what that release prepared
 *
 * The first form fetches the release, then rewrites `upstream.json` (commit, tag, lockfile
 * digest), `adapter-contract.json` (`upstream`) and the pinned-commit link in the root README. It leaves the licence digest alone when the
 * licence changed, so the build that follows refuses with the legal-review message and the bump
 * can only be a draft. The patch series is not touched: whether it still applies is what that
 * build finds out.
 *
 * The second form copies the tree digest and file count of a successful `stac:prepare` into
 * `expected`, so the next preparation on the same toolchain reports no mismatch.
 *
 * Values are replaced in place, one field at a time, so the files keep their formatting and a
 * reviewer's diff shows exactly the fields that moved.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { digestOfFile, git, PKG_ROOT, readRecipe, RECIPE_FILE } from "./recipe.mjs";

/**
 * Replace the value of the one `"key": value` in `text`. Refuses when the key is absent or
 * repeated: a rewrite that picked the wrong occurrence would move a field nobody asked to move.
 */
export function setField(text, key, value) {
  const pattern = new RegExp(`("${key}":\\s*)("(?:[^"\\\\]|\\\\.)*"|-?\\d+(?:\\.\\d+)?)`, "g");
  const hits = text.match(pattern) ?? [];
  if (hits.length !== 1) {
    throw new Error(`expected exactly one "${key}" field, found ${hits.length}`);
  }
  return text.replace(pattern, (_, prefix) => `${prefix}${JSON.stringify(value)}`);
}

const CONTRACT_FILE = resolve(PKG_ROOT, "adapter-contract.json");
export const README_FILE = resolve(PKG_ROOT, "..", "..", "README.md");

/** The root README's link to upstream's tree at the pin: a short name, and the full one. */
export const README_PIN =
  /\[`([0-9a-f]{7})`\]\(https:\/\/github\.com\/radiantearth\/stac-browser\/tree\/([0-9a-f]{40})\)/g;

/** Point the README's link at `commit`. Same length as before, so the table keeps its padding. */
export function setReadmePin(text, commit) {
  const hits = text.match(README_PIN) ?? [];
  if (hits.length !== 1) throw new Error(`expected one pinned-commit link, found ${hits.length}`);
  return text.replace(
    README_PIN,
    `[\`${commit.slice(0, 7)}\`](https://github.com/radiantearth/stac-browser/tree/${commit})`,
  );
}

export const NOTICE_FILE = resolve(PKG_ROOT, "THIRD_PARTY_NOTICES.md");

export function setNoticePin(text, commit, tag) {
  let out = text;
  for (const [label, value] of [
    ["Version", tag],
    ["Commit", commit],
  ]) {
    const row = new RegExp(`^\\| ${label}( +)\\| \`[^\`]*\`( *)\\|$`, "gm");
    const hits = [...out.matchAll(row)];
    if (hits.length !== 1) throw new Error(`expected one ${label} row, found ${hits.length}`);
    const [whole, gap] = hits[0];
    const head = `| ${label}${gap}| `;
    const cell = `\`${value}\``.padEnd(whole.length - head.length - 1, " ");
    out = out.replace(row, () => `${head}${cell}|`);
  }
  return out;
}

function rewrite(file, fields) {
  let text = readFileSync(file, "utf-8");
  for (const [key, value] of Object.entries(fields)) text = setField(text, key, value);
  JSON.parse(text); // still JSON, or nothing is written
  writeFileSync(file, text);
}

/** `name=value` for a GitHub step, and a line for a person either way. */
function output(name, value) {
  process.stdout.write(`[stac-pin] ${name}: ${value}\n`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function pinRelease(commit, tag) {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("--commit takes a full 40-character name");
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error("--tag takes a stable release tag, vX.Y.Z");
  const recipe = readRecipe();
  const work = mkdtempSync(join(tmpdir(), "stac-pin-"));
  try {
    git(["init", "--quiet"], work);
    git(["remote", "add", "origin", recipe.repository], work);
    execFileSync("git", ["fetch", "--quiet", "--depth", "1", "origin", commit], {
      cwd: work,
      stdio: "inherit",
    });
    git(["checkout", "--quiet", "FETCH_HEAD"], work);
    const lockfileDigest = digestOfFile(join(work, recipe.lockfile));
    const licenseDigest = digestOfFile(join(work, recipe.licenseFile));

    rewrite(RECIPE_FILE, { commit, tag, lockfileDigest });
    rewrite(CONTRACT_FILE, { commit, tag });
    writeFileSync(README_FILE, setReadmePin(readFileSync(README_FILE, "utf-8"), commit));
    writeFileSync(NOTICE_FILE, setNoticePin(readFileSync(NOTICE_FILE, "utf-8"), commit, tag));

    output("lockfile", lockfileDigest === recipe.lockfileDigest ? "unchanged" : "changed");
    output("licence", licenseDigest === recipe.licenseDigest ? "unchanged" : "changed");
    if (licenseDigest !== recipe.licenseDigest) {
      process.stdout.write(
        `[stac-pin] ${recipe.licenseFile} is ${licenseDigest}; the recipe keeps ` +
          `${recipe.licenseDigest}, so preparation refuses until someone has reviewed it.\n`,
      );
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function recordMaterials(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, "materials.json"), "utf-8"));
  rewrite(RECIPE_FILE, {
    materialsTreeDigest: manifest.treeDigest,
    fileCount: manifest.files.length,
  });
  output("tree", manifest.treeDigest);
  output("files", manifest.files.length);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const value = (name) => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  if (value("materials")) recordMaterials(resolve(value("materials")));
  else if (value("commit") && value("tag")) pinRelease(value("commit"), value("tag"));
  else {
    process.stderr.write(
      "usage: pin --commit <sha> --tag <vX.Y.Z>\n       pin --materials <prepared dir>\n",
    );
    process.exit(2);
  }
}
