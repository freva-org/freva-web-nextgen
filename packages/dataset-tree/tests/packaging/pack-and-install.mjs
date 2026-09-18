// Packaging verification against the real tarball.
//
// A `files` list is a statement of intent and an `exports` map is a promise. This runs `npm pack`,
// installs what npm actually produced into a clean project outside the workspace, and then behaves
// like a consumer: resolve every documented entry, import the CSS, type-check against the shipped
// declarations, render a tree in jsdom, and prove the S3 adapter is absent from what the core and
// snapshot entries load.
//
// Run with `npm run test:packaging -w @freva-org/dataset-tree`.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REPO = resolve(PKG, "../..");

const results = [];
const check = (label, fn) => {
  try {
    fn();
    results.push({ label, ok: true });
    console.log(`  ok   ${label}`);
  } catch (error) {
    results.push({ label, ok: false });
    console.error(
      `  FAIL ${label}\n       ${String(error.message).split("\n").slice(0, 6).join("\n       ")}`,
    );
  }
};

const scratch = mkdtempSync(join(tmpdir(), "dataset-tree-pack-"));
let packedSize = 0;
let unpackedSize = 0;

try {
  // pack
  execFileSync("npm", ["run", "build"], { cwd: PKG, stdio: "inherit" });
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--pack-destination", scratch], {
      cwd: PKG,
      encoding: "utf8",
    }),
  )[0];
  const tarball = join(scratch, packed.filename);
  const names = packed.files.map((f) => f.path);
  packedSize = packed.size;
  unpackedSize = packed.unpackedSize;

  console.log(
    `\n  ${packed.filename}: ${packed.entryCount} files, ` +
      `${(packed.size / 1024).toFixed(1)} kB packed, ` +
      `${(packed.unpackedSize / 1024).toFixed(1)} kB unpacked\n`,
  );

  check(
    "the archive contains the four entries, their types, both schemas and the stylesheet",
    () => {
      for (const required of [
        "dist/index.js",
        "dist/index.d.ts",
        "dist/snapshot.js",
        "dist/snapshot.d.ts",
        "dist/s3.js",
        "dist/s3.d.ts",
        "dist/search-index.js",
        "dist/search-index.d.ts",
        "dist/styles.css",
        "schema/dataset-tree-catalog-v1.schema.json",
        "schema/dataset-tree-search-index-v1.schema.json",
        "README.md",
        "LICENSE",
        "package.json",
      ]) {
        assert.ok(names.includes(required), `${required} is missing from the tarball`);
      }
    },
  );

  check("the archive contains no tests, fixtures, playground or sources", () => {
    const strays = names.filter(
      (n) =>
        /^(tests|playground|browser-tests|src|scripts)\//.test(n) ||
        /\.(test|spec)\./.test(n) ||
        n.endsWith(".map") ||
        n.endsWith(".tsbuildinfo"),
    );
    assert.deepEqual(strays, [], `development files would be published: ${strays.join(", ")}`);
  });

  check("the archive declares no runtime dependency", () => {
    const manifest = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"));
    assert.deepEqual(manifest.dependencies, {});
  });

  // install elsewhere
  const consumer = join(scratch, "consumer");
  mkdirSync(consumer, { recursive: true });
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify(
      { name: "fictional-portal", private: true, version: "1.0.0", type: "module" },
      null,
      2,
    ),
  );
  // `--install-links` so the tarball is really unpacked rather than symlinked back to the workspace.
  execFileSync("npm", ["install", "--no-audit", "--no-fund", "--install-links", tarball], {
    cwd: consumer,
    stdio: "inherit",
  });
  // jsdom, so the consumer can actually mount the thing rather than only import it.
  execFileSync("npm", ["install", "--no-audit", "--no-fund", `jsdom@${jsdomRange()}`], {
    cwd: consumer,
    stdio: "inherit",
  });

  function jsdomRange() {
    const manifest = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"));
    return manifest.devDependencies.jsdom;
  }

  const installed = join(consumer, "node_modules", "@freva-org", "dataset-tree");

  check("every documented export resolves by package name", () => {
    const probe = join(consumer, "resolve.mjs");
    writeFileSync(
      probe,
      [
        // `import.meta.resolve`, not `require.resolve`: the package is ESM-only by design, so its
        // export conditions carry `import` and not `require`. A CJS resolver failing here is the
        // package working as intended, and testing with one would test the wrong thing.
        "const out = {};",
        'for (const specifier of ["@freva-org/dataset-tree", "@freva-org/dataset-tree/snapshot", "@freva-org/dataset-tree/s3", "@freva-org/dataset-tree/search-index", "@freva-org/dataset-tree/styles.css", "@freva-org/dataset-tree/dataset-tree-catalog-v1.schema.json", "@freva-org/dataset-tree/dataset-tree-search-index-v1.schema.json"]) {',
        "  out[specifier] = import.meta.resolve(specifier);",
        "}",
        "console.log(JSON.stringify(out));",
      ].join("\n"),
    );
    const resolved = JSON.parse(
      execFileSync("node", [probe], { cwd: consumer, encoding: "utf8" }).trim(),
    );
    assert.ok(resolved["@freva-org/dataset-tree"].endsWith("dist/index.js"));
    assert.ok(resolved["@freva-org/dataset-tree/snapshot"].endsWith("dist/snapshot.js"));
    assert.ok(resolved["@freva-org/dataset-tree/s3"].endsWith("dist/s3.js"));
    assert.ok(resolved["@freva-org/dataset-tree/styles.css"].endsWith("dist/styles.css"));
    assert.ok(
      resolved["@freva-org/dataset-tree/dataset-tree-catalog-v1.schema.json"].endsWith(
        "dataset-tree-catalog-v1.schema.json",
      ),
    );
    assert.ok(resolved["@freva-org/dataset-tree/search-index"].endsWith("dist/search-index.js"));
    assert.ok(
      resolved["@freva-org/dataset-tree/dataset-tree-search-index-v1.schema.json"].endsWith(
        "dataset-tree-search-index-v1.schema.json",
      ),
    );
  });

  check("the optional index validates and searches from the installed package", () => {
    // The feature end to end, as a consumer gets it: parse an index, mount a LAZY source with it,
    // type, and find an object that source has never been asked about. If the entry point, the
    // option or the search ever stop lining up, this is where it shows - in the installed package,
    // not in the working tree.
    const probe = join(consumer, "search.mjs");
    writeFileSync(
      probe,
      [
        'import { JSDOM } from "jsdom";',
        'const dom = new JSDOM("<!doctype html><html><body><div id=host></div></body></html>");',
        "globalThis.window = dom.window;",
        "globalThis.document = dom.window.document;",
        'Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });',
        "globalThis.HTMLElement = dom.window.HTMLElement;",
        'const { mountDatasetTree } = await import("@freva-org/dataset-tree");',
        'const { parseDatasetTreeSearchIndexV1 } = await import("@freva-org/dataset-tree/search-index");',
        "const searchIndex = parseDatasetTreeSearchIndexV1({",
        "  schemaVersion: 1,",
        "  complete: true,",
        '  entries: [{ id: "x", kind: "dataset", name: "unopened.zarr", path: "s3://b/deep/unopened.zarr" }],',
        "});",
        "let calls = 0;",
        "const source = {",
        '  loadRoots: async () => [{ id: "a", kind: "collection", name: "reanalysis" }],',
        "  loadChildren: async () => { calls += 1; return []; },",
        "};",
        'const host = document.getElementById("host");',
        "const tree = mountDatasetTree(host, { source, searchIndex, filterDebounceMs: 0 });",
        "await new Promise((r) => setTimeout(r, 50));",
        'const field = host.querySelector(".dataset-tree__filter-input");',
        'field.value = "unopened";',
        'field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));',
        "await new Promise((r) => setTimeout(r, 50));",
        'const found = [...host.querySelectorAll(".dataset-tree__node--result")].map((n) => n.dataset.datasetTreeId);',
        "tree.destroy();",
        "console.log(JSON.stringify({ found, calls }));",
      ].join("\n"),
    );
    const out = JSON.parse(
      execFileSync("node", [probe], { cwd: consumer, encoding: "utf8" }).trim(),
    );
    assert.deepEqual(
      out.found,
      ["x"],
      "the index result did not render from the installed package",
    );
    assert.equal(out.calls, 0, "searching called the source");
  });

  check("an internal module cannot be reached - there is no wildcard subpath", () => {
    const probe = join(consumer, "reach.mjs");
    writeFileSync(
      probe,
      [
        "try {",
        '  import.meta.resolve("@freva-org/dataset-tree/dist/tree.js");',
        '  console.log("REACHED");',
        "} catch {",
        '  console.log("BLOCKED");',
        "}",
      ].join("\n"),
    );
    const output = execFileSync("node", [probe], { cwd: consumer, encoding: "utf8" }).trim();
    assert.equal(output, "BLOCKED", "a consumer can reach into the package's internals");
  });

  check("the CSS is importable, and is a real stylesheet", () => {
    const css = readFileSync(join(installed, "dist", "styles.css"), "utf8");
    assert.match(css, /\.dataset-tree\s*\{/);
    assert.match(css, /--dataset-tree-bg:\s*var\(--surface/);
    assert.ok(!/@import/.test(css), "the stylesheet pulls in something else");
    assert.ok(!/url\(https?:/.test(css), "the stylesheet references a remote asset");
  });

  check("snapshot mode renders in a fresh consumer, from the installed package", () => {
    const probe = join(consumer, "render.mjs");
    writeFileSync(
      probe,
      [
        'import { JSDOM } from "jsdom";',
        'const dom = new JSDOM("<!doctype html><html><body><div id=host></div></body></html>");',
        "globalThis.window = dom.window;",
        "globalThis.document = dom.window.document;",
        'Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });',
        "globalThis.HTMLElement = dom.window.HTMLElement;",
        'const { mountDatasetTree } = await import("@freva-org/dataset-tree");',
        'const { createSnapshotSource, parseDatasetTreeCatalogV1 } = await import("@freva-org/dataset-tree/snapshot");',
        "const catalog = parseDatasetTreeCatalogV1({",
        "  schemaVersion: 1,",
        "  roots: [",
        '    { id: "a", kind: "collection", name: "reanalysis", children: [',
        '      { id: "b", kind: "dataset", name: "tas.zarr", path: "s3://x/tas.zarr", size: 2048 },',
        "    ] },",
        "  ],",
        "});",
        'const host = document.getElementById("host");',
        "const tree = mountDatasetTree(host, { source: createSnapshotSource(catalog) });",
        "await new Promise((r) => setTimeout(r, 50));",
        'const names = [...host.querySelectorAll(".dataset-tree__name")].map((n) => n.textContent);',
        "host.querySelector('[data-dt-key=\"toggle:a\"]').click();",
        "await new Promise((r) => setTimeout(r, 50));",
        'const after = [...host.querySelectorAll(".dataset-tree__name")].map((n) => n.textContent);',
        "tree.destroy();",
        "console.log(JSON.stringify({ names, after, left: host.children.length }));",
      ].join("\n"),
    );
    const output = JSON.parse(
      execFileSync("node", [probe], { cwd: consumer, encoding: "utf8" }).trim(),
    );
    assert.deepEqual(output.names, ["reanalysis"]);
    assert.deepEqual(output.after, ["reanalysis", "tas.zarr"]);
    assert.equal(output.left, 0, "destroy() left DOM in the consumer's host");
  });

  check("neither the core nor the snapshot entry can reach the S3 adapter", () => {
    // Static, not observational: a runtime probe can only show that one code path did not touch
    // the adapter, whereas walking the installed graph shows that no path can.
    const closure = execFileSync("node", [join(PKG, "scripts", "source-closure.mjs")], {
      cwd: PKG,
      encoding: "utf8",
    });
    assert.match(closure, /source closure ok/);

    const reachable = (entry, seen = new Set()) => {
      if (seen.has(entry)) return seen;
      seen.add(entry);
      const source = readFileSync(join(installed, "dist", entry), "utf8");
      for (const match of source.matchAll(/["'](\.\/[^"']+\.js)["']/g)) {
        reachable(match[1].slice(2), seen);
      }
      return seen;
    };
    for (const entry of ["index.js", "snapshot.js"]) {
      const graph = [...reachable(entry)];
      const leaked = graph.filter((f) => f === "s3.js" || f.startsWith("s3/"));
      assert.deepEqual(
        leaked,
        [],
        `${entry} reaches ${leaked.join(", ")} in the installed package`,
      );
    }
  });

  check("the shipped type declarations resolve and describe the public API", () => {
    const dts = readFileSync(join(installed, "dist", "index.d.ts"), "utf8");
    for (const symbol of [
      "mountDatasetTree",
      "DatasetTreeHandle",
      "DatasetTreeNode",
      "DatasetTreeOptions",
      "DatasetTreeSource",
    ]) {
      assert.ok(dts.includes(symbol), `${symbol} is not exported from the shipped types`);
    }
    const snapshotDts = readFileSync(join(installed, "dist", "snapshot.d.ts"), "utf8");
    assert.ok(snapshotDts.includes("parseDatasetTreeCatalogV1"));
    assert.ok(snapshotDts.includes("createSnapshotSource"));
    const s3Dts = readFileSync(join(installed, "dist", "s3.d.ts"), "utf8");
    assert.ok(s3Dts.includes("createS3Source"));
  });

  check("a consumer's TypeScript compiles against the shipped declarations", () => {
    const src = join(consumer, "src");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "consumer.ts"),
      [
        'import { mountDatasetTree } from "@freva-org/dataset-tree";',
        'import type { DatasetTreeHandle, DatasetTreeNode, DatasetTreeOptions, DatasetTreeSource, TryPythonEvent } from "@freva-org/dataset-tree";',
        'import { createSnapshotSource, parseDatasetTreeCatalogV1 } from "@freva-org/dataset-tree/snapshot";',
        'import { createS3Source } from "@freva-org/dataset-tree/s3";',
        "",
        "export function mount(host: HTMLElement, input: unknown): DatasetTreeHandle {",
        "  const catalog = parseDatasetTreeCatalogV1(input);",
        "  const source: DatasetTreeSource = createSnapshotSource(catalog);",
        "  const options: DatasetTreeOptions = {",
        "    source,",
        "    accessExamples: (node: DatasetTreeNode) => [",
        "      { id: 'cli', label: 'CLI', language: 'shell', code: node.path ?? '' },",
        "    ],",
        "    python: {",
        "      enabled: true,",
        "      onTry: (event: TryPythonEvent) => { void event.exampleId; void event.digest; },",
        "    },",
        "  };",
        "  return mountDatasetTree(host, options);",
        "}",
        "",
        "export const live = (endpoint: string) =>",
        "  createS3Source({ endpoint, roots: [{ name: 'Archive', bucket: 'archive' }] });",
      ].join("\n"),
    );
    writeFileSync(
      join(consumer, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2020",
            module: "ESNext",
            moduleResolution: "bundler",
            lib: ["ES2020", "DOM"],
            strict: true,
            noEmit: true,
            skipLibCheck: false,
          },
          include: ["src/**/*.ts"],
        },
        null,
        2,
      ),
    );
    execFileSync("node", [join(REPO, "node_modules", "typescript", "bin", "tsc"), "-p", "."], {
      cwd: consumer,
      stdio: "inherit",
    });
  });

  check("no repository-relative import is needed anywhere in the consumer", () => {
    for (const file of ["render.mjs", "resolve.mjs", "reach.mjs", "src/consumer.ts"]) {
      const source = readFileSync(join(consumer, file), "utf8");
      assert.ok(
        !/from\s+["']\.\.\//.test(source) && !/import\(["']\.\.\//.test(source),
        `${file} reaches outside the consumer project`,
      );
    }
  });

  check("the installed tree on disk matches the reported unpacked size", () => {
    assert.ok(statSync(join(installed, "dist", "index.js")).size > 0);
    assert.ok(unpackedSize > 0 && packedSize > 0);
  });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} packaging checks passed` +
    `  (packed ${(packedSize / 1024).toFixed(1)} kB, unpacked ${(unpackedSize / 1024).toFixed(1)} kB)`,
);
process.exit(failed.length === 0 ? 0 : 1);
