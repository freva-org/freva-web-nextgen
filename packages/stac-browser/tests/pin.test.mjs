/**
 * The pin mover rewrites fields in place. These check that it moves exactly the field it names,
 * keeps the file's formatting, and refuses rather than guesses when a key is missing or repeated.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  NOTICE_FILE,
  README_FILE,
  README_PIN,
  setField,
  setNoticePin,
  setReadmePin,
} from "../scripts/pin.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("moving the pin changes only the named fields", () => {
  const before = readFileSync(resolve(ROOT, "upstream.json"), "utf-8");
  const commit = "0".repeat(40);
  let after = setField(before, "commit", commit);
  after = setField(after, "tag", "v9.9.9");
  after = setField(after, "fileCount", 1234);
  const parsed = JSON.parse(after);
  assert.equal(parsed.commit, commit);
  assert.equal(parsed.tag, "v9.9.9");
  assert.equal(parsed.expected.fileCount, 1234);
  // Everything else, byte for byte: three lines differ and no more.
  const changed = before.split("\n").filter((line, i) => line !== after.split("\n")[i]);
  assert.equal(changed.length, 3);
  assert.equal(before.split("\n").length, after.split("\n").length);
});

test("the adapter contract's pin moves with it", () => {
  const before = readFileSync(resolve(ROOT, "adapter-contract.json"), "utf-8");
  const after = setField(setField(before, "tag", "v9.9.9"), "commit", "f".repeat(40));
  assert.deepEqual(JSON.parse(after).upstream, { tag: "v9.9.9", commit: "f".repeat(40) });
});

test("a missing or repeated key is refused, not guessed", () => {
  assert.throws(() => setField('{"a": "1"}', "b", "2"), /exactly one "b"/);
  assert.throws(() => setField('{"a": "1", "x": {"a": "2"}}', "a", "3"), /found 2/);
});

test("the root README links to upstream at exactly the pinned commit", () => {
  const pin = JSON.parse(readFileSync(resolve(ROOT, "upstream.json"), "utf-8"));
  const links = [...readFileSync(README_FILE, "utf-8").matchAll(README_PIN)];
  assert.equal(links.length, 1, "the README has no single link to upstream's tree at the pin");
  const [, short, full] = links[0];
  assert.equal(full, pin.commit, "the README links a different commit than upstream.json pins");
  assert.equal(short, pin.commit.slice(0, 7));
});

test("moving the README link keeps the table's width", () => {
  const before = readFileSync(README_FILE, "utf-8");
  const after = setReadmePin(before, "1".repeat(40));
  assert.equal(after.length, before.length);
  assert.match(
    after,
    /\[`1111111`\]\(https:\/\/github\.com\/radiantearth\/stac-browser\/tree\/1{40}\)/,
  );
});

test("moving the notice's pin keeps the table's width", () => {
  const before = readFileSync(NOTICE_FILE, "utf-8");
  const after = setNoticePin(before, "1".repeat(40), "v9.9.9");
  assert.equal(after.length, before.length);
  assert.match(after, /\| Version +\| `v9\.9\.9` +\|/);
  assert.match(after, new RegExp(`\\| Commit +\\| \`1{40}\` +\\|`));
  const changed = before.split("\n").filter((line, i) => line !== after.split("\n")[i]);
  assert.equal(changed.length, 2);
});

test("a notice with no row to move is refused, not rewritten", () => {
  assert.throws(() => setNoticePin("# nothing here\n", "0".repeat(40), "v1.0.0"), /found 0/);
});
