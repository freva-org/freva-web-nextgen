/**
 * The privileged PR job takes nothing from the proposal but checked values. These check that a
 * legitimate pin update goes through unchanged, and that every other shape of proposal - an extra
 * entry, a link, a field pin.mjs never moves, a commit upstream does not name - is refused.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  compareReleases,
  CONTRACT_FILE,
  readProposal,
  rebuild,
} from "../scripts/accept-pin-update.mjs";
import { NOTICE_FILE, README_FILE, setField } from "../scripts/pin.mjs";
import { RECIPE_FILE } from "../scripts/recipe.mjs";

const base = {
  recipe: readFileSync(RECIPE_FILE, "utf-8"),
  contract: readFileSync(CONTRACT_FILE, "utf-8"),
  readme: readFileSync(README_FILE, "utf-8"),
  notice: readFileSync(NOTICE_FILE, "utf-8"),
};
const COMMIT = "a".repeat(40);
const TAG = "v9.9.9";
const DIGEST = `sha256:${"b".repeat(64)}`;

/** What a green `prepare` job hands over for COMMIT/TAG. */
function legitimate() {
  let recipe = base.recipe;
  for (const [field, value] of Object.entries({
    commit: COMMIT,
    tag: TAG,
    lockfileDigest: DIGEST,
    patchedSourceDigest: DIGEST,
    materialsTreeDigest: DIGEST,
    fileCount: 700,
    recordedWith: "node 24.22.1, npm 11.20.0, linux/x64",
  })) {
    recipe = setField(recipe, field, value);
  }
  return {
    "upstream.json": recipe,
    "adapter-contract.json": setField(setField(base.contract, "commit", COMMIT), "tag", TAG),
    "pr-body.md": "Bumps the pin.\n",
  };
}

const upstreamNames = (commit) => () => commit;
const run = (proposal, overrides = {}) =>
  rebuild({
    proposal,
    base,
    commit: COMMIT,
    tag: TAG,
    resolveTag: upstreamNames(COMMIT),
    ...overrides,
  });

function withDir(entries, fn) {
  const dir = mkdtempSync(join(tmpdir(), "stac-pin-proposal-"));
  try {
    for (const [name, content] of Object.entries(entries)) writeFileSync(join(dir, name), content);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a legitimate pin update is rebuilt exactly as pin.mjs would write it", () => {
  const proposal = legitimate();
  const out = run(proposal);
  assert.equal(out.recipe, proposal["upstream.json"]);
  assert.equal(out.contract, proposal["adapter-contract.json"]);
  assert.match(out.readme, new RegExp(COMMIT));
  assert.match(out.notice, new RegExp(TAG.replace(/\./g, "\\.")));
  assert.equal(out.body, "Bumps the pin.\n");
});

test("a failed build's proposal, with an empty patch result, is accepted", () => {
  const proposal = legitimate();
  proposal["upstream.json"] = setField(proposal["upstream.json"], "patchedSourceDigest", "");
  assert.doesNotThrow(() => run(proposal));
});

test("the proposal's own bytes are never what gets written", () => {
  const proposal = legitimate();
  // Same JSON value, different text: the output must still be the rebuilt text.
  proposal["upstream.json"] = JSON.stringify(JSON.parse(proposal["upstream.json"]));
  const out = run(proposal);
  assert.equal(out.recipe, legitimate()["upstream.json"]);
});

for (const [what, mutate] of [
  ["the repository", (r) => ({ ...r, repository: "https://example.invalid/stac-browser.git" })],
  ["the patch series", (r) => ({ ...r, patches: { ...r.patches, series: [] } })],
  ["the build settings", (r) => ({ ...r, build: { ...r.build, install: "npm install" } })],
  ["the licence digest", (r) => ({ ...r, licenseDigest: DIGEST })],
  ["an added field", (r) => ({ ...r, extra: true })],
]) {
  test(`a proposal that changes ${what} is refused`, () => {
    const proposal = legitimate();
    proposal["upstream.json"] = JSON.stringify(
      mutate(JSON.parse(proposal["upstream.json"])),
      null,
      2,
    );
    assert.throws(() => run(proposal), /may not move/);
  });
}

test("an adapter contract that changes more than the pin is refused", () => {
  const proposal = legitimate();
  const contract = JSON.parse(proposal["adapter-contract.json"]);
  contract.reviewedOn = "tomorrow";
  proposal["adapter-contract.json"] = JSON.stringify(contract);
  assert.throws(() => run(proposal), /adapter-contract\.json changes fields/);
});

for (const [field, bad] of [
  ["commit", "not-a-sha"],
  ["tag", "v1.0.0-rc.1"],
  ["lockfileDigest", "sha256:short"],
  ["fileCount", -1],
  ["recordedWith", "node 24; curl evil"],
]) {
  test(`an invalid ${field} is refused`, () => {
    const proposal = legitimate();
    proposal["upstream.json"] = setField(proposal["upstream.json"], field, bad);
    assert.throws(
      () => run(proposal, { commit: field === "commit" ? bad : COMMIT }),
      /invalid value/,
    );
  });
}

test("a commit or tag other than the one reported is refused", () => {
  assert.throws(
    () => run(legitimate(), { commit: "c".repeat(40) }),
    /not the commit the job reported/,
  );
  assert.throws(() => run(legitimate(), { tag: "v1.2.3" }), /not the tag the job reported/);
});

test("a commit upstream does not name for the tag is refused", () => {
  assert.throws(
    () => run(legitimate(), { resolveTag: upstreamNames("d".repeat(40)) }),
    /upstream names/,
  );
});

test("the repository asked about is this checkout's, not the proposal's", () => {
  let asked;
  run(legitimate(), {
    resolveTag: (repository) => {
      asked = repository;
      return COMMIT;
    },
  });
  assert.equal(asked, JSON.parse(base.recipe).repository);
});

test("a proposal with exactly the expected regular files is read", () => {
  withDir(legitimate(), (dir) =>
    assert.deepEqual(Object.keys(readProposal(dir)).sort(), [
      "adapter-contract.json",
      "pr-body.md",
      "upstream.json",
    ]),
  );
});

test("an extra entry, a missing file or a directory is refused", () => {
  withDir({ ...legitimate(), "README.md": "x" }, (dir) =>
    assert.throws(() => readProposal(dir), /exactly/),
  );
  const missing = { ...legitimate() };
  delete missing["pr-body.md"];
  withDir(missing, (dir) => assert.throws(() => readProposal(dir), /exactly/));
  withDir(legitimate(), (dir) => {
    mkdirSync(join(dir, ".git"));
    assert.throws(() => readProposal(dir), /exactly/);
  });
});

test("a link in place of an expected file is refused", () => {
  const { "pr-body.md": body, ...rest } = legitimate();
  withDir(rest, (dir) => {
    const elsewhere = mkdtempSync(join(tmpdir(), "stac-pin-proposal-target-"));
    try {
      writeFileSync(join(elsewhere, "body"), body);
      symlinkSync(join(elsewhere, "body"), join(dir, "pr-body.md"));
      assert.throws(() => readProposal(dir), /not a regular file/);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

test("an oversized file is refused", () => {
  withDir({ ...legitimate(), "pr-body.md": "x".repeat(70 * 1024) }, (dir) =>
    assert.throws(() => readProposal(dir), /limit/),
  );
});

/** The legitimate proposal, moved to another release tag. */
function forTag(tag) {
  const proposal = legitimate();
  proposal["upstream.json"] = setField(proposal["upstream.json"], "tag", tag);
  proposal["adapter-contract.json"] = setField(proposal["adapter-contract.json"], "tag", tag);
  return proposal;
}

test("a release older than the pin is refused, even one upstream really names", () => {
  const pinned = JSON.parse(base.recipe).tag;
  for (const older of [
    "v0.0.1",
    "v4.9.9",
    pinned.replace(/\d+$/, (n) => String(Math.max(0, n - 1))),
  ]) {
    if (older === pinned) continue;
    assert.throws(() => run(forTag(older), { tag: older }), /not newer than the pinned/, older);
  }
});

test("the pinned release itself, at another commit, is refused", () => {
  const pinned = JSON.parse(base.recipe).tag;
  assert.throws(() => run(forTag(pinned), { tag: pinned }), /not newer than the pinned/);
});

test("the next patch release is accepted", () => {
  const pinned = JSON.parse(base.recipe).tag;
  const next = pinned.replace(/\d+$/, (n) => String(Number(n) + 1));
  assert.doesNotThrow(() => run(forTag(next), { tag: next }));
});

test("releases are ordered numerically, not as text", () => {
  assert.ok(compareReleases("v5.10.0", "v5.9.0") > 0);
  assert.ok(compareReleases("v10.0.0", "v9.99.99") > 0);
  assert.equal(compareReleases("v5.1.0", "v5.1.0"), 0);
  assert.throws(() => compareReleases("v5.1", "v5.1.0"), /stable release tag/);
});
