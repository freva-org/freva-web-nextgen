/**
 * The size gate.
 *
 * The premise of this package is that the heavy things - the WASM, the stdlib, the wheels - are
 * fetched separately and cached by the browser, so a consumer's bundle grows only by the loader
 * and the worker. Easy to break silently: one static `import { loadPyodide } from "pyodide"`
 * would inline 14 MB into every consumer's application chunk and nothing else would complain.
 * So this asserts the JavaScript is under budget gzipped, and that the published tarball
 * contains NO runtime assets at all - no .wasm, no .whl, no stdlib zip.
 */
import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { readFileSync, readdirSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(PKG, "dist");

/**
 * The ceiling on the emitted engine files, gzipped: `dist/` minus the optional console and embed
 * entry points.
 *
 * 83 KiB against a measurement of about 78.7 KiB - roughly 4.3 KiB of headroom, close enough
 * that the next few have to be argued for, in another paragraph here. `npm run build`
 * emits declarations and JavaScript in separate passes, so `.d.ts` keeps every word of
 * documentation and the `.js` a browser downloads carries none of it. Before that split, comments
 * alone added about 54 KiB gzip to the engine. The budget follows a measurement down as well as up,
 * because a ceiling far above the floor is a fail-open gate wearing a number.
 *
 * The former documented 64.2 KiB measurement did not include the final browser-native remote-data
 * implementation. Its Python helpers are deliberately source embedded in the worker (rather than
 * fetched as fragile sidecar files): `browser_http.py` and `browser_s3.py` account for roughly
 * 17.7 KiB of the generated module after gzip. That is application code, not a bundled Pyodide
 * runtime.
 *
 * The curated add-ons currently take another 5,595 gzipped bytes in four implementation/data
 * files (the emitted type-only module is not counted in this explanation):
 *
 *     addon-capabilities.js              179 B gz   the main-thread optionality check
 *     worker/addon-pins.generated.js   2,293 B gz   the pinned artefacts and their digests
 *     worker/addons.js                 2,582 B gz   fetch, verify, install, stage, activate
 *     addons.js                          541 B gz   the catalogue a build tool validates against
 *
 * The pin table is worth defending, because the obvious saving is to stop shipping it and that
 * saving is the feature: a digest a running interpreter checks an artefact against has to travel
 * with the CODE, or whoever can replace a wheel can replace the digest. The rest is the
 * installer, and a good part of its bytes are its messages, deliberately.
 */
const BUDGET_BYTES = 83 * 1024;

/** Extensions that must never appear in the tarball. Each one is a runtime asset. */
const FORBIDDEN = new Set([".wasm", ".whl", ".zip", ".so", ".a", ".bc"]);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

// Measured in two groups, because they are two products. The headless engine is what a host
// embedding only the Python runtime pays for, and its size is the package's central claim. The
// console is opt-in, brings jQuery, jQuery Terminal and Prism with it, and is loaded only by
// importing `/console`. One combined number would hide the first behind the second.
const CONSOLE_PREFIX = "console";
const EMBED_PREFIX = "embed";
const files = walk(DIST).filter((f) => f.endsWith(".js"));
if (files.length === 0) {
  console.error("dist/ has no JavaScript - run `npm run build` first.");
  process.exit(2);
}

const pad = (s, n) => String(s).padStart(n);
/** `--json` also prints the measurement as data, for the documentation check. */
const AS_JSON = process.argv.includes("--json");
let raw = 0;
let gzipped = 0;
let consoleRaw = 0;
let consoleGz = 0;
let embedRaw = 0;
let embedGz = 0;
const rows = [];
for (const file of files.sort()) {
  const name = file.slice(DIST.length + 1);
  const bytes = readFileSync(file);
  const gz = gzipSync(bytes, { level: 9 }).length;
  if (name.startsWith(CONSOLE_PREFIX)) {
    consoleRaw += bytes.length;
    consoleGz += gz;
  } else if (name.startsWith(EMBED_PREFIX)) {
    // MEASURED SEPARATELY rather than quietly folded in. `/embed` is the two-origin portal
    // bridge, which a host that embeds nothing never imports, just as one wanting no REPL never
    // imports `/console`. Counting it against the HEADLESS ENGINE budget would count bytes
    // nobody under that budget ships, and let an optional surface eat the engine's headroom.
    embedRaw += bytes.length;
    embedGz += gz;
  } else {
    raw += bytes.length;
    gzipped += gz;
  }
  rows.push([name, bytes.length, gz]);
}

console.log("dist JavaScript, by entry point:\n");
for (const [name, bytes, gz] of rows) {
  console.log(`  ${name.padEnd(40)} ${pad(bytes, 8)} B  ${pad(gz, 7)} B gz`);
}
console.log(`\n  ${"HEADLESS ENGINE".padEnd(40)} ${pad(raw, 8)} B  ${pad(gzipped, 7)} B gz`);
console.log(`  ${"budget".padEnd(40)} ${" ".repeat(10)} ${pad(BUDGET_BYTES, 7)} B gz`);
console.log(
  `  ${"CONSOLE (this package's own code)".padEnd(40)} ${pad(consoleRaw, 8)} B  ${pad(consoleGz, 7)} B gz`,
);
console.log(
  `  ${"EMBED (optional two-origin bridge)".padEnd(40)} ${pad(embedRaw, 8)} B  ${pad(embedGz, 7)} B gz`,
);
console.log(
  "\n  The console additionally loads jQuery, jQuery Terminal and Prism at run time; those are\n" +
    "  dependencies rather than emitted files, and are measured by scripts/measure-console.mjs.\n",
);

let failed = false;
if (gzipped > BUDGET_BYTES) {
  console.error(
    `The HEADLESS engine is over budget by ${gzipped - BUDGET_BYTES} B gzipped.\n` +
      `Inspect the per-file measurements above. If the growth is intentional, document it beside\n` +
      `BUDGET_BYTES and move the ceiling with only modest headroom. Also check pyodide-runtime.ts:\n` +
      `Pyodide must remain a dynamic import by URL rather than a static dependency.`,
  );
  failed = true;
}

// What `npm pack` would actually publish.
//
// `--ignore-scripts` is load-bearing, not tidiness: `prepack` runs this script, so a plain
// `npm pack` here re-enters check-bytes, which packs again, forever.
const listing = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  cwd: PKG,
  encoding: "utf8",
});
const [packed] = JSON.parse(listing);
const offenders = packed.files.filter((f) => FORBIDDEN.has(extname(f.path)));
if (offenders.length > 0) {
  console.error(
    `The tarball would ship runtime assets, which it must never do:\n  ` +
      offenders.map((f) => f.path).join("\n  "),
  );
  failed = true;
}

console.log(
  `npm pack: ${packed.entryCount} files, ${packed.size} B tarball, ${packed.unpackedSize} B unpacked`,
);
console.log(`  no runtime assets: ${offenders.length === 0 ? "confirmed" : "FAILED"}`);

// The worker has to exist at the path the default factory builds, or a consumer's engine cannot
// start and will not find out until run time.
const workerPath = packed.files.find((f) => f.path === "dist/worker/browser-python.worker.js");
if (!workerPath) {
  console.error("The tarball does not contain dist/worker/browser-python.worker.js.");
  failed = true;
} else {
  console.log("  worker asset present: confirmed");
}

// The same numbers, as data. Documentation that repeats a measurement has to be CHECKED against
// it - a hand-transcribed README size table was wrong in three places - so `--json` prints it,
// `scripts/check-docs-sizes.mjs` compares the README against it, and the gate that enforces the
// budget is the same one that feeds the prose.
if (AS_JSON) {
  console.log(
    JSON.stringify(
      {
        engineGz: gzipped,
        engineRaw: raw,
        budgetGz: BUDGET_BYTES,
        consoleOwnGz: consoleGz,
        tarballBytes: packed.size,
        tarballFiles: packed.entryCount,
      },
      null,
      2,
    ),
  );
}

process.exit(failed ? 1 : 0);
