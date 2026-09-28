// What makes a preparation reproducible, and what tells a tree mismatch's two causes apart:
// `patchedSourceDigest` (commit + patches only) separates a different patch result (a defect: stop)
// from different bundler output (the toolchain: explain). Upstream compiles every `SB_*` variable
// into the bundle, so the build environment is the recipe's, not the caller's.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertPatchedSource,
  patchedSourceDigest,
  toolchainFingerprint,
  upstreamBuildEnv,
} from "../scripts/recipe.mjs";
import { describeToolchain, setField } from "../scripts/pin.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const recipe = JSON.parse(readFileSync(resolve(ROOT, "upstream.json"), "utf-8"));

/** A fake checkout holding every file the recipe records as patched. */
function checkout(content = (rel) => `content of ${rel}\n`) {
  const dir = mkdtempSync(join(tmpdir(), "stac-repro-"));
  for (const rel of recipe.patchedTree.files) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content(rel));
  }
  return dir;
}

test("the recipe records the patch result, the tree and the toolchain it was recorded on", () => {
  assert.match(recipe.expected.patchedSourceDigest, /^sha256:[0-9a-f]{64}$/);
  assert.match(recipe.expected.materialsTreeDigest, /^sha256:[0-9a-f]{64}$/);
  assert.match(recipe.expected.recordedWith, /^node \d+\.\d+\.\d+, npm \d+\.\d+\.\d+, \w+\/\w+$/);
});

test("the patch-result digest is content-addressed and order-independent", () => {
  const a = checkout();
  const b = checkout();
  try {
    assert.equal(patchedSourceDigest(a, recipe), patchedSourceDigest(b, recipe));
    // The recipe's own list order does not matter; the digest sorts by code point.
    const reversed = {
      ...recipe,
      patchedTree: { files: [...recipe.patchedTree.files].reverse() },
    };
    assert.equal(patchedSourceDigest(a, reversed), patchedSourceDigest(a, recipe));
    // One byte in one file moves it - including a line ending, which is how autocrlf shows up.
    const first = recipe.patchedTree.files[0];
    writeFileSync(join(b, first), `content of ${first}\r\n`);
    assert.notEqual(patchedSourceDigest(a, recipe), patchedSourceDigest(b, recipe));
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("a different patch result stops the build; a recipe without the field is not checked", () => {
  const dir = checkout();
  try {
    const actual = patchedSourceDigest(dir, recipe);
    assert.equal(
      assertPatchedSource(dir, { ...recipe, expected: { patchedSourceDigest: actual } }),
      actual,
    );
    assert.throws(
      () => assertPatchedSource(dir, { ...recipe, expected: { patchedSourceDigest: "sha256:0" } }),
      /patch RESULT differs[\s\S]*not a toolchain difference/,
    );
    assert.equal(assertPatchedSource(dir, { ...recipe, expected: {} }), actual);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing patched file is named, not hashed as empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "stac-repro-empty-"));
  try {
    assert.throws(() => patchedSourceDigest(dir, recipe), /is not in the checkout/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("upstream's build sees the recipe's configuration and none of the caller's", () => {
  const env = upstreamBuildEnv(
    {
      PATH: "/usr/bin",
      HOME: "/home/x",
      HTTPS_PROXY: "http://proxy",
      npm_config_cache: "/cache",
      SB_catalogUrl: "https://leaked.example.org/",
      SB_CONFIG: "/tmp/leaked-config.js",
      DYNAMIC_CONFIG: "false",
      STAC_BROWSER_E2E: "true",
      NODE_ENV: "development",
    },
    { DYNAMIC_CONFIG: "true", SB_pathPrefix: "/stac/", NODE_ENV: "production" },
  );
  assert.deepEqual(env, {
    PATH: "/usr/bin",
    HOME: "/home/x",
    HTTPS_PROXY: "http://proxy",
    npm_config_cache: "/cache",
    DYNAMIC_CONFIG: "true",
    SB_pathPrefix: "/stac/",
    NODE_ENV: "production",
  });
});

test("the recorded toolchain line is one field the pin mover can move", () => {
  const line = describeToolchain(toolchainFingerprint());
  assert.match(line, /^node \d+\.\d+\.\d+, npm \S+, \w+\/\w+$/);
  const text = readFileSync(resolve(ROOT, "upstream.json"), "utf-8");
  assert.equal(JSON.parse(setField(text, "recordedWith", line)).expected.recordedWith, line);
});

test("the cache key covers the preparation procedure, not only its inputs", async () => {
  // A cache made by another procedure must not count as prepared: a script change moves the key.
  const { cpSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  const copy = mkdtempSync(join(tmpdir(), "stac-key-"));
  try {
    for (const entry of ["scripts", "patches", "upstream.json", "adapter-contract.json"]) {
      cpSync(resolve(ROOT, entry), join(copy, entry), { recursive: true });
    }
    writeFileSync(join(copy, "package.json"), '{"type":"module"}');
    const key = () =>
      execFileSync(process.execPath, [join(copy, "scripts", "prepare.mjs"), "--cache-key"], {
        encoding: "utf-8",
      }).trim();
    const before = key();
    const own = execFileSync(
      process.execPath,
      [resolve(ROOT, "scripts", "prepare.mjs"), "--cache-key"],
      {
        encoding: "utf-8",
      },
    ).trim();
    assert.equal(before, own, "a byte-identical copy of the recipe must give the same key");
    const build = join(copy, "scripts", "build.mjs");
    writeFileSync(build, `${readFileSync(build, "utf-8")}\n// a changed procedure\n`);
    assert.notEqual(key(), before, "changing build.mjs did not change the cache key");
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});
