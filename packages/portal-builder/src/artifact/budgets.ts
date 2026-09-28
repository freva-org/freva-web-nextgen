// What a reader downloads, measured as three things they experience differently: the base
// page (fetched on load), lazy chunks (fetched only when something asks, like the Python
// playground) and the external runtime (Pyodide, from a CDN, not emitted here).
//
// Measured, not limited: there are no size ceilings. They failed builds over a few hundred bytes
// of deliberate features, and a feature's weight depends on what else a portal enables, so no
// single number fit every portal. The measurement stays because the tests use it to check
// structure: a page without Python fetches none of its chunks, and every lazy chunk is charged
// to the feature that loads it.
//
// WHAT DECIDES WHICH IS WHICH is the emitted HTML, not the module graph. Astro hoists the CSS
// of anything reachable from a page's client graph - including through a dynamic import - into
// that page's `<link>` tags, so a chunk the bundler calls dynamic can still be an eager
// download. The artifact is the authority on what the artifact asks for.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { ComponentEvidence } from "./evidence.js";

export interface FeatureBudget {
  javascript: number;
  css: number;
}

export interface BudgetInput {
  /** Artifact-relative path and byte size of every file the compiler emitted. */
  files: { path: string; bytes: number }[];
  /** The artifact directory, so the emitted HTML can say what each page asks for. */
  artifactDir: string;
  components: ComponentEvidence[];
  /** Rendered bytes per module, from the bundler. */
  moduleBytes: Record<string, number>;
  /** Static roots that hold prepared third-party materials, excluded by design. */
  preparedRoots: string[];
  /**
   * Which chunks load which, from the bundler's own record. Needed because a feature's weight
   * is not only the chunks its own modules are in: the interpreter's console is deliberately
   * split into a chunk of nothing but jQuery, jQuery Terminal and Prism - third-party modules
   * no evidence plan owns - reached only from the console's. Without the edges that is 269 KB
   * of the playground's cost attributed to nobody. Optional, so a caller measuring a finished
   * artifact without a build record still gets the direct attribution rather than an error.
   */
  chunkEdges?: { file: string; imports?: string[]; dynamicImports?: string[] }[];
}

/** One page's eager asset set, and what it weighs. */
export interface PageWeight {
  page: string;
  javascript: number;
  css: number;
  assets: string[];
}

export interface BudgetReport {
  /** Every page, heaviest first. */
  pages: PageWeight[];
  /** The union of every page's eager assets. */
  eager: string[];
  /** Emitted `_portal/` code no page references. */
  lazy: { path: string; bytes: number; feature: string | null }[];
  lazyTotals: { javascript: number; css: number };
  features: Record<string, FeatureBudget>;
}

/**
 * An asset reference in emitted HTML, matched by SUFFIX rather than from the root. A portal
 * published under a base path writes `/site/_portal/entry.js`, which an expression anchored at
 * `/_portal/` would not match: every asset would look lazy, the base page would measure zero,
 * and a nested-mount build would count its own eager stylesheet as lazy. The
 * artifact-relative path is the part from `_portal/` onwards, whatever prefix mounts it.
 */
const HTML_ASSET = /(?:src|href)\s*=\s*"[^"]*?(_portal\/[^"]+)"/g;

/** Every emitted HTML page, artifact-relative. */
function htmlPages(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".html")) out.push(relative(dir, full).split(sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * The `_portal/` assets one page asks for before anything is clicked. `src` and `href`
 * together, which covers `<script>`, `<link rel=stylesheet>` and `<link rel=modulepreload>` -
 * the three ways a page states a fetch it will make on load. A `fetch()` a script performs
 * later is by definition not this.
 */
function eagerAssetsOf(html: string): Set<string> {
  const found = new Set<string>();
  HTML_ASSET.lastIndex = 0;
  for (let m = HTML_ASSET.exec(html); m; m = HTML_ASSET.exec(html)) {
    found.add((m[1] as string).replace(/^\//, ""));
  }
  return found;
}

/**
 * Measure the artifact. Separated from the pass/fail so a test - and a report - can read the
 * numbers without deciding whether they are acceptable.
 */
export function measureArtifact(input: BudgetInput): BudgetReport {
  const bytesOf = new Map(input.files.map((f) => [f.path, f.bytes] as const));
  // A chunk's STATIC imports are eager too. The emitted HTML names one script per page, and
  // that script begins with `import` statements the browser resolves and fetches before a line
  // of it runs, so measuring only what the HTML names would measure the first file of an eager
  // graph and call the rest lazy. The gap is not academic: a bundler helper module placed in
  // the interpreter's console chunk makes every page statically import 380 KB of console,
  // jQuery and Prism. Dynamic imports are deliberately NOT followed here: those are the
  // fetches that happen when something asks, which is what `lazy` means.
  const staticImports = new Map(
    (input.chunkEdges ?? []).map((chunk) => [chunk.file, chunk.imports ?? []]),
  );
  const withStaticImports = (assets: Iterable<string>): string[] => {
    const seen = new Set<string>();
    const queue = [...assets];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const next of staticImports.get(file) ?? []) if (!seen.has(next)) queue.push(next);
    }
    return [...seen];
  };
  const portalOwned = input.files.filter(
    (file) =>
      file.path.startsWith("_portal/") &&
      /\.(js|css)$/.test(file.path) &&
      !input.preparedRoots.some((root) => file.path.startsWith(`${root}/`)),
  );

  const pages: PageWeight[] = [];
  const eager = new Set<string>();
  for (const page of htmlPages(input.artifactDir)) {
    const html = readFileSync(join(input.artifactDir, ...page.split("/")), "utf8");
    const assets = withStaticImports(eagerAssetsOf(html))
      .filter((a) => bytesOf.has(a))
      .sort();
    for (const asset of assets) eager.add(asset);
    pages.push({
      page,
      javascript: assets
        .filter((a) => a.endsWith(".js"))
        .reduce((n, a) => n + (bytesOf.get(a) ?? 0), 0),
      css: assets.filter((a) => a.endsWith(".css")).reduce((n, a) => n + (bytesOf.get(a) ?? 0), 0),
      assets,
    });
  }
  // Heaviest first, and ties broken by path so two builds of one input report the same page.
  pages.sort(
    (a, b) =>
      b.javascript + b.css - (a.javascript + a.css) ||
      (a.page < b.page ? -1 : a.page > b.page ? 1 : 0),
  );

  // Which feature a lazy file belongs to. Two sources, both declarations rather than guesses:
  // a CHUNK is a feature's when the evidence says the feature's modules are in it, the same
  // attribution the absence check uses; an emitted file that is not a chunk at all - a Worker
  // bundle, which the bundler emits beside the graph rather than in it - is claimed by name,
  // from the plan's own `ownedEmittedNames`.
  const featureOf = new Map<string, string>();
  for (const component of input.components) {
    if (!component.enabled) continue;
    for (const chunk of component.chunks) {
      if (!featureOf.has(chunk)) featureOf.set(chunk, component.id);
    }
    for (const name of component.ownedEmittedNames ?? []) {
      for (const file of portalOwned) {
        const base = file.path.slice("_portal/".length);
        if (base.startsWith(name) && !featureOf.has(file.path))
          featureOf.set(file.path, component.id);
      }
    }
  }

  // …and then along the bundler's edges, once, from what is already attributed. A chunk
  // reached only from a feature's own chunks is that feature's weight however few of its
  // modules any plan owns. `eager` is excluded because a chunk on a page is the base page's
  // cost and not a feature's, and an already-claimed chunk is never re-claimed, so a chunk two
  // features can both reach stays with the first - the same first-wins rule the direct
  // attribution above uses.
  const edges = new Map(
    (input.chunkEdges ?? []).map((chunk) => [
      chunk.file,
      [...(chunk.imports ?? []), ...(chunk.dynamicImports ?? [])],
    ]),
  );
  const frontier = [...featureOf.keys()];
  while (frontier.length > 0) {
    const file = frontier.pop()!;
    const owner = featureOf.get(file);
    if (!owner) continue;
    for (const next of edges.get(file) ?? []) {
      if (eager.has(next) || featureOf.has(next)) continue;
      featureOf.set(next, owner);
      frontier.push(next);
    }
  }

  const lazy = portalOwned
    .filter((file) => !eager.has(file.path))
    .map((file) => ({
      path: file.path,
      bytes: file.bytes,
      feature: featureOf.get(file.path) ?? null,
    }))
    .sort((a, b) => b.bytes - a.bytes);

  const features: Record<string, FeatureBudget> = {};
  for (const entry of lazy) {
    if (!entry.feature) continue;
    const bucket = (features[entry.feature] ??= { javascript: 0, css: 0 });
    if (entry.path.endsWith(".js")) bucket.javascript += entry.bytes;
    else bucket.css += entry.bytes;
  }

  return {
    pages,
    eager: [...eager].sort(),
    lazy,
    lazyTotals: {
      javascript: lazy.filter((f) => f.path.endsWith(".js")).reduce((n, f) => n + f.bytes, 0),
      css: lazy.filter((f) => f.path.endsWith(".css")).reduce((n, f) => n + f.bytes, 0),
    },
    features,
  };
}

/** Kept so a caller that only wants the file list does not need `node:fs` of its own. */
export function artifactFileSizes(dir: string): { path: string; bytes: number }[] {
  const out: { path: string; bytes: number }[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push({ path: relative(dir, full).split(sep).join("/"), bytes: statSync(full).size });
    }
  };
  walk(dir);
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}
