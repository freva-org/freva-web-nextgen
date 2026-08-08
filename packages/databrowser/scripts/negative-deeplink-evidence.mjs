// scripts/negative-deeplink-evidence.mjs - print the EXACT requests a negative deep link produces.
//
// Diagnostic, not a gate: `tests/negative-lifecycle.test.ts` is what fails CI. This exists so the
// A/B is reproducible on demand - run it with `--broken` to restore the old base-key-blind
// reconciliation in memory and watch the second, unfiltered search appear.
//
//   node scripts/negative-deeplink-evidence.mjs
//   node scripts/negative-deeplink-evidence.mjs --broken
import { JSDOM } from "jsdom";
import process from "node:process";

const BROKEN = process.argv.includes("--broken");

const dom = new JSDOM("<!doctype html><html><body><div id=app></div></body></html>", {
  url: "https://example.test/?project_not_=cmip6",
  pretendToBeVisual: true,
});
const w = dom.window;
const g = globalThis;
g.window = w;
g.document = w.document;
for (const k of [
  "HTMLElement",
  "HTMLButtonElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "Element",
  "Node",
  "MutationObserver",
  "SVGElement",
  "Event",
  "CustomEvent",
  "KeyboardEvent",
  "MouseEvent",
]) {
  g[k] = w[k];
}
g.getComputedStyle = w.getComputedStyle.bind(w);
w.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const requests = [];
const body = (url) =>
  url.includes("/overview")
    ? { flavours: ["freva"], attributes: { freva: ["project", "variable"] } }
    : {
        total_count: 3,
        facets: { project: ["cordex", 3], variable: ["tas", 3] },
        primary_facets: ["project", "variable"],
        facet_mapping: {},
        search_results: [{ file: "/archive/tas.nc", fs_type: "posix" }],
      };
g.fetch = async (url) => {
  requests.push(String(url));
  return new Response(JSON.stringify(body(String(url))), {
    headers: { "content-type": "application/json" },
  });
};

// Load the compiled controller. With `--broken`, the ONE fixed line is reverted in a throwaway copy
// of the build output - `baseFacetKey(k)` becomes the literal key again - so the A/B differs by
// exactly the change under discussion and nothing else.
const ENTRY = new URL("../dist-test/src/index.js", import.meta.url);
let entryUrl = ENTRY;
if (BROKEN) {
  const { readFileSync, writeFileSync, cpSync, rmSync, mkdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { fileURLToPath, pathToFileURL } = await import("node:url");
  // Inside the package, not /tmp: the copy still has to resolve the workspace's node_modules.
  const dir = fileURLToPath(new URL("../dist-test/__broken__", import.meta.url));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  cpSync(fileURLToPath(new URL("../dist-test/src", import.meta.url)), join(dir, "src"), {
    recursive: true,
  });
  const f = join(dir, "src", "index.js");
  const before = readFileSync(f, "utf8");
  const after = before.replace(
    "if (!known.has(baseFacetKey(k).toLowerCase())) {",
    "if (!known.has(k.toLowerCase())) {",
  );
  if (after === before) throw new Error("the reconcile guard moved - update this script");
  writeFileSync(f, after);
  entryUrl = pathToFileURL(f);
}

const { mountDataBrowser } = await import(entryUrl.href);
const handle = mountDataBrowser(document.getElementById("app"), {
  syncUrl: true,
  apiBase: "/api/freva-nextgen/databrowser",
});
await new Promise((r) => setTimeout(r, 900));

const searches = requests.filter((u) => u.includes("/extended-search/"));
console.log(
  `mode:            ${BROKEN ? "BEFORE (base-key-blind reconciliation)" : "AFTER (fixed)"}`,
);
console.log(`deep link:       ?project_not_=cmip6`);
console.log(`search requests: ${searches.length}`);
for (const [i, u] of searches.entries()) console.log(`  ${i + 1}. ${u}`);
console.log(`state.selected:  ${JSON.stringify(handle.getState().selected)}`);
console.log(`window.location: ${w.location.search}`);
handle.destroy();
process.exit(0);
