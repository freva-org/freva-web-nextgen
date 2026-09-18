// scripts/source-closure.mjs - prove, against the built output, that the entries are separable.
//
// The same property `tests/import-graph.test.ts` asserts, in a form that can be run on its own in a
// release check without booting the test runner: walk each entry's transitive imports in `dist/`
// and report what it can reach. A build where `./snapshot` drags in an object-store client, or
// where the root entry drags in a catalog validator, is a build whose packaging claim is false.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(PKG, "dist");

if (!existsSync(join(DIST, "index.js"))) {
  process.stderr.write("dist/ is missing - run `npm run build` first\n");
  process.exit(1);
}

const PATTERNS = [
  /(?:^|[\n;])\s*import\b[^'"\n]*?from\s*["']([^"']+)["']/g,
  /(?:^|[\n;])\s*import\s*["']([^"']+)["']/g,
  /(?:^|[\n;])\s*export\b[^'"\n]*?from\s*["']([^"']+)["']/g,
  /\bimport\(\s*["']([^"']+)["']\s*\)/g,
];

function walk(entry) {
  const seen = new Set();
  const bare = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const pattern of PATTERNS) {
      let match;
      while ((match = pattern.exec(source)) !== null) {
        const specifier = match[1];
        if (!specifier.startsWith(".")) {
          bare.add(specifier);
          continue;
        }
        const target = resolve(dirname(file), specifier);
        if (existsSync(target)) queue.push(target);
      }
    }
  }
  return {
    files: [...seen].map((f) => relative(DIST, f).split("\\").join("/")).sort(),
    bare: [...bare].sort(),
  };
}

const RULES = [
  // `search/parse.js` is forbidden from the core entry for the same reason `snapshot/parse.js` is:
  // a consumer with no index, or one that validated its index in its own build, should not carry a
  // validator for a format it never reads at runtime. `search/match.js` IS reachable from the core
  // - the component ranks results itself - and that split is the whole point of having two files.
  { entry: "index.js", forbid: [/^s3(\.js|\/)/, /^snapshot(\.js|\/)/, /^search\/parse\.js$/] },
  { entry: "snapshot.js", forbid: [/^s3(\.js|\/)/, /^tree\.js$/] },
  { entry: "s3.js", forbid: [/^tree\.js$/, /^index\.js$/] },
  { entry: "search-index.js", forbid: [/^s3(\.js|\/)/, /^snapshot(\.js|\/)/, /^tree\.js$/] },
];

let failed = false;
for (const rule of RULES) {
  const graph = walk(join(DIST, rule.entry));
  const hits = graph.files.filter((file) => rule.forbid.some((re) => re.test(file)));
  const external = graph.bare;
  const ok = hits.length === 0 && external.length === 0;
  if (!ok) failed = true;
  process.stdout.write(
    `${ok ? "  ok  " : "  FAIL"} ${rule.entry.padEnd(12)} ${String(graph.files.length).padStart(2)} modules` +
      (hits.length > 0 ? `, must not reach: ${hits.join(", ")}` : "") +
      (external.length > 0 ? `, external imports: ${external.join(", ")}` : "") +
      "\n",
  );
}

process.stdout.write(failed ? "\nsource closure FAILED\n" : "\nsource closure ok\n");
process.exit(failed ? 1 : 0);
