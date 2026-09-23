// What a reader downloads, in three kinds, each with its own reviewed ceiling.
//
// One number summing every `.js` and `.css` file under `_portal/` is only fair while
// everything the compiler emits is also everything a page loads, and a feature whose whole
// point is that it is NOT loaded breaks that: the documented Python playground is a quarter
// of a megabyte no visitor fetches unless they press a button. Exempting those bytes leaves a
// hole in the budget; raising the ceiling for everybody stops the base-page budget bounding
// the base page. So the artifact is measured as three things a reader experiences differently:
//
//   1. THE BASE PAGE - what a browser fetches to render a page, before any interaction.
//      Bounded strictly, because every visitor pays it on every page, and measured per page
//      and reported for the heaviest: a sum would charge one visitor for another's page.
//   2. LAZY CHUNKS - emitted code no page references, fetched only when something asks for it:
//      the Data Browser's metadata tables, the Python playground's console and Worker. Bounded
//      per feature as well as in total, because "it is lazy" is a reason to weigh it
//      differently and not a reason to stop weighing it.
//   3. THE EXTERNAL RUNTIME - Pyodide and its wheels, which this build neither emits nor can
//      bound: they come from a CDN at the version `@freva-org/browser-python` pins. Recorded
//      in `budgets.json` as a documented figure, not a gate, since it cannot be measured here.
//
// WHAT DECIDES WHICH IS WHICH is the emitted HTML, not the module graph. Astro hoists the CSS
// of anything reachable from a page's client graph - including through a dynamic import - into
// that page's `<link>` tags, so a chunk the bundler calls dynamic can still be an eager
// download. The artifact is the authority on what the artifact asks for.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Diagnostic } from "../diagnostics.js";
import { SCHEMA_DIR } from "../util/package.js";
import type { ComponentEvidence } from "./evidence.js";

export interface FeatureBudget {
  javascript: number;
  css: number;
}

export interface Budgets {
  schemaVersion: 2;
  basePage: { javascript: number; css: number };
  lazy: { javascript: number; css: number; features: Record<string, FeatureBudget> };
  components: Record<string, { javascript: number }>;
  /** Documented, not enforced: this build does not emit it and cannot measure it. */
  externalRuntime?: Record<string, unknown>;
}

let cached: Budgets | undefined;

export function loadBudgets(): Budgets {
  if (!cached) {
    cached = JSON.parse(readFileSync(join(SCHEMA_DIR, "budgets.json"), "utf8")) as Budgets;
  }
  return cached;
}

/** For tests that write their own `budgets.json`; the loader caches by design. */
export function resetBudgetCache(): void {
  cached = undefined;
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
 * and a nested-mount build would fail its lazy budget with its own eager stylesheet. The
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

export function checkBudgets(input: BudgetInput): Diagnostic[] {
  const budgets = loadBudgets();
  const diagnostics: Diagnostic[] = [];
  const report = measureArtifact(input);

  const over = (what: string, actual: number, limit: number, hint?: string): void => {
    if (actual <= limit) return;
    diagnostics.push({
      code: "FP1407",
      severity: "error",
      message: `${what} is ${actual} bytes, above the reviewed budget of ${limit} bytes.`,
      hint:
        hint ??
        "Reduce the bundle, or change the budget in schema/budgets.json with a reason in the pull request.",
    });
  };

  // The heaviest page, not the sum of every page. A budget on the sum charges one visitor for
  // a page they will never open, and gets steadily harder to meet as a site publishes more
  // content, which would make "add a documentation page" a bundle-size decision.
  const heaviest = report.pages[0];
  if (heaviest) {
    over(
      `Base-page JavaScript (heaviest page: ${heaviest.page})`,
      heaviest.javascript,
      budgets.basePage.javascript,
      "This is what every visitor downloads before interacting. Move work behind a dynamic import, or change schema/budgets.json with a reason.",
    );
    over(
      `Base-page CSS (heaviest page: ${heaviest.page})`,
      heaviest.css,
      budgets.basePage.css,
      "This is what every visitor downloads before interacting. Move stylesheets off the eager path, or change schema/budgets.json with a reason.",
    );
  }

  // THE AGGREGATE FAILURE SAYS WHERE THE BYTES ARE. "983497 is above 983040" answers nothing:
  // the number is a sum over every optional feature in the build, and a consumer reading it in
  // their own CI cannot tell whether the interpreter grew, or the Data Browser did, or they
  // enabled something. So the message carries the breakdown the report already holds: per
  // feature, largest first, with the unattributed remainder named as such rather than left as
  // the difference between two numbers nobody printed.
  const breakdown = Object.entries(report.features)
    .map(([feature, totals]) => [feature, totals.javascript] as const)
    .sort((a, b) => b[1] - a[1]);
  const attributed = breakdown.reduce((sum, [, bytes]) => sum + bytes, 0);
  const unattributed = report.lazyTotals.javascript - attributed;
  const where = [
    ...breakdown.map(([feature, bytes]) => `${feature} ${bytes}`),
    ...(unattributed > 0 ? [`unattributed ${unattributed}`] : []),
  ].join(", ");
  over(
    "Lazily loaded JavaScript",
    report.lazyTotals.javascript,
    budgets.lazy.javascript,
    `Where it is: ${where}. Each optional feature also has its own ceiling in ` +
      "schema/budgets.json; this total is those plus an allowance for what the edge walk cannot " +
      "attribute. Reduce the feature that grew, or change the budget with a reason.",
  );
  over("Lazily loaded CSS", report.lazyTotals.css, budgets.lazy.css);

  for (const [feature, limit] of Object.entries(budgets.lazy.features)) {
    const actual = report.features[feature];
    if (!actual) continue;
    over(`Lazily loaded JavaScript for '${feature}'`, actual.javascript, limit.javascript);
    over(`Lazily loaded CSS for '${feature}'`, actual.css, limit.css);
  }

  // A component's share is the rendered size of the modules it owns. Charging it for the whole
  // shared chunk would make every component look like every other one, the same as having no
  // per-component budget at all.
  for (const component of input.components) {
    if (!component.enabled) continue;
    const limit = budgets.components[component.kind]?.javascript;
    if (limit === undefined) continue;
    const bytes = component.modules.reduce((n, id) => n + (input.moduleBytes[id] ?? 0), 0);
    over(`Component '${component.id}' JavaScript`, bytes, limit);
  }

  return diagnostics;
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
