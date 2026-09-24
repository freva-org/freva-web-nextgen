/**
 * Source closure: does the tracked tree contain everything it references?
 *
 * An unanchored `.gitignore` rule can untrack a whole source directory - `build/` also
 * matches `src/build/` - leaving every local command green while nothing a reviewer receives
 * compiles. The check asks two questions a type-checker cannot:
 *
 *   1. is every file a source file references actually *tracked by git*, and
 *   2. does every declared entry point - bin, exports, files, script targets, tsconfig
 *      inputs and documented evidence paths - resolve to a tracked file?
 *
 * It has no dependencies, so CI can run it before `npm ci` - the only moment at which "the
 * delivered tree is incomplete" is cheap to discover.
 *
 * Usage: node packages/portal-builder/scripts/source-closure.mjs [--json]
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(PKG, "../..");
const JSON_OUTPUT = process.argv.includes("--json");

const problems = [];
const fail = (kind, subject, detail) => problems.push({ kind, subject, detail });

// What git actually tracks.
let tracked;
try {
  tracked = new Set(
    execFileSync("git", ["ls-files", "-z"], {
      cwd: REPO,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
      .split("\0")
      .filter(Boolean),
  );
} catch (error) {
  console.error(`[closure] cannot list tracked files: ${error.message}`);
  process.exit(2);
}

const rel = (absolute) => relative(REPO, absolute).split(sep).join("/");
const isTracked = (absolute) => tracked.has(rel(absolute));

/** Directories whose contents are generated and are expected to be untracked. */
const GENERATED = [
  "node_modules/",
  "dist/",
  "dist-test/",
  "coverage/",
  "reports/",
  ".astro/",
  "materials/",
  ".upstream/",
  "__pycache__/",
];
const isGenerated = (path) => GENERATED.some((g) => path.includes(g));

// Source files, and the files they import.
const SOURCE_ROOTS = ["src", "client", "astro", "tests", "scripts", "bin", "browser-tests"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".mjs", ".js", ".cjs", ".astro"]);

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of execFileSync("ls", ["-A", dir], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)) {
    const full = join(dir, name);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      if (isGenerated(`${full}/`)) continue;
      walk(full, out);
    } else if (stats.isFile()) {
      out.push(full);
    }
  }
  return out;
}

const IMPORT_RE =
  /(?:^|[^.\w])(?:import|export)\s*(?:[\s\S]*?\sfrom\s*)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;

/** Resolve a relative specifier the way Node and the bundler will. */
function resolveSpecifier(fromFile, specifier) {
  // Vite asset imports carry a query: `./mark.webp?url` still names the same file.
  const base = resolve(dirname(fromFile), specifier.replace(/[?#].*$/, ""));
  const candidates = [base];
  // TypeScript source is imported with a `.js` extension under NodeNext.
  if (base.endsWith(".js")) candidates.push(`${base.slice(0, -3)}.ts`, `${base.slice(0, -3)}.tsx`);
  if (base.endsWith(".mjs")) candidates.push(`${base.slice(0, -4)}.mts`);
  for (const extension of [
    ".ts",
    ".tsx",
    ".mts",
    ".mjs",
    ".js",
    ".cjs",
    ".json",
    ".astro",
    ".css",
  ]) {
    candidates.push(`${base}${extension}`);
  }
  candidates.push(join(base, "index.ts"), join(base, "index.js"), join(base, "index.mjs"));
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

function inComment(text, index) {
  const before = text.slice(text.lastIndexOf("\n", index) + 1, index);
  return /^\s*\*/.test(before) || before.includes("//");
}

const sourceFiles = SOURCE_ROOTS.flatMap((root) => walk(join(PKG, root)));
let importCount = 0;

for (const file of sourceFiles) {
  const suffix = file.slice(file.lastIndexOf("."));
  if (!SOURCE_EXTENSIONS.has(suffix)) continue;

  if (!isTracked(file)) {
    fail("untracked-source", rel(file), "the file exists on disk but git does not track it");
  }

  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(IMPORT_RE)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (!specifier || !specifier.startsWith(".")) continue;
    if (inComment(text, match.index)) continue;
    importCount += 1;
    // An executable may import its own build output; `prepack` makes it, so check the source.
    const compiled = /(^|\/)dist\//.exec(specifier);
    if (compiled) {
      const sourceEquivalent = resolveSpecifier(
        file,
        specifier.replace(/(^|\/)dist\//, "$1src/").replace(/\.js$/, ".ts"),
      );
      if (!sourceEquivalent) {
        fail("unresolved-import", rel(file), `'${specifier}' has no source equivalent under src/`);
      } else if (!isTracked(sourceEquivalent)) {
        fail(
          "untracked-import",
          rel(file),
          `'${specifier}' compiles from untracked ${rel(sourceEquivalent)}`,
        );
      }
      continue;
    }
    const target = resolveSpecifier(file, specifier);
    if (!target) {
      fail("unresolved-import", rel(file), `cannot resolve '${specifier}'`);
      continue;
    }
    if (!isTracked(target) && !isGenerated(target)) {
      fail("untracked-import", rel(file), `'${specifier}' resolves to untracked ${rel(target)}`);
    }
  }
}

// Declared entry points.
const manifest = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"));

const requireTracked = (path, subject) => {
  const absolute = resolve(PKG, path);
  if (!existsSync(absolute)) {
    fail("missing-declared-path", subject, `${path} does not exist`);
    return;
  }
  if (statSync(absolute).isFile() && !isTracked(absolute) && !isGenerated(absolute)) {
    fail("untracked-declared-path", subject, `${path} is not tracked`);
  }
};

for (const [name, target] of Object.entries(manifest.bin ?? {}))
  requireTracked(target, `bin.${name}`);

const exportTargets = (value, label) => {
  if (typeof value === "string") {
    // A published subpath may point at build output; require its *source* root instead.
    if (!value.startsWith("./dist/")) requireTracked(value, label);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) exportTargets(nested, `${label}.${key}`);
  }
};
exportTargets(manifest.exports ?? {}, "exports");

for (const entry of manifest.files ?? []) {
  if (entry.startsWith("!")) continue;
  const absolute = resolve(PKG, entry);
  if (existsSync(absolute)) continue;
  // `dist` is produced by `prepack`; what must exist in the tree is its source.
  if (entry === "dist" && existsSync(join(PKG, "src"))) continue;
  fail("missing-declared-path", `files[${entry}]`, `${entry} does not exist`);
}

// Script targets: a declared script that names a file must name a real one.
const SCRIPT_FILE_RE =
  /(?:^|\s)(?:node|tsx)\s+([^\s]+\.(?:mjs|js|cjs|ts))|(?:^|\s)-p\s+([^\s]+\.json)/g;
for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
  for (const match of command.matchAll(SCRIPT_FILE_RE)) {
    const target = match[1] ?? match[2];
    if (!target || target.includes("$")) continue;
    requireTracked(target, `scripts.${name}`);
  }
}

// tsconfig include/exclude inputs.
for (const config of ["tsconfig.json", "tsconfig.test.json", "tsconfig.client.json"]) {
  const absolute = join(PKG, config);
  if (!existsSync(absolute)) {
    fail("missing-declared-path", config, "referenced by the type-check script but absent");
    continue;
  }
  const parsed = JSON.parse(readFileSync(absolute, "utf8").replace(/^\s*\/\/.*$/gm, ""));
  for (const entry of parsed.include ?? []) {
    if (entry.includes("*")) continue;
    const target = resolve(PKG, entry);
    if (!existsSync(target)) {
      fail("missing-declared-path", `${config}.include`, `${entry} does not exist`);
    }
  }
}

const NOT_CARRIED_YET = ["packages/portal/", "delivery/"];
const conformance = join(PKG, "docs", "fp-001-conformance.md");
if (existsSync(conformance)) {
  const text = readFileSync(conformance, "utf8");
  for (const match of text.matchAll(
    /`((?:src|tests|client|astro|schema|scripts|bin|browser-tests|tools|packages|examples)\/[^`\s|]+)`/g,
  )) {
    const cited = match[1];
    if (NOT_CARRIED_YET.some((prefix) => cited.startsWith(prefix))) continue;
    const candidates = [resolve(PKG, cited), resolve(REPO, cited)];
    // A citation may name a directory, a file, or a glob of sibling files.
    const found = candidates.some((candidate) => {
      if (existsSync(candidate)) return true;
      if (!candidate.includes("*")) return false;
      const dir = dirname(candidate.split("*")[0]);
      return existsSync(dir);
    });
    if (!found)
      fail("missing-cited-evidence", "docs/fp-001-conformance.md", `${cited} does not exist`);
  }
}

// Nothing generated may be tracked.
for (const path of tracked) {
  if (/(^|\/)__pycache__\//.test(path) || /\.py[cod]$/.test(path)) {
    fail("tracked-generated", path, "Python bytecode must never be committed");
  }
  if (/(^|\/)node_modules\//.test(path))
    fail("tracked-generated", path, "node_modules must never be committed");
}

const summary = {
  checked: {
    sourceFiles: sourceFiles.length,
    relativeImports: importCount,
    trackedFiles: tracked.size,
  },
  problems,
  ok: problems.length === 0,
};

if (JSON_OUTPUT) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(
    `[closure] ${sourceFiles.length} source file(s), ${importCount} relative import(s), ${tracked.size} tracked file(s)`,
  );
  for (const problem of problems) {
    console.error(`  ${problem.kind}: ${problem.subject} - ${problem.detail}`);
  }
  console.log(problems.length === 0 ? "[closure] ok" : `[closure] ${problems.length} problem(s)`);
}

process.exit(problems.length === 0 ? 0 : 1);
