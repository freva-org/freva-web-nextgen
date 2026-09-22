/**
 * Prepare the STAC Browser materials the portal builder consumes.
 *
 * The network-enabled builder-image preparation job, and the only place upstream is fetched or
 * compiled: a consumer build reads `materials/` and nothing else - no clone, no inner `npm ci`,
 * no package download. Five things are deliberately dropped from the prepared tree; see DROP
 * below. What remains is the compiled application plus a manifest recording the upstream
 * tag/commit, the patch digests and a digest of every prepared file, so the portal artifact can
 * identify exactly which STAC it shipped.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyDistRecord } from "./dist-record.mjs";
import { publishStaged } from "./publish.mjs";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = process.env.FREVA_STAC_DIST_OUT
  ? resolve(process.env.FREVA_STAC_DIST_OUT)
  : resolve(PKG_ROOT, "dist");
// The output directory is an input: the preparation stage names it explicitly and hands the exact
// path to the portal build, so no build picks up a stale tree from a well-known location.
const MATERIALS = process.env.FREVA_STAC_MATERIALS_OUT
  ? resolve(process.env.FREVA_STAC_MATERIALS_OUT)
  : resolve(PKG_ROOT, "materials");
const PIN = JSON.parse(readFileSync(resolve(PKG_ROOT, "upstream.json"), "utf-8"));

const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/**
 * Code points, not UTF-16 code units and never a locale collation. The order is an input to the
 * tree digest, so it has to be the same on every machine.
 */
function compareCodePoints(a, b) {
  const x = [...a];
  const y = [...b];
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i += 1) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/**
 * The path grammar the consumer-side schema enforces, applied here so a bad name fails in the
 * preparation job that can fix it rather than in every consumer build that reads the result.
 */
// Control characters are refused deliberately; see config/paths.ts.
const MATERIALS_PATH =
  // eslint-disable-next-line no-control-regex
  /^(?!\/)(?![A-Za-z]:)(?!.*\/\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[^\u0000-\u001f\u007f\\%:*?"<>|]+(?<!\/)$/;

function listFiles(root, prefix = "") {
  const out = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    // A symlink is refused rather than skipped: dropping one silently produces a tree missing a
    // file the build expects, a worse failure than the one being avoided.
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Upstream dist contains the symbolic link '${rel}'. Prepared materials are copied by value.`,
      );
    }
    if (entry.isDirectory()) {
      out.push(...listFiles(root, rel));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Upstream dist contains '${rel}', which is not a regular file.`);
    }
    if (rel.normalize("NFC") !== rel || !MATERIALS_PATH.test(rel)) {
      throw new Error(
        `Upstream dist contains '${rel}', which is not a normalized relative POSIX path.`,
      );
    }
    out.push(rel);
  }
  return out.sort(compareCodePoints);
}

if (!existsSync(join(DIST, "index.html"))) {
  throw new Error(
    "packages/stac-browser/dist is missing. Run 'npm run stac:prepare', " +
      "the one supported network-enabled preparation command. It never runs during a portal " +
      "build and never at server startup.",
  );
}

// The compiled tree is verified against its own closed build record *before* anything is copied:
// a manifest minted around an unverified tree would faithfully record digests of the wrong bytes.
const verdict = verifyDistRecord({ pkgRoot: PKG_ROOT, distDir: DIST, pin: PIN });
if (!verdict.ok) {
  throw new Error(
    `packages/stac-browser/dist does not verify against its build record:\n  ${verdict.reasons.join("\n  ")}\n` +
      "Rebuild with FREVA_STAC_FORCE_BUILD=1 npm run build:upstream -w @freva-org/stac-browser.",
  );
}
const RECORD = verdict.record;

// Entry, stylesheets and mount element come from the *verified build record*, not from re-reading
// EMBED.json or scraping index.html - a second derivation is a second opinion that can disagree.
const entry = RECORD.embed.entry;
const styles = RECORD.embed.styles ?? [];
const mountId = RECORD.embed.mountId ?? "stac-browser-mount";

// WRITE INTO A DIRECTORY THIS SCRIPT CREATED, NEVER INTO THE ONE IT WAS GIVEN.
//
// `--out` is an arbitrary caller-supplied path (publish.mjs has the confinement rules), and
// assembling in place would leave the destination torn for the whole run - files appear one at a
// time, the manifest at the end, `PROVENANCE.json` later still, after containment assertions that
// can throw. Staging is a sibling of the destination, not a temp directory elsewhere, because the
// publish is a rename and a rename is only atomic within one filesystem. The name carries the pid
// and a random suffix so two concurrent preparations aimed at the same destination stage
// independently; `prepare.mjs` publishes, and the last complete tree wins.
const STAGING = `${MATERIALS}.staging-${process.pid}-${randomBytes(4).toString("hex")}`;
mkdirSync(STAGING, { recursive: true });

// WHAT NEVER REACHES A PORTAL ARTIFACT.
//
// `runtime-config.js` - deployment-owned STAC configuration is exactly what the closed adapter
// replaces; the portal generates, bundles and content-hashes it, and an FP-001 artifact has no
// deployment-owned script.
//
// `index.html` - the portal generates the component route itself, so upstream's document and its
// script and link tags would be a second, unused entry point into the same application.
//
// `.htaccess` - an Apache rewrite sending unmatched requests to `index.html`, contradicting the
// artifact's own host policy: no `index.html` is published here and `spaFallback: false` is
// declared, because a deep link into the component is a real file. A stray rewrite rule gets
// picked up by whichever server reads it.
//
// `sw.js` and `mitm.html` - StreamSaver's service worker and its message-port frame, from
// upstream's alternative-download path. The portal's `default-src 'none'` policy has no
// `worker-src` and no `frame-src`, so both are refused today - dead bytes, but not neutral ones:
// a service worker at the deployment's own origin intercepts every request under its scope, one
// relaxed directive or one host serving its own CSP away from being live, and outlives the page
// that registered it. Upstream's "alternative download" therefore fails, as it already does under
// this policy; `tests/materials-drop.test.mjs` states the rule and the portal's browser suite
// checks that no worker registers on the catalogue route.
const DROP = new Set(["index.html", "runtime-config.js", ".htaccess", "sw.js", "mitm.html"]);
const copied = [];
for (const rel of listFiles(DIST)) {
  if (DROP.has(rel)) continue;
  const target = join(STAGING, rel);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(join(DIST, rel), target);
  copied.push(rel);
}

if (!copied.includes(entry)) {
  throw new Error(`The entry '${entry}' was not among the prepared files.`);
}
for (const style of styles) {
  if (!copied.includes(style)) {
    throw new Error(`The stylesheet '${style}' was not among the prepared files.`);
  }
}

// The patch series as the verified record states it, in apply order.
const patches = RECORD.patches;

const files = copied.map((rel) => ({
  path: rel,
  digest: sha256(readFileSync(join(STAGING, rel))),
  bytes: statSync(join(STAGING, rel)).size,
}));

// Case, percent and Unicode folding, so two prepared files cannot become one on a
// case-insensitive or normalizing filesystem.
const byKey = new Map();
for (const file of files) {
  const key = decodeURIComponent(file.path).normalize("NFC").toLowerCase();
  const previous = byKey.get(key);
  if (previous !== undefined) {
    throw new Error(
      `Prepared files '${previous}' and '${file.path}' collide under case and Unicode folding.`,
    );
  }
  byKey.set(key, file.path);
}

const treeHash = createHash("sha256");
for (const file of files) treeHash.update(file.path).update("\0").update(file.digest).update("\n");

const manifest = {
  schemaVersion: 1,
  kind: "stac-browser-materials",
  upstream: {
    repository: PIN.repository,
    tag: RECORD.tag,
    commit: RECORD.commit,
  },
  patches,
  entry,
  styles,
  mountId,
  files,
  treeDigest: `sha256:${treeHash.digest("hex")}`,
  producer: "@freva-org/stac-browser prepare-materials",
};

writeFileSync(join(STAGING, "materials.json"), `${JSON.stringify(manifest, null, 2)}\n`);

// The staged path is the result: `prepare.mjs` runs the containment assertions and writes
// provenance INTO the staging directory, then publishes by rename. A standalone
// `npm run prepare:materials` stages the same way and publishes it itself below.
if (process.env.FREVA_STAC_STAGE_ONLY === "1") {
  process.stdout.write(`${STAGING}\n`);
} else {
  publishStaged(STAGING, MATERIALS);
  console.log(
    `[stac-browser] prepared ${files.length} material(s) in ${relative(process.cwd(), MATERIALS)} ` +
      `(entry ${entry}, tree ${manifest.treeDigest.slice(0, 19)}...)`,
  );
}
