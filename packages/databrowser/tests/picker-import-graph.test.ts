// The picker's exclusions, asserted against the BUILT artifact rather than promised in a comment.
//
// "The picker entry must not import the terminal, the overview, the inspector, the app shell or the
// full stylesheet" is only meaningful if something checks it. A comment does not survive a helpful
// refactor that adds one convenient import; this walks the real ES module graph from
// `dist/picker.js` and fails the moment any of those reappear - which is also the moment the
// picker's size and coupling story quietly stops being true.
//
// It reads dist/, so `npm run build` must have run. The package's `pretest` hook builds the
// workspace dependency, and `npm test` in this package runs `tsc` first, so dist/ is present in
// every supported workflow; a missing build is reported as a skip with the reason, never a pass.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const DIST = join(process.cwd(), "dist");
const PKG = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
  exports: Record<string, unknown>;
  dependencies?: Record<string, string>;
};

/** Static import/export specifiers of an ES module, ignoring anything inside a string literal. */
function specifiers(code: string): string[] {
  const out: string[] = [];
  const re =
    /(?:^|[\n;])\s*(?:import|export)\b[^'"\n]*?from\s*["']([^"']+)["']|(?:^|[\n;])\s*import\s*["']([^"']+)["']/g;
  for (const m of code.matchAll(re)) out.push(m[1] ?? m[2]);
  // Dynamic imports count too - a lazily-loaded inspector is still a dependency of the entry.
  for (const m of code.matchAll(/\bimport\(\s*["']([^"']+)["']/g)) out.push(m[1]);
  return out;
}

interface Graph {
  files: string[];
  bare: string[];
  bytes: number;
}

/** Walk the module graph from an entry inside dist/, returning local files and bare specifiers. */
function walk(entry: string): Graph {
  const seen = new Set<string>();
  const bare = new Set<string>();
  let bytes = 0;
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const code = readFileSync(file, "utf8");
    bytes += statSync(file).size;
    for (const spec of specifiers(code)) {
      if (spec.startsWith(".")) {
        const abs = resolve(dirname(file), spec);
        if (existsSync(abs)) queue.push(abs);
        else bare.add(spec); // an unresolvable relative import is a build defect, surfaced below
      } else {
        bare.add(spec);
      }
    }
  }
  return { files: [...seen], bare: [...bare], bytes };
}

const rel = (f: string): string => f.slice(DIST.length + 1);

const built = existsSync(join(DIST, "picker.js")) && existsSync(join(DIST, "index.js"));

test("the package exposes ./picker as a real subpath export, and keeps the root import", () => {
  assert.deepEqual(PKG.exports["."], {
    types: "./dist/index.d.ts",
    import: "./dist/index.js",
  });
  assert.deepEqual(PKG.exports["./picker"], {
    types: "./dist/picker.d.ts",
    import: "./dist/picker.js",
  });
  // `./intent` is the serialisation half of the SearchIntentV1 handoff, split out so a build-time
  // consumer (the portal builder runs in Node) can produce a link without pulling the widget - and
  // so the landing page and this component cannot disagree about the wire form.
  assert.deepEqual(PKG.exports["./intent"], {
    types: "./dist/intent.d.ts",
    import: "./dist/intent.js",
  });
  // `./metadata` is the description half of the same handoff: the portal's landing box offers the
  // values this component will show, and a box that cannot describe them is a box that finds
  // nothing when a visitor searches for what a value MEANS. Data only - no mount, no DOM.
  assert.deepEqual(PKG.exports["./metadata"], {
    types: "./dist/metadata-public.d.ts",
    import: "./dist/metadata-public.js",
  });
  // No wildcard subpath: consumers must not be able to reach into internals and then depend on
  // them. `./package.json` is the one conventional extra (tooling reads it).
  assert.deepEqual(Object.keys(PKG.exports).sort(), [
    ".",
    "./intent",
    "./metadata",
    "./package.json",
    "./picker",
  ]);
  for (const key of Object.keys(PKG.exports)) assert.equal(key.includes("*"), false);
});

test(
  "the picker entry excludes the terminal, overview, inspector, shell and full stylesheet",
  {
    skip: built ? false : "dist/ not built - run `npm run build`",
  },
  () => {
    const g = walk(join(DIST, "picker.js"));
    const files = g.files.map(rel);

    const FORBIDDEN: Array<[string, RegExp]> = [
      ["the full application entry", /^index\.js$/],
      ["the application shell builder", /^shell\.js$/],
      ["the terminal adapter", /databrowserTerminalAdapter/],
      ["the overview grid", /components\/overview\.js$/],
      ["the inspector", /components\/inspector\.js$/],
      ["the details / comparison panel", /components\/details\.js$/],
      ["the results view", /components\/results\.js$/],
      ["the sidebar", /components\/sidebar\.js$/],
      ["the export/downloads path", /downloads\.js$/],
      ["the brand logo", /^logo\.js$/],
      ["the brand block", /^brand\.js$/],
      ["the leaflet map", /leafletMap|^map\.js$/],
      ["the full databrowser stylesheet", /^styles\.js$/],
      ["the heavy Api client", /^api\.js$/],
    ];
    for (const [what, re] of FORBIDDEN) {
      const hit = files.filter((f) => re.test(f));
      assert.deepEqual(hit, [], `the picker entry now reaches ${what}: ${hit.join(", ")}`);
    }

    // …and it reaches no third-party or first-party PACKAGE at all: the terminal package is a
    // dependency of the root entry only.
    assert.deepEqual(g.bare, [], `the picker entry gained external imports: ${g.bare.join(", ")}`);
    assert.equal(
      files.some((f) => f.includes("freva-client-terminal")),
      false,
    );

    // It does reach the SHARED boundary - that is the point of the exercise.
    for (const required of ["search/query.js", "search/engine.js", "state.js", "picker/mount.js"]) {
      assert.ok(files.includes(required), `the picker entry no longer uses ${required}`);
    }
  },
);

test(
  "the metadata entry is data only, and does not drag the built-in set into the initial load",
  {
    skip: built ? false : "dist/ not built - run `npm run build`",
  },
  () => {
    const g = walk(join(DIST, "metadata-public.js"));
    const files = g.files.map(rel);

    // A host imports this to describe a facet value in ITS OWN UI. Anything that
    // renders, mounts or fetches would make that import cost a page's worth of
    // application for one string.
    const FORBIDDEN: Array<[string, RegExp]> = [
      ["the full application entry", /^index\.js$/],
      ["the application shell builder", /^shell\.js$/],
      ["the picker", /^picker(\.js|\/)/],
      ["a component", /^components\//],
      ["the Api client", /^api\.js$/],
      ["the full databrowser stylesheet", /^styles\.js$/],
      ["the leaflet map", /leafletMap|^map\.js$/],
    ];
    for (const [what, re] of FORBIDDEN) {
      const hit = files.filter((f) => re.test(f));
      assert.deepEqual(hit, [], `the metadata entry now reaches ${what}: ${hit.join(", ")}`);
    }
    assert.deepEqual(
      g.bare,
      [],
      `the metadata entry gained external imports: ${g.bare.join(", ")}`,
    );

    // The 2,498 descriptions are reached through a DYNAMIC import, so a bundler
    // splits them: importing this module must not, by itself, pull them in.
    const entry = readFileSync(join(DIST, "metadata.js"), "utf8");
    assert.match(entry, /import\(\s*["'].\/metadata-builtin\.js["']/);
    assert.equal(
      /(?:^|[\n;])\s*import\b[^'"\n]*?from\s*["'].\/metadata-builtin\.js["']/.test(entry),
      false,
      "metadata.js gained a STATIC import of the built-in set",
    );
  },
);

test(
  "the root entry still reaches everything it is supposed to",
  {
    skip: built ? false : "dist/ not built - run `npm run build`",
  },
  () => {
    const g = walk(join(DIST, "index.js"));
    const files = g.files.map(rel);
    for (const required of ["shell.js", "components/overview.js", "styles.js", "api.js"]) {
      assert.ok(files.includes(required), `the root entry lost ${required}`);
    }
    assert.ok(g.bare.includes("@freva-org/freva-client-terminal"));
    // The inspector is a declared dependency reached only through a dynamic import.
    assert.ok(g.bare.includes("@freva-org/data-inspector"));
    assert.ok(PKG.dependencies?.["@freva-org/data-inspector"]);
    // The root entry must NOT drag the picker in either - a host that never uses it pays nothing.
    assert.equal(files.includes("picker/mount.js"), false);
    assert.equal(files.includes("picker/styles.js"), false);
  },
);

test(
  "every type reachable from the picker's public config is exported by name",
  {
    skip: built ? false : "dist/ not built - run `npm run build`",
  },
  () => {
    // A config field whose TYPE is not exported compiles fine here and fails in a CONSUMER's
    // tsconfig, which is the worst place to find out - `resolveFlavourMaps` returning a
    // `FlavourMapping[]` is exactly such a field, so the type has to be exported too.
    const dts = readFileSync(join(DIST, "picker.d.ts"), "utf8");
    const REQUIRED = [
      "mountDataPicker",
      "DataPickerConfig",
      "DataPickerHandle",
      "PickerState",
      "PickerFeatureFlags",
      "FlavourMapping",
      "DataReference",
      "AssetReference",
      "StacLocator",
      "DataSource",
      "EffectiveSearchQuery",
      "QueryScope",
      "SearchClient",
      "isDataReference",
      "FREVA_DATA_REFERENCE_MIME",
      "DATA_REFERENCE_JSON_SCHEMA",
    ];
    const missing = REQUIRED.filter((n) => !new RegExp(`\\b${n}\\b`).test(dts));
    assert.deepEqual(missing, [], `not exported from ./picker: ${missing.join(", ")}`);
  },
);

test(
  "the picker entry is a small fraction of the root entry",
  {
    skip: built ? false : "dist/ not built - run `npm run build`",
  },
  () => {
    const picker = walk(join(DIST, "picker.js"));
    const root = walk(join(DIST, "index.js"));
    const ratio = picker.bytes / root.bytes;
    // Reported as much as asserted: the number belongs in CI output, and the bound exists so an
    // accidental re-coupling shows up as a size cliff rather than a slow drift.
    console.log(
      `picker entry: ${picker.files.length} modules, ${(picker.bytes / 1024).toFixed(1)} kB\n` +
        `root entry:   ${root.files.length} modules, ${(root.bytes / 1024).toFixed(1)} kB\n` +
        `ratio:        ${(ratio * 100).toFixed(1)}%`,
    );
    assert.ok(
      ratio < 0.35,
      `the picker entry grew to ${(ratio * 100).toFixed(1)}% of the root entry`,
    );
  },
);

test(
  "the intent entry stays free of the widget, so a Node build can import it",
  {
    skip: existsSync(join(DIST, "intent.js")) ? false : "dist/ not built - run `npm run build`",
  },
  () => {
    // The portal builder imports this at *build* time to serialise a landing
    // page's search into the component's own URL contract. If it pulled in the
    // mounting half, a Node process would evaluate DOM-dependent modules to
    // produce a query string.
    const graph = walk(join(DIST, "intent.js"));
    const forbidden = graph.files.map(rel).filter((f) => f !== "intent.js" && f !== "types.js");
    assert.deepEqual(forbidden, [], `intent.js reached ${forbidden.join(", ")}`);
  },
);
