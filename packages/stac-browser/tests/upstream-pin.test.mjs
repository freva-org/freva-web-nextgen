/**
 * Tests for the STAC build workspace. Most need no built dist/; the ones that do skip loudly
 * rather than pass vacuously, and fail under STAC_STRICT=1 (set in CI).
 */
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { verifyDistRecord } from "../scripts/dist-record.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pin = JSON.parse(readFileSync(resolve(ROOT, "upstream.json"), "utf-8"));
const read = (rel) => readFileSync(resolve(ROOT, rel), "utf-8");
const STRICT = process.env.STAC_STRICT === "1";

/** Skip when the artefact has not been built, unless CI demands it. */
function requireDist(t) {
  if (existsSync(resolve(ROOT, "dist/index.html"))) return true;
  if (STRICT) assert.fail("dist/ is missing and STAC_STRICT=1 forbids skipping.");
  t.skip("dist/ not built - run 'npm run build:upstream -w @freva-org/stac-browser'");
  return false;
}

test("the pin names an exact tag and a full commit", () => {
  assert.match(pin.tag, /^v\d+\.\d+\.\d+$/, "the pin must be a stable release tag");
  assert.match(pin.commit, /^[0-9a-f]{40}$/, "the pin must be a full 40-character commit");
  assert.equal(pin.repository, "https://github.com/radiantearth/stac-browser.git");
  assert.equal(pin.license, "ISC");
});

test("the pin is not a moving branch", () => {
  const raw = read("upstream.json");
  assert.ok(!/"(?:branch|ref)"\s*:\s*"(?:main|master|HEAD)"/.test(raw));
  for (const script of ["scripts/prepare.mjs", "scripts/build.mjs", "scripts/upstream.mjs"]) {
    const body = read(script);
    assert.ok(
      !/origin\/(?:main|master)|--branch\s+main/.test(body),
      `${script} must not reach for a moving branch`,
    );
  }
});

test("the workspace is private and never published", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.name, "@freva-org/stac-browser");
  assert.equal(pkg.private, true);
  assert.equal(pkg.publishConfig, undefined);
  // `private` is one boolean from publishing a compiled third-party application and its upstream
  // checkout, so the allow-list removes the failure mode; `published-inventory.test.mjs` then
  // checks the result against npm's own file list.
  assert.ok(Array.isArray(pkg.files), "the recipe workspace needs an explicit files allow-list");
  for (const forbidden of ["dist", "materials", ".upstream"]) {
    assert.ok(
      !pkg.files.includes(forbidden),
      `'${forbidden}' is in the files allow-list; the compiled application must never be publishable`,
    );
  }
});

test("STAC is configured for a non-root mount with hash routing", () => {
  assert.equal(pin.config.pathPrefix, "/stac/");
  assert.equal(pin.config.historyMode, "hash");
});

test("the ISC notice is staged in the workspace", () => {
  const text = read("LICENSES/stac-browser-ISC.txt");
  assert.match(text, /Radiant Earth Foundation/);
  assert.match(text, /Permission to use, copy, modify, and\/or distribute this software/);
});

test("the third-party notice carries the required wording", () => {
  const text = read("THIRD_PARTY_NOTICES.md");
  // Compare on collapsed whitespace: the notice is prose and may be rewrapped.
  const flat = text.replace(/\s+/g, " ");
  for (const phrase of [
    "Freva integration of Radiant Earth's STAC Browser",
    "distributed under the ISC License",
    "STAC Browser is a third-party component",
    "This is not an official Radiant Earth release",
  ]) {
    assert.ok(flat.includes(phrase), `missing required wording: ${phrase}`);
  }
  assert.ok(text.includes(pin.commit), "the notice must record the exact commit");
  assert.ok(text.includes(pin.tag), "the notice must record the exact tag");
});

test("every applied patch is documented, and the Waterpark base is named", () => {
  const text = read("PATCH_PROVENANCE.md");
  assert.ok(text.includes("75fa292087dab160bc10389d2a3238fa6712cf11"), "Waterpark base commit");
  const applied = readdirSync(resolve(ROOT, "patches")).filter((f) => f.endsWith(".patch"));
  assert.ok(applied.length > 0, "the embed needs at least the mount patch");
  for (const patch of applied) {
    assert.ok(
      text.includes(patch.replace(/^\d+-/, "").replace(/\.patch$/, "")),
      `applied patch ${patch} is not accounted for in PATCH_PROVENANCE.md`,
    );
  }
  // The four Waterpark patches deliberately NOT carried are named too, so an omission stays a
  // decision rather than an oversight.
  for (const dropped of ["modal-teleport", "readmore-expanded", "validation-link", "vite"]) {
    assert.ok(text.includes(dropped), `dropped patch ${dropped} is not accounted for`);
  }
});

// Prose drifts from the count of record in `upstream.json`, so every count stated in
// `PATCH_PROVENANCE.md`, `UPSTREAM.md`, `packages/portal/docs/stac.md` or the delivery notes is
// checked against it - spelled, and only beside "patch", since "four hops" is not this series.
const NUMBER_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
];

test("no document states a patch count the recipe does not have", () => {
  const recipe = JSON.parse(read("upstream.json"));
  const actual = recipe.patches.series.length;
  const spelled = NUMBER_WORDS[actual];
  assert.ok(spelled, `the series has ${actual} patches, beyond the spelled range`);

  const documents = [
    "PATCH_PROVENANCE.md",
    "UPSTREAM.md",
    "../portal/docs/stac.md",
    "../../delivery/STAC-OWNERSHIP-REFACTOR.md",
  ];
  // "<number> ... patch" within a short window, and the reverse order for phrasings like
  // "patches: seven". Deliberately narrow: a false positive here is a document nobody can edit.
  const wrong = NUMBER_WORDS.filter((word) => word !== spelled).map((word) => ({
    word,
    pattern: new RegExp(`\\b${word}\\b[^.\n|]{0,40}?\\bpatch(es)?\\b`, "i"),
  }));

  for (const document of documents) {
    let text;
    try {
      text = read(document);
    } catch {
      continue; // a document that has been retired is not a drift
    }
    for (const line of text.split("\n")) {
      // Sentences about what upstream or Waterpark carries are not about our series.
      if (/upstream'?s|Waterpark|hops/i.test(line)) continue;
      for (const { word, pattern } of wrong) {
        assert.ok(
          !pattern.test(line),
          `${document} says "${word}" patches; the recipe has ${actual} (${spelled}):\n  ${line.trim()}`,
        );
      }
    }
  }
});

test("no Waterpark patch text was copied into the repository", () => {
  // Waterpark's series carries no licence grant, so its content must not appear here. Our patches
  // are written against our own pin; a copied one would give itself away by Waterpark's global.
  const provenance = read("PATCH_PROVENANCE.md");
  assert.ok(
    !provenance.includes("__WATERPARK_STAC_APP__"),
    "provenance must describe the patches, not reproduce their code",
  );
  for (const patch of readdirSync(resolve(ROOT, "patches"))) {
    const text = readFileSync(resolve(ROOT, "patches", patch), "utf-8");
    assert.ok(
      !text.includes("__WATERPARK_STAC_APP__") && !text.includes("waterpark"),
      `${patch} contains Waterpark patch text`,
    );
  }
});

test("the built artefact matches the pin", (t) => {
  if (!requireDist(t)) return;
  const info = JSON.parse(read("dist/BUILDINFO.json"));
  assert.equal(info.commit, pin.commit);
  assert.equal(info.tag, pin.tag);
  assert.deepEqual(
    info.patches.map((patch) => patch.name),
    readdirSync(resolve(ROOT, "patches"))
      .filter((f) => f.endsWith(".patch"))
      .sort(),
    "the build record must list exactly the patches that were applied",
  );
  for (const patch of info.patches) {
    assert.match(patch.digest, /^sha256:[0-9a-f]{64}$/, `${patch.name} has no digest`);
  }
});

test("the built artefact verifies against its own closed record", (t) => {
  if (!requireDist(t)) return;
  // The record is a checkable statement about the tree, not a summary written down beside it.
  const verdict = verifyDistRecord({
    pkgRoot: ROOT,
    distDir: resolve(ROOT, "dist"),
    pin,
  });
  assert.deepEqual(verdict.reasons, [], "the compiled tree does not verify");
  assert.equal(verdict.ok, true);
  assert.match(verdict.record.treeDigest, /^sha256:[0-9a-f]{64}$/);
  assert.ok(verdict.record.embed.entry.startsWith("assets/"), "the record names no entry module");
});

test("a changed dist file fails verification even with an untouched record", (t) => {
  if (!requireDist(t)) return;
  // Edit one byte, leave BUILDINFO.json alone, and the tree must stop verifying.
  const scratch = mkdtempSync(join(tmpdir(), "stac-dist-tamper-"));
  try {
    cpSync(resolve(ROOT, "dist"), join(scratch, "dist"), { recursive: true });
    const before = verifyDistRecord({ pkgRoot: ROOT, distDir: join(scratch, "dist"), pin });
    assert.equal(before.ok, true, "the copy must verify before it is tampered with");

    const victim = join(scratch, "dist", "THIRD_PARTY_NOTICES.md");
    writeFileSync(victim, `${readFileSync(victim, "utf-8")}\n<!-- tampered -->\n`);

    const after = verifyDistRecord({ pkgRoot: ROOT, distDir: join(scratch, "dist"), pin });
    assert.equal(after.ok, false, "a changed file must not verify");
    assert.ok(
      after.reasons.some((reason) => reason.includes("hashes to")),
      `expected a tree-digest mismatch, got: ${after.reasons.join(" | ")}`,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("an edited patch file fails verification", (t) => {
  if (!requireDist(t)) return;
  const scratch = mkdtempSync(join(tmpdir(), "stac-patch-tamper-"));
  try {
    cpSync(resolve(ROOT, "dist"), join(scratch, "dist"), { recursive: true });
    cpSync(resolve(ROOT, "patches"), join(scratch, "patches"), { recursive: true });
    const patch = readdirSync(join(scratch, "patches")).filter((f) => f.endsWith(".patch"))[0];
    writeFileSync(
      join(scratch, "patches", patch),
      `${readFileSync(join(scratch, "patches", patch), "utf-8")}\n`,
    );
    const verdict = verifyDistRecord({
      pkgRoot: scratch,
      distDir: join(scratch, "dist"),
      pin,
    });
    assert.equal(verdict.ok, false);
    assert.ok(
      verdict.reasons.some((reason) => reason.includes("has been edited since the build")),
      `expected an edited-patch finding, got: ${verdict.reasons.join(" | ")}`,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("the built artefact mounts at a non-root path", (t) => {
  if (!requireDist(t)) return;
  const html = read("dist/index.html");
  assert.ok(html.includes('<base href="/stac/"'), "missing <base href> for the /stac/ mount");
  const withoutBase = html.replace(/<base\b[^>]*>/g, "");
  assert.ok(
    !/(?:src|href)="\/(?!\/)/.test(withoutBase),
    "root-absolute asset URL would break a non-root mount",
  );
  assert.match(html, /src="\.\/assets\//, "assets must be document-relative");
});

test("the built artefact carries the ISC notice", (t) => {
  if (!requireDist(t)) return;
  assert.equal(
    read("dist/LICENSES/stac-browser-ISC.txt"),
    read("LICENSES/stac-browser-ISC.txt"),
    "the notice in dist/ must be byte-identical to the staged one",
  );
  assert.ok(existsSync(resolve(ROOT, "dist/THIRD_PARTY_NOTICES.md")));
});

test("runtime configuration is enabled and deployment-owned", (t) => {
  if (!requireDist(t)) return;
  const html = read("dist/index.html");
  assert.ok(html.includes('src="./runtime-config.js"'));
  const rc = read("dist/runtime-config.js");
  assert.match(rc, /window\.STAC_BROWSER_CONFIG = \{\};/, "ships empty");
  assert.ok(
    rc.includes("never be generated from"),
    "must warn against generating it from settings",
  );
});

test("no test fixtures ship in the artefact", (t) => {
  if (!requireDist(t)) return;
  assert.ok(!existsSync(resolve(ROOT, "dist/mockServiceWorker.js")));
});
