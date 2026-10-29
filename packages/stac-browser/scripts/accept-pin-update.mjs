#!/usr/bin/env node
/**
 * Accept a pin update proposed by the unprivileged job, in the job that opens the PR.
 *
 *   node packages/stac-browser/scripts/accept-pin-update.mjs <proposal dir> \
 *     --commit <sha> --tag <vX.Y.Z> --body-out <file>
 *
 * The proposal is untrusted, so nothing is copied: the changed files are rebuilt from this
 * checkout with only the values pin.mjs may move, and the proposal must match them exactly.
 */
import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { NOTICE_FILE, README_FILE, setField, setNoticePin, setReadmePin } from "./pin.mjs";
import { PKG_ROOT, RECIPE_FILE } from "./recipe.mjs";

export const CONTRACT_FILE = resolve(PKG_ROOT, "adapter-contract.json");

export const PROPOSAL_FILES = Object.freeze({
  "upstream.json": 256 * 1024,
  "adapter-contract.json": 256 * 1024,
  "pr-body.md": 60 * 1024,
});

const SHA256 = /^sha256:[0-9a-f]{64}$/;

/** The fields pin.mjs moves. `patchedSourceDigest` is empty after a failed build. */
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

const RECIPE_PATHS = Object.freeze({
  commit: ["commit"],
  tag: ["tag"],
  lockfileDigest: ["lockfileDigest"],
  patchedSourceDigest: ["expected", "patchedSourceDigest"],
  materialsTreeDigest: ["expected", "materialsTreeDigest"],
  fileCount: ["expected", "fileCount"],
  recordedWith: ["expected", "recordedWith"],
});

// One open, no symlink following, then check and read the same file descriptor.
function readRegularFile(path, name, limit) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error.code === "ELOOP" || error.code === "EMLINK") {
      throw new Error(`proposal entry ${name} is not a regular file`);
    }
    throw error;
  }
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`proposal entry ${name} is not a regular file`);
    const bytes = readFileSync(fd);
    if (bytes.length > limit) {
      throw new Error(`proposal entry ${name} is ${bytes.length} bytes; the limit is ${limit}`);
    }
    return bytes.toString("utf-8");
  } finally {
    closeSync(fd);
  }
}

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
    files[name] = readRegularFile(join(dir, name), name, PROPOSAL_FILES[name]);
  }
  return files;
}

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

// Upstream text goes into a bot PR: keep it from pinging people or closing issues here.
export function neutraliseReferences(text) {
  const zwsp = "\u200b";
  return text
    .replace(/(^|[^\w`/.])@([A-Za-z0-9][A-Za-z0-9-]*)/g, `$1@${zwsp}$2`)
    .replace(/([\w.-]+\/[\w.-]+)#(\d+)/g, `$1#${zwsp}$2`)
    .replace(/(^|[^\w&/])#(\d+)/g, `$1#${zwsp}$2`)
    .replace(/\bGH-(\d+)/gi, `GH${zwsp}-$1`);
}

/** `resolveTag` is injected so tests need no network. */
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

  // A downgrade is a person's decision.
  const current = JSON.parse(base.recipe).tag;
  if (compareReleases(tag, current) <= 0) {
    throw new Error(
      `${tag} is not newer than the pinned ${current}; a pin update only moves forward`,
    );
  }

  let recipe = base.recipe;
  for (const [field, value] of Object.entries(values)) recipe = setField(recipe, field, value);
  const contract = setField(setField(base.contract, "commit", commit), "tag", tag);

  if (!isDeepStrictEqual(JSON.parse(recipe), proposed)) {
    throw new Error("upstream.json changes fields a pin update may not move");
  }
  if (!isDeepStrictEqual(JSON.parse(contract), proposedContract)) {
    throw new Error("adapter-contract.json changes fields a pin update may not move");
  }

  const repository = JSON.parse(base.recipe).repository;
  const named = resolveTag(repository, tag);
  if (named !== commit)
    throw new Error(`upstream names ${named || "nothing"} for ${tag}, not ${commit}`);

  return {
    recipe,
    contract,
    readme: setReadmePin(base.readme, commit),
    notice: setNoticePin(base.notice, commit, tag),
    body: neutraliseReferences(proposal["pr-body.md"]),
  };
}

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
