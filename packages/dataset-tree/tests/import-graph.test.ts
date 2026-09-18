// The shape of what actually ships.
//
// The package's central promise to a portal is that choosing a snapshot catalog costs no
// object-store client, and choosing neither costs no catalog validator. That promise lives in the
// import graph of the built output, not in anyone's intention, so it is checked against `dist/`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DIST = join(PKG, "dist");
const PACKAGE = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")) as {
  name: string;
  version: string;
  exports: Record<string, unknown>;
  files: string[];
  dependencies: Record<string, string>;
};

const built = existsSync(join(DIST, "index.js"));
const skip = built ? false : "dist/ not built - run `npm run build`";

/** Every static and dynamic import in a module, as written. */
function importsOf(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const found: string[] = [];
  const patterns = [
    /(?:^|[\n;])\s*import\b[^'"\n]*?from\s*["']([^"']+)["']/g,
    /(?:^|[\n;])\s*import\s*["']([^"']+)["']/g,
    /(?:^|[\n;])\s*export\b[^'"\n]*?from\s*["']([^"']+)["']/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) found.push(match[1]);
  }
  return found;
}

/** Transitively walk the graph from one entry, reporting local files and bare specifiers. */
function walk(entry: string): { files: string[]; bare: string[] } {
  const seen = new Set<string>();
  const bare = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of importsOf(file)) {
      if (!specifier.startsWith(".")) {
        bare.add(specifier);
        continue;
      }
      const target = resolve(dirname(file), specifier);
      if (existsSync(target)) queue.push(target);
    }
  }
  return {
    files: [...seen].map((f) => relative(DIST, f).split("\\").join("/")).sort(),
    bare: [...bare].sort(),
  };
}

test("the export map is exactly the documented surface, with no wildcard", () => {
  assert.deepEqual(Object.keys(PACKAGE.exports).sort(), [
    ".",
    "./dataset-tree-catalog-v1.schema.json",
    "./dataset-tree-search-index-v1.schema.json",
    "./package.json",
    "./s3",
    "./search-index",
    "./snapshot",
    "./styles.css",
  ]);
  assert.deepEqual(PACKAGE.exports["."], {
    types: "./dist/index.d.ts",
    import: "./dist/index.js",
  });
  assert.deepEqual(PACKAGE.exports["./snapshot"], {
    types: "./dist/snapshot.d.ts",
    import: "./dist/snapshot.js",
  });
  assert.deepEqual(PACKAGE.exports["./s3"], {
    types: "./dist/s3.d.ts",
    import: "./dist/s3.js",
  });
  assert.deepEqual(PACKAGE.exports["./search-index"], {
    types: "./dist/search-index.d.ts",
    import: "./dist/search-index.js",
  });
  assert.equal(PACKAGE.exports["./styles.css"], "./dist/styles.css");
  assert.equal(
    PACKAGE.exports["./dataset-tree-search-index-v1.schema.json"],
    "./schema/dataset-tree-search-index-v1.schema.json",
  );
  // No `./*`: a consumer must not be able to reach an internal module and then depend on it.
  for (const key of Object.keys(PACKAGE.exports)) {
    assert.ok(!key.includes("*"), `wildcard subpath: ${key}`);
  }
});

test("the package has no runtime dependencies", () => {
  assert.deepEqual(PACKAGE.dependencies, {});
});

test("nothing in the package names the databrowser, in any file", () => {
  // A boundary, asserted rather than assumed.
  //
  // This component is generic and published on its own; the portal's Data Browser is a different
  // package with a different job, a different data model and a different dependency footprint.
  // "We only borrowed a helper" is how one of those becomes two coupled things, so the rule is
  // that the string does not appear - not in an import, not in a comment, not in a type.
  const roots = ["src", "tests", "scripts", "browser-tests"];
  // This file is the exception, for the obvious reason: it is the one that has to say the word.
  const self = "tests/import-graph.test.ts";
  const offenders: string[] = [];
  for (const dir of roots) {
    const base = join(PKG, dir);
    if (!existsSync(base)) continue;
    for (const file of readdirSync(base, { recursive: true, encoding: "utf8" })) {
      const relative = `${dir}/${file}`;
      if (relative === self) continue;
      const full = join(base, file);
      if (!/\.(ts|tsx|js|mjs|cjs|json|css)$/.test(file)) continue;
      if (!statSync(full).isFile()) continue;
      if (/databrowser/i.test(readFileSync(full, "utf8"))) offenders.push(relative);
    }
  }
  assert.deepEqual(offenders, [], `these files name the databrowser: ${offenders.join(", ")}`);
  assert.equal(JSON.stringify({ ...PACKAGE.dependencies }).includes("databrowser"), false);
});

test("the core entry does not reach the S3 adapter", { skip }, () => {
  const graph = walk(join(DIST, "index.js"));
  const leaked = graph.files.filter((f) => /^s3(\.js|\/)/.test(f));
  assert.deepEqual(leaked, [], `the core entry now reaches the S3 adapter: ${leaked.join(", ")}`);
});

test("the snapshot entry does not reach the S3 adapter either", { skip }, () => {
  const graph = walk(join(DIST, "snapshot.js"));
  const leaked = graph.files.filter((f) => /^s3(\.js|\/)/.test(f));
  assert.deepEqual(
    leaked,
    [],
    `the snapshot entry now reaches the S3 adapter: ${leaked.join(", ")}`,
  );
});

test("the core entry does not reach the catalog validator either", { skip }, () => {
  // The other half of the same promise: a portal driving the tree from its own live source should
  // not carry a parser for a format it never sees.
  const graph = walk(join(DIST, "index.js"));
  const leaked = graph.files.filter((f) => /^snapshot(\.js|\/)/.test(f));
  assert.deepEqual(
    leaked,
    [],
    `the core entry now reaches the snapshot parser: ${leaked.join(", ")}`,
  );
});

test("the core entry does not reach the search-index validator", { skip }, () => {
  // The third instance of the same promise, and the one that needed a file split to keep.
  //
  // The component RANKS results itself, so `search/match.js` is legitimately in the core graph.
  // The strict parser is not: a consumer with no index, or one that validated its index in its own
  // build and ships the parsed result, should not carry a validator for a format it never reads.
  const graph = walk(join(DIST, "index.js"));
  const leaked = graph.files.filter((f) => f === "search/parse.js" || f === "search-index.js");
  assert.deepEqual(
    leaked,
    [],
    `the core entry now reaches the search-index validator: ${leaked.join(", ")}`,
  );
  assert.ok(graph.files.includes("search/match.js"), "the core entry lost the ranking module");
});

test("the search-index entry reaches its validator and nothing else", { skip }, () => {
  const graph = walk(join(DIST, "search-index.js"));
  assert.ok(graph.files.includes("search/parse.js"));
  const leaked = graph.files.filter(
    (f) => /^s3(\.js|\/)/.test(f) || /^snapshot(\.js|\/)/.test(f) || f === "tree.js",
  );
  assert.deepEqual(leaked, [], `the search-index entry now reaches: ${leaked.join(", ")}`);
});

test("no entry imports anything from outside the package", { skip }, () => {
  for (const entry of ["index.js", "snapshot.js", "s3.js", "search-index.js"]) {
    const graph = walk(join(DIST, entry));
    assert.deepEqual(graph.bare, [], `${entry} gained external imports: ${graph.bare.join(", ")}`);
  }
});

test("each entry still reaches what it is supposed to", { skip }, () => {
  const core = walk(join(DIST, "index.js")).files;
  for (const needed of [
    "tree.js",
    "dom.js",
    "icons.js",
    "labels.js",
    "format.js",
    "url.js",
    "python.js",
  ]) {
    assert.ok(core.includes(needed), `the core entry no longer reaches ${needed}`);
  }
  const snapshot = walk(join(DIST, "snapshot.js")).files;
  assert.ok(snapshot.includes("snapshot/parse.js"));
  assert.ok(snapshot.includes("snapshot/source.js"));
  const s3 = walk(join(DIST, "s3.js")).files;
  assert.ok(s3.includes("s3/source.js"));
  assert.ok(s3.includes("s3/xml.js"));
});

test("the stylesheet ships beside the code, and is the one in src/", { skip }, () => {
  const shipped = readFileSync(join(DIST, "styles.css"), "utf8");
  const authored = readFileSync(join(PKG, "src", "styles.css"), "utf8");
  assert.equal(shipped, authored, "dist/styles.css has drifted from src/styles.css");
});

test("nothing in the built output touches a global or auto-mounts", { skip }, () => {
  const files = readdirSync(DIST, { recursive: true, encoding: "utf8" }).filter((f) =>
    f.endsWith(".js"),
  );
  assert.ok(files.length > 0);
  for (const file of files) {
    const source = readFileSync(join(DIST, file), "utf8");
    for (const pattern of [
      /\bwindow\.[A-Za-z_$][\w$]*\s*=/,
      /\bglobalThis\.[A-Za-z_$][\w$]*\s*=/,
      /\bdocument\.addEventListener\b/,
      /\bwindow\.addEventListener\b/,
      /\bcustomElements\.define\b/,
      /\bDOMContentLoaded\b/,
      /\beval\b/,
      /\bnew Function\b/,
      /\binnerHTML\b/,
      /\bouterHTML\b/,
      /\binsertAdjacentHTML\b/,
      /\bdocument\.write\b/,
    ]) {
      assert.ok(!pattern.test(source), `${file} contains ${pattern}`);
    }
  }
});

test("the tarball manifest carries runtime files only", () => {
  assert.deepEqual(PACKAGE.files.sort(), ["LICENSE", "README.md", "dist", "schema"]);
  for (const excluded of ["tests", "playground", "browser-tests", "src", "scripts"]) {
    assert.ok(!PACKAGE.files.includes(excluded), `${excluded} would be published`);
  }
});

test("the package carries a CalVer version", () => {
  assert.equal(PACKAGE.name, "@freva-org/dataset-tree");
  assert.match(PACKAGE.version, /^\d{4}\.\d+\.\d+$/);
});
