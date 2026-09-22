/**
 * Compile the pinned STAC Browser into `packages/stac-browser/dist/`, a self-contained static SPA
 * that is *not* published: `@freva-org/portal` copies this directory into its own artefact.
 *
 * Three choices, documented in UPSTREAM.md: `--mode minimal`, upstream's no-sourcemap build,
 * because sourcemaps of a third-party bundle triple the published tarball; `DYNAMIC_CONFIG=true`,
 * making assets document-relative and `dist/runtime-config.js` the deployment-owned override that
 * repoints STAC without a rebuild; and `historyMode: hash`, one document, so
 * `/stac/#/collections/x` survives a reload on a static file server with no rewrite rules and
 * cannot collide with the portal shell's history fallback. It also applies `patches/`, which makes
 * a whole-page application hostable inside the portal shell - see PATCH_PROVENANCE.md.
 */
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

import {
  assertPinnedCommit,
  distDir,
  git,
  PKG_ROOT,
  readPin,
  run,
  upstreamDir,
} from "./upstream.mjs";
import { buildRecord, verifyDistRecord } from "./dist-record.mjs";
import {
  assertLicense,
  assertLockfile,
  assertPatchDigests,
  assertToolchain,
  patchSeries,
  readRecipe,
} from "./recipe.mjs";

const pin = readPin();
const SRC = upstreamDir();
// This run's output tree. Shared `dist/` by default; a per-run workspace under `prepare.mjs`.
const DIST_DIR = distDir();

// 0. Skip a rebuild that would produce the same bytes. Compiling upstream takes about a minute,
// and preparation can reach this script more than once; `FREVA_STAC_FORCE_BUILD=1` forces one
// anyway. It is `build:upstream`, not `build`, so the root `npm run build --workspaces` never
// needs a fetched checkout. "Matches"
// has to include the *patches* - editing one leaves the commit and the build mode unchanged - so
// reuse is decided by the closed build record, not by three fields and the presence of
// index.html, which a file edited after the build leaves untouched.
if (process.env.FREVA_STAC_FORCE_BUILD !== "1" && existsSync(resolve(DIST_DIR, "BUILDINFO.json"))) {
  const verdict = verifyDistRecord({ pkgRoot: PKG_ROOT, distDir: DIST_DIR, pin });
  if (verdict.ok) {
    console.log(`[stac-browser] dist/ already matches ${pin.tag} (${pin.commit}); nothing to do`);
    process.exit(0);
  }
  console.log("[stac-browser] rebuilding; the existing dist/ does not verify:");
  for (const reason of verdict.reasons) console.log(`[stac-browser]   - ${reason}`);
}

if (!existsSync(SRC)) {
  throw new Error(
    `No upstream checkout at ${SRC}. Run 'npm run stac:prepare' - the one ` +
      "supported, network-enabled preparation command.",
  );
}
assertPinnedCommit(SRC, pin);

// 0b. The recipe's own gates, before a single file is touched: cheap, and they fail with a name.
// Finding a relicensed upstream or a changed dependency tree in a diff of the compiled output is
// how a supply chain gets surprised.
const recipe = readRecipe();
assertToolchain(recipe);
assertPatchDigests(recipe);
assertLockfile(SRC, recipe);
assertLicense(SRC, recipe);

const patchDir = resolve(PKG_ROOT, "patches");
const patches = existsSync(patchDir)
  ? readdirSync(patchDir)
      .filter((name) => name.endsWith(".patch"))
      .sort()
  : [];
/** Every path this build writes: the runtime-config toggle, plus the patches. */
const patchedFiles = new Set(
  patches.flatMap((name) =>
    readFileSync(resolve(patchDir, name), "utf-8")
      .split("\n")
      .filter((line) => line.startsWith("+++ b/"))
      .map((line) => line.slice("+++ b/".length).trim()),
  ),
);

// Reset only those files, so a rebuild without a re-fetch starts from pinned content and patches
// apply cleanly. Everything else is left alone, so the tamper check below has something to see.
const owned = new Set(["index.html", ...patchedFiles]);
const stale = git(["diff", "--name-only"], SRC)
  .split("\n")
  .filter(Boolean)
  .filter((file) => owned.has(file));
if (stale.length) git(["checkout", "--", ...stale], SRC);

// 1. Enable upstream's runtime-config entry point. Not a patch: `index.html` ships the tags
// already, commented out, and docs/options.md instructs a deployment to remove the `<!--RC` /
// `RC-->` markers. Doing it here keeps the retained Freva change-set at zero source patches.
const INDEX = resolve(SRC, "index.html");
const original = readFileSync(INDEX, "utf-8");
const enabled = original
  .replace(/^[ \t]*<!--RC[ \t]*\r?\n/m, "")
  .replace(/^[ \t]*RC-->[ \t]*\r?\n/m, "");
if (enabled === original && !original.includes("stac-browser-base")) {
  throw new Error(
    "index.html no longer contains the RC markers upstream documents for runtime " +
      "configuration. Re-read docs/options.md for this revision before upgrading the pin.",
  );
}
writeFileSync(INDEX, enabled);

// 1b. Apply the Freva patch set, from a clean checkout of the pinned commit, in filename order.
// The whole series is `git apply --check`ed first, so a series that cannot land leaves the
// checkout untouched rather than half-patched. The check is exact - no fuzz, no three-way merge -
// because a patch that "mostly" applies produces an artifact the patch does not describe.
const series = patchSeries(recipe);
// A patch in this series changes tracked files only. Preparation restores tracked paths, so an
// untracked file a patch ADDED is left behind and `git apply` then refuses that patch with
// "already exists in working directory": the series applies once and fails on every run after.
// The checks either side share the blind spot - `patchedTree.files` is compared against `git diff
// --name-only`, tracked paths only. Cleaning untracked files first would delete generated files
// the checkout legitimately carries, so an add is refused; what a patch needs goes INTO a file
// upstream already has.
const adds = series.filter((patch) => /^new file mode /m.test(readFileSync(patch.path, "utf8")));
if (adds.length) {
  throw new Error(
    `[stac-browser] ${adds.map((p) => p.name).join(", ")} add file(s) to the checkout.\n` +
      "  A patch in this series may only modify files the pinned revision already has: preparation\n" +
      "  restores tracked paths between runs, so an added file survives and the patch stops\n" +
      "  applying on the second run. Fold the new code into a file upstream already ships.",
  );
}
try {
  run("git", ["apply", "--check", "--whitespace=nowarn", ...series.map((p) => p.path)], SRC);
} catch {
  throw new Error(
    `[stac-browser] the patch series does not apply to ${pin.tag} (${pin.commit}).\n` +
      `  upstream pin:   ${pin.commit} (${pin.tag})\n` +
      `  patch series:   ${series.map((p) => p.name).join(", ")}\n` +
      "  Nothing has been changed in the checkout.\n" +
      "  To investigate, from packages/stac-browser:\n" +
      `    git -C ${SRC} apply --check -v patches/<name>.patch\n` +
      "  Re-derive the failing patch against this revision and update its digest in " +
      "upstream.json. Never drop, regenerate or bypass a patch to get a build through.",
  );
}
for (const patch of series) {
  try {
    run("git", ["apply", "--whitespace=nowarn", patch.path], SRC);
  } catch (error) {
    throw new Error(
      `[stac-browser] patch ${patch.name} failed to apply after passing --check.\n` +
        `  upstream pin:     ${pin.commit} (${pin.tag})\n` +
        `  failed patch:     ${patch.name}\n` +
        `  expected digest:  ${patch.digest}\n` +
        `  investigate with: git -C ${SRC} apply --check -v ${patch.path}\n` +
        `  Underlying error: ${error.message}`,
    );
  }
}
console.log(`[stac-browser] applied ${series.length} patch(es) in recipe order`);

// The working tree must now differ from the pinned commit in exactly the files the patch set and
// the runtime-config toggle touch, and nothing else; a stale or tampered checkout stops the build.
const dirty = git(["diff", "--name-only"], SRC).split("\n").filter(Boolean);
// Both directions: unexpected files catch a tampered checkout, missing ones a patch that applied
// without changing anything - invisible to `--check`, and it would ship an undescribed artifact.
const declaredDirty = new Set(recipe.patchedTree.files);
const missing = [...declaredDirty].filter((f) => !dirty.includes(f));
if (missing.length) {
  throw new Error(
    `The patch series left ${missing.join(", ")} unchanged. The recipe records these paths as ` +
      "modified, so a clean copy means a patch applied as a no-op against this revision.",
  );
}
const unexpected = dirty.filter((f) => !declaredDirty.has(f));
if (unexpected.length) {
  // Listing hundreds of paths buries the instruction: show a handful and the count.
  const sample = unexpected.slice(0, 5).join(", ");
  throw new Error(
    `The upstream checkout has ${unexpected.length} unexpected local ` +
      `modification(s), e.g. ${sample}${unexpected.length > 5 ? ", ..." : ""}. ` +
      "A repository-wide formatter or linter is the usual cause; " +
      "packages/stac-browser/.upstream/ must be excluded from both. " +
      "Fix: rm -rf packages/stac-browser/.upstream && npm run stac:prepare",
  );
}
const indexDiff = git(["diff", "--unified=0", "--", "index.html"], SRC)
  .split("\n")
  .filter((l) => /^[+-][^+-]/.test(l))
  .map((l) => l.slice(1).trim());
const allowed = new Set(["<!--RC", "RC-->"]);
const violations = indexDiff.filter((l) => !allowed.has(l));
if (violations.length) {
  throw new Error(
    `index.html was changed beyond removing the RC comment markers: ${violations.join(" | ")}`,
  );
}

// 2. Install upstream's own pinned dependency tree: `npm ci` inside .upstream against upstream's
// package-lock.json, deliberately NOT hoisted into the Freva root lockfile. STAC Browser's ~800
// packages would slow every `npm ci` here and entangle two unrelated dependency graphs.
if (!existsSync(resolve(SRC, "node_modules"))) {
  console.log("[stac-browser] installing upstream dependencies (npm ci)");
  run("npm", ["ci", "--no-audit", "--no-fund"], SRC);
}

// 3. Build.
const env = {
  DYNAMIC_CONFIG: "true",
  SB_pathPrefix: pin.config.pathPrefix,
  SB_historyMode: pin.config.historyMode,
  SB_catalogTitle: pin.config.catalogTitle,
  // Vite reads NODE_ENV; keep the build deterministic regardless of the caller.
  NODE_ENV: "production",
};
console.log(`[stac-browser] building ${pin.tag} (${pin.buildMode} mode)`);
run("npm", ["run", `build:${pin.buildMode}`], SRC, env);

// 4. Assemble dist/.
const built = resolve(SRC, "dist");
if (!existsSync(resolve(built, "index.html"))) {
  throw new Error("The upstream build produced no dist/index.html.");
}
rmSync(DIST_DIR, { recursive: true, force: true });
mkdirSync(DIST_DIR, { recursive: true });
cpSync(built, DIST_DIR, { recursive: true });

// 4b. Scope the three global rule-sets to the embed. STAC Browser imports the whole of Bootstrap,
// which writes to `:root`, `html` and `body`; inside the portal those rules would restyle the
// shell's header, footer and type. The rest of upstream's CSS is safe already - component styles
// are `#stac-browser`-scoped or carry a `data-v-` hash - so only the selectors naming the document
// are rewritten. A general prefixing pass over 300 KB of third-party CSS is easier to get wrong.
const EMBED_ROOT = "#stac-browser-mount";

/** Split a selector list on commas that are not inside brackets or quotes. */
function splitSelectors(list) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let current = "";
  for (const char of list) {
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "(" || char === "[") {
      depth += 1;
    } else if (char === ")" || char === "]") {
      depth -= 1;
    } else if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

/**
 * Rewrite one selector so it can no longer match the host document.
 *
 * `:root`/`html`/`body` become the mount element itself. A *leading* `[data-bs-theme=…]` is
 * concatenated rather than descended into, because Bootstrap sets that attribute on the same
 * element it themes; a non-leading one - `.navbar[data-bs-theme=dark]` - is a component rule, left
 * alone. The dark block must be scoped as well as the light one: upstream's
 * `:root,[data-bs-theme=light]` and `[data-bs-theme=dark]` have equal specificity, so source order
 * decides, and scoping only the first makes it an id selector that outranks the dark block meant
 * to override it - the application then goes halfway dark, with everything driven by a Bootstrap
 * variable staying light.
 */
function scopeSelector(selector) {
  const trimmed = selector.trim();
  if (!trimmed) return selector;
  if (trimmed.includes("#stac-browser")) return trimmed;
  if (/^\[data-bs-theme/.test(trimmed)) return `${EMBED_ROOT}${trimmed}`;
  const head = /^(:root|html|body)(?![\w-])/.exec(trimmed);
  if (head) return `${EMBED_ROOT}${trimmed.slice(head[1].length)}`;
  return trimmed;
}

const GLOBAL_RULE = /(^|[},])([^{}@]*?)(:root|\bhtml\b|\bbody\b|\[data-bs-theme)([^{}]*?)\{/g;
let scopedRules = 0;
const cssFiles = readdirSync(resolve(DIST_DIR, "assets")).filter((name) => name.endsWith(".css"));
for (const name of cssFiles) {
  const file = resolve(DIST_DIR, "assets", name);
  const before = readFileSync(file, "utf-8");
  const after = before.replace(GLOBAL_RULE, (match, lead, head, token, tail) => {
    const list = `${head}${token}${tail}`;
    const scoped = splitSelectors(list).map(scopeSelector).join(",");
    if (scoped !== list.trim()) scopedRules += 1;
    return `${lead}${scoped}{`;
  });
  if (after !== before) writeFileSync(file, after);
}

// Assert the result rather than trust the regular expression: a selector that still names the
// document would be found by a visitor, not by this build. One that also names `#stac-browser` is
// exempt - `[data-bs-theme=dark] #stac-browser .fullscreen` ends inside the embed.
const namesDocument = (selector) => {
  const trimmed = selector.trim();
  if (!trimmed || trimmed.includes("#stac-browser")) return false;
  return /^(:root|html|body)(?![\w-])/.test(trimmed) || /^\[data-bs-theme/.test(trimmed);
};
for (const name of cssFiles) {
  const text = readFileSync(resolve(DIST_DIR, "assets", name), "utf-8");
  for (const match of text.matchAll(GLOBAL_RULE)) {
    const offenders = splitSelectors(`${match[2]}${match[3]}${match[4]}`).filter(namesDocument);
    if (offenders.length) {
      throw new Error(
        `[stac-browser] ${name} still carries a rule that names the document itself: ` +
          `${offenders.join(", ")}. The portal embeds this CSS in its own document, so that rule ` +
          "would either restyle the shell or outrank the theme block meant to override it.",
      );
    }
  }
}
console.log(`[stac-browser] scoped ${scopedRules} global rule-set(s) to ${EMBED_ROOT}`);

// 4c. Record what the portal has to load. Entry file names are content-hashed, so the host cannot
// guess them; they are read back out of upstream's own index.html - which the embed does not use
// - rather than from a build manifest, which would need a patch to enable.
const indexHtml = readFileSync(resolve(DIST_DIR, "index.html"), "utf-8");
const entry = /<script[^>]+type="module"[^>]+src="\.?\/?([^"]+)"/.exec(indexHtml);
const styles = [...indexHtml.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="\.?\/?([^"]+)"/g)].map(
  (match) => match[1],
);
if (!entry) {
  throw new Error(
    "[stac-browser] no module entry found in the built index.html; the embed cannot be loaded.",
  );
}
writeFileSync(
  resolve(DIST_DIR, "EMBED.json"),
  `${JSON.stringify({ mountId: "stac-browser-mount", entry: entry[1], styles }, null, 2)}\n`,
);

// msw's service worker is a test fixture upstream keeps in public/. It intercepts fetches and has
// no business in a production artefact.
const msw = resolve(DIST_DIR, "mockServiceWorker.js");
if (existsSync(msw)) {
  rmSync(msw);
  console.log("[stac-browser] removed mockServiceWorker.js (test fixture)");
}

// The deployment-owned runtime override, shipped empty and fully commented: a deployment replaces
// this one file to point STAC at its catalogue, no rebuild. See UPSTREAM.md "Trust boundary".
writeFileSync(
  resolve(DIST_DIR, "runtime-config.js"),
  `/*
 * STAC Browser runtime configuration - deployment-owned, browser-safe.
 *
 * Replace this file at deploy time to configure the STAC Browser feature without
 * rebuilding anything. Every value here is world-readable: it is served to every
 * visitor. Never put a token, a client secret or a private endpoint in it.
 *
 * This file is written by the DEPLOYMENT. It must never be generated from
 * freva-rest settings: the settings API is administrator-editable data, and this
 * file is executable JavaScript. See packages/portal/docs/stac.md.
 *
 * Recognised keys are STAC Browser's own configuration options:
 * https://github.com/radiantearth/stac-browser/blob/${pin.tag}/docs/options.md
 *
 *   window.STAC_BROWSER_CONFIG = {
 *     catalogUrl: "https://example.org/api/freva-nextgen/stacapi/product/",
 *     catalogTitle: "Institute STAC catalogue",
 *     allowExternalAccess: false,
 *   };
 */
window.STAC_BROWSER_CONFIG = {};
`,
);

// 5. Licences and notices - stage one of two. The ISC notice must survive upstream source -> this
// dist -> portal dist -> npm tarball; packages/portal/scripts/bundle-stac.mjs is hop two, and
// packages/portal/tests assert hop four.
const licenses = resolve(PKG_ROOT, "LICENSES");
mkdirSync(licenses, { recursive: true });
const upstreamLicense = resolve(SRC, pin.licenseFile);
copyFileSync(upstreamLicense, resolve(licenses, "stac-browser-ISC.txt"));
cpSync(licenses, resolve(DIST_DIR, "LICENSES"), { recursive: true });
copyFileSync(
  resolve(PKG_ROOT, "THIRD_PARTY_NOTICES.md"),
  resolve(DIST_DIR, "THIRD_PARTY_NOTICES.md"),
);

// The record is written last, because it contains a digest of everything else in the tree.
// Anything written after it would make it false.
const record = buildRecord({ pkgRoot: PKG_ROOT, distDir: DIST_DIR, pin });
writeFileSync(resolve(DIST_DIR, "BUILDINFO.json"), `${JSON.stringify(record, null, 2)}\n`);

const check = verifyDistRecord({ pkgRoot: PKG_ROOT, distDir: DIST_DIR, pin });
if (!check.ok) {
  throw new Error(
    `The build record does not verify against the tree it was just written for:\n  ${check.reasons.join("\n  ")}`,
  );
}

// 6. The output has the shape the recipe says it has - asserted, because the adapter loads a
// module and a stylesheet by name. An upstream that stops emitting a single module entry, or
// starts emitting a service worker, must fail here, not in a deployment's browser.
{
  const shape = recipe.output;
  const problems = [];
  if (!new RegExp(shape.entryPattern).test(entry[1])) {
    problems.push(`the entry '${entry[1]}' does not match ${shape.entryPattern}`);
  }
  if (styles.length < shape.minStyles) {
    problems.push(`${styles.length} stylesheet(s); the recipe expects at least ${shape.minStyles}`);
  }
  for (const style of styles) {
    if (!new RegExp(shape.stylePattern).test(style)) {
      problems.push(`the stylesheet '${style}' does not match ${shape.stylePattern}`);
    }
  }
  for (const required of shape.requiredFiles) {
    if (!existsSync(resolve(DIST_DIR, required))) problems.push(`${required} was not produced`);
  }
  if (problems.length) {
    throw new Error(
      `[stac-browser] the build output does not match the recipe's recorded shape:\n  ` +
        `${problems.join("\n  ")}\n  Re-read upstream's build documentation for ${pin.tag} ` +
        "before moving the pin; the adapter contract is written against this shape.",
    );
  }
}

console.log(`[stac-browser] dist ready at ${DIST_DIR}`);
