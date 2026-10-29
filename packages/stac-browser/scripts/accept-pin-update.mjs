#!/usr/bin/env node
/**
 * Apply a STAC Browser pin update that an unprivileged job produced, in the privileged job that
 * opens the pull request.
 *
 *   node packages/stac-browser/scripts/accept-pin-update.mjs <proposal dir> \
 *     --commit <sha> --tag <vX.Y.Z> --body-out <file>
 *
 * The proposal is written AFTER upstream code has run (`npm ci` and the build at the new release),
 * so nothing in it is trusted and nothing in it is copied. Instead:
 *
 *   1. the directory must hold exactly `upstream.json`, `adapter-contract.json` and `pr-body.md`,
 *      each a regular file under a size limit: no other entry, no directory, no link;
 *   2. the four files the pull request changes are REBUILT from this checkout with the same field
 *      edits `pin.mjs` makes, using only the values `pin.mjs` is allowed to move, each checked
 *      for its exact shape;
 *   3. the proposal's two JSON files must then equal the rebuilt ones exactly, so any other field
 *      that changed (repository, patches, build settings, licence digest, ...) is refused;
 *   4. the commit must be the one upstream's repository - as this checkout records it - names
 *      for the tag.
 *
 * README.md and THIRD_PARTY_NOTICES.md are not taken from the proposal at all: their only change
 * is the pin, which this script writes itself.
 */
import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { NOTICE_FILE, README_FILE, setField, setNoticePin, setReadmePin } from "./pin.mjs";
import { PKG_ROOT, RECIPE_FILE } from "./recipe.mjs";

export const CONTRACT_FILE = resolve(PKG_ROOT, "adapter-contract.json");

/** The only entries a proposal may contain, with the largest size each may have. */
export const PROPOSAL_FILES = Object.freeze({
  "upstream.json": 256 * 1024,
  "adapter-contract.json": 256 * 1024,
  // GitHub's limit for a pull request body is 65536 characters.
  "pr-body.md": 60 * 1024,
});

const SHA256 = /^sha256:[0-9a-f]{64}$/;

/**
 * Every recipe field a pin update may move, and the shape its value must have. This is the whole
 * list: `pin.mjs --commit/--tag` writes the first four, `pin.mjs --materials` the last four.
 * `patchedSourceDigest` is empty after a failed build, because `--materials` never ran.
 */
export const RECIPE_FIELDS = Object.freeze({
  commit: (v) => typeof v === "string" && /^[0-9a-f]{40}$/.test(v),
  tag: (v) => typeof v === "string" && /^v\d+\.\d+\.\d+$/.test(v),
  lockfileDigest: (v) => typeof v === "string" && SHA256.test(v),
  patchedSourceDigest: (v) => v === "" || (typeof v === "string" && SHA256.test(v)),
  materialsTreeDigest: (v) => typeof v === "string" && SHA256.test(v),
  fileCount: (v) => Number.isInteger(v) && v > 0 && v < 1_000_000,
  recordedWith: (v) =>
    typeof v === "string" &&
    /^node \d+\.\d+\.\d+, npm \d+\.\d+\.\d+, [a-z0-9]+\/[a-z0-9_]+$/.test(v),
});

/** Where each field lives in `upstream.json`. */
const RECIPE_PATHS = Object.freeze({
  commit: ["commit"],
  tag: ["tag"],
  lockfileDigest: ["lockfileDigest"],
  patchedSourceDigest: ["expected", "patchedSourceDigest"],
  materialsTreeDigest: ["expected", "materialsTreeDigest"],
  fileCount: ["expected", "fileCount"],
  recordedWith: ["expected", "recordedWith"],
});

/** Read a proposal directory, refusing anything but the expected regular files. */
export function readProposal(dir) {
  const names = readdirSync(dir).sort();
  const expected = Object.keys(PROPOSAL_FILES).sort();
  if (!isDeepStrictEqual(names, expected)) {
    throw new Error(
      `proposal must contain exactly ${expected.join(", ")}; found ${names.join(", ") || "nothing"}`,
    );
  }
  const files = {};
  for (const name of names) {
    const path = join(dir, name);
    const stat = lstatSync(path);
    if (!stat.isFile()) throw new Error(`proposal entry ${name} is not a regular file`);
    if (stat.size > PROPOSAL_FILES[name]) {
      throw new Error(
        `proposal entry ${name} is ${stat.size} bytes; the limit is ${PROPOSAL_FILES[name]}`,
      );
    }
    files[name] = readFileSync(path, "utf-8");
  }
  return files;
}

/** Order two stable release tags, `vX.Y.Z`: negative, zero or positive, like a comparator. */
export function compareReleases(a, b) {
  const parts = (tag) => {
    const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
    if (!match) throw new Error(`${tag} is not a stable release tag vX.Y.Z`);
    return match.slice(1).map(Number);
  };
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

function at(object, path) {
  return path.reduce((value, key) => (value == null ? undefined : value[key]), object);
}

function parse(name, text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`proposal ${name} is not JSON: ${error.message}`);
  }
}

/**
 * Rebuild the pin update from trusted base texts and the proposal.
 *
 * @param {object} input
 * @param {Record<string, string>} input.proposal   what `readProposal` returned
 * @param {{recipe: string, contract: string, readme: string, notice: string}} input.base
 *        the four files as this checkout has them
 * @param {string} input.commit                     the commit the unprivileged job reported
 * @param {string} input.tag                        the tag the unprivileged job reported
 * @param {(repository: string, tag: string) => string} input.resolveTag
 *        what upstream names for the tag; injected so tests need no network
 * @returns {{recipe: string, contract: string, readme: string, notice: string, body: string}}
 */
export function rebuild({ proposal, base, commit, tag, resolveTag }) {
  const proposed = parse("upstream.json", proposal["upstream.json"]);
  const proposedContract = parse("adapter-contract.json", proposal["adapter-contract.json"]);

  const values = {};
  for (const [field, valid] of Object.entries(RECIPE_FIELDS)) {
    const value = at(proposed, RECIPE_PATHS[field]);
    if (!valid(value))
      throw new Error(`upstream.json ${RECIPE_PATHS[field].join(".")} has an invalid value`);
    values[field] = value;
  }
  if (values.commit !== commit)
    throw new Error("upstream.json commit is not the commit the job reported");
  if (values.tag !== tag) throw new Error("upstream.json tag is not the tag the job reported");

  // Forward only. A producer that can choose the release could otherwise propose an older,
  // vulnerable one that upstream really does name; a downgrade is a person's decision.
  const current = JSON.parse(base.recipe).tag;
  if (compareReleases(tag, current) <= 0) {
    throw new Error(
      `${tag} is not newer than the pinned ${current}; a pin update only moves forward`,
    );
  }

  // Rebuild from this checkout, moving only the allowed fields, exactly as pin.mjs would.
  let recipe = base.recipe;
  for (const [field, value] of Object.entries(values)) recipe = setField(recipe, field, value);
  const contract = setField(setField(base.contract, "commit", commit), "tag", tag);

  // Anything else that differs in the proposal is a change nobody is allowed to make here.
  if (!isDeepStrictEqual(JSON.parse(recipe), proposed)) {
    throw new Error("upstream.json changes fields a pin update may not move");
  }
  if (!isDeepStrictEqual(JSON.parse(contract), proposedContract)) {
    throw new Error("adapter-contract.json changes fields a pin update may not move");
  }

  // The repository comes from this checkout, never from the proposal.
  const repository = JSON.parse(base.recipe).repository;
  const named = resolveTag(repository, tag);
  if (named !== commit)
    throw new Error(`upstream names ${named || "nothing"} for ${tag}, not ${commit}`);

  return {
    recipe,
    contract,
    readme: setReadmePin(base.readme, commit),
    notice: setNoticePin(base.notice, commit, tag),
    body: proposal["pr-body.md"],
  };
}

/** The commit a remote names for a tag, peeling an annotated tag. */
export function lsRemoteTag(repository, tag) {
  const out = execFileSync(
    "git",
    ["ls-remote", repository, `refs/tags/${tag}^{}`, `refs/tags/${tag}`],
    {
      encoding: "utf-8",
    },
  );
  const lines = out
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"));
  const peeled = lines.find(([, ref]) => ref === `refs/tags/${tag}^{}`);
  const direct = lines.find(([, ref]) => ref === `refs/tags/${tag}`);
  return (peeled ?? direct ?? [""])[0];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const value = (name) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const dir = argv[0];
  const commit = value("commit");
  const tag = value("tag");
  const bodyOut = value("body-out");
  if (!dir || dir.startsWith("--") || !commit || !tag || !bodyOut) {
    process.stderr.write(
      "usage: accept-pin-update <proposal dir> --commit <sha> --tag <vX.Y.Z> --body-out <file>\n",
    );
    process.exit(2);
  }
  const result = rebuild({
    proposal: readProposal(dir),
    base: {
      recipe: readFileSync(RECIPE_FILE, "utf-8"),
      contract: readFileSync(CONTRACT_FILE, "utf-8"),
      readme: readFileSync(README_FILE, "utf-8"),
      notice: readFileSync(NOTICE_FILE, "utf-8"),
    },
    commit,
    tag,
    resolveTag: lsRemoteTag,
  });
  writeFileSync(RECIPE_FILE, result.recipe);
  writeFileSync(CONTRACT_FILE, result.contract);
  writeFileSync(README_FILE, result.readme);
  writeFileSync(NOTICE_FILE, result.notice);
  writeFileSync(bodyOut, result.body);
  process.stdout.write(`[stac-pin-proposal] applied ${tag} (${commit})\n`);
  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(
      process.env.GITHUB_OUTPUT,
      `commit=${commit}\ntag=${tag}\nshort=${commit.slice(0, 7)}\n`,
      {
        flag: "a",
      },
    );
  }
}
