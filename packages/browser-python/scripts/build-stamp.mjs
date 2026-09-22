/**
 * Is `dist/` the build of THESE sources? Answered by content, never by modification time.
 *
 * Browser suites import the BUILT package, so a checkout whose sources moved on while `dist/` did not
 * tests yesterday's worker with today's suites - which is how a run reported the startup JSPI warning
 * the sources no longer contain. `npm run build` ends by writing a digest of every input that decides
 * what `dist/` holds; `requireDist()` recomputes it and refuses a mismatch. Timestamps are not used:
 * a checkout, a copy or a `touch` changes them without changing a byte, and an edit can keep them.
 *
 *     node scripts/build-stamp.mjs write    # the last step of `npm run build`
 *     node scripts/build-stamp.mjs check    # exit 1, with the reason, if dist/ is stale
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** Where the stamp lives: beside `dist/`, not in it, so it is never published. */
export const STAMP_FILE = ".build-stamp.json";

/**
 * Every input that decides what `dist/` holds. Directories are walked whole; the generated files
 * under `src/` are included, and so are their inputs (`bin/freva-addons.json`), so an edit to either
 * side without a rebuild is caught.
 */
export const BUILD_INPUTS = Object.freeze([
  "src",
  "tsconfig.json",
  "tsconfig.build.json",
  "package.json",
  "bin/freva-addons.json",
  "scripts/gen-python-sources.mjs",
  "scripts/gen-console-styles.mjs",
  "scripts/gen-addon-pins.mjs",
  "scripts/copy-console-css.mjs",
]);

function files(root, entry) {
  const full = join(root, entry);
  if (!existsSync(full)) return [];
  if (statSync(full).isFile()) return [full];
  return readdirSync(full)
    .sort()
    .flatMap((name) => files(root, join(entry, name)));
}

/** SHA-256 over the relative path and the bytes of every input, in a fixed order. */
export function sourceDigest(pkgDir = PKG, inputs = BUILD_INPUTS) {
  const hash = createHash("sha256");
  for (const file of inputs.flatMap((entry) => files(pkgDir, entry)).sort()) {
    const name = relative(pkgDir, file).split(sep).join("/");
    const bytes = readFileSync(file);
    hash.update(`${name}\0${bytes.length}\0`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

export function writeStamp(pkgDir = PKG, inputs = BUILD_INPUTS) {
  const stamp = { digest: sourceDigest(pkgDir, inputs), builtAt: new Date().toISOString() };
  writeFileSync(join(pkgDir, STAMP_FILE), `${JSON.stringify(stamp, null, 2)}\n`);
  return stamp;
}

/** `{ ok: true }`, or `{ ok: false, reason }` saying what to run. */
export function checkStamp(pkgDir = PKG, inputs = BUILD_INPUTS) {
  if (!existsSync(join(pkgDir, "dist"))) {
    return { ok: false, reason: "dist/ does not exist - run `npm run build`." };
  }
  let stamp;
  try {
    stamp = JSON.parse(readFileSync(join(pkgDir, STAMP_FILE), "utf8"));
  } catch {
    return {
      ok: false,
      reason:
        `dist/ has no ${STAMP_FILE}, so nothing says which sources it was built from - ` +
        "run `npm run build`.",
    };
  }
  const current = sourceDigest(pkgDir, inputs);
  if (stamp.digest !== current) {
    return {
      ok: false,
      reason:
        `dist/ is STALE: it was built (${stamp.builtAt ?? "at an unknown time"}) from different ` +
        "sources than the ones checked out now. Run `npm run build`; the browser-test npm scripts " +
        "do this for you.",
    };
  }
  return { ok: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (command === "write") {
    writeStamp();
  } else if (command === "check") {
    const result = checkStamp();
    if (!result.ok) {
      console.error(result.reason);
      process.exit(1);
    }
  } else {
    console.error("usage: node scripts/build-stamp.mjs write|check");
    process.exit(2);
  }
}
