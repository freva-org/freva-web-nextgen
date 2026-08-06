// Results-list presentation and sidebar chrome: per-format thumbnails, the collapsible sidebar,
// the manual load-next proportion loader, row focus/selection treatment, and geo-chip tagging.

import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  fetchCalls,
  installFetch,
  makeHost,
  overviewResponse,
  searchResponse,
  wait,
} from "./helpers.js";
import { mountDataBrowser } from "../src/index.js";
import type { DataBrowserConfig, DataBrowserHandle } from "../src/types.js";
import { formatOf, genericExt } from "../src/components/formatTile.js";

function q<T extends Element = Element>(root: ParentNode, sel: string): T | null {
  return root.querySelector<T>(sel);
}
function qa<T extends Element = Element>(root: ParentNode, sel: string): T[] {
  return Array.from(root.querySelectorAll<T>(sel));
}

async function mount(
  router: Parameters<typeof installFetch>[0],
  cfg: DataBrowserConfig = {},
): Promise<{
  handle: DataBrowserHandle;
  host: HTMLElement;
  root: HTMLElement;
}> {
  installFetch(router);
  const host = makeHost();
  const handle = mountDataBrowser(host, cfg);
  await wait(30);
  const root = q<HTMLElement>(host, ".freva-db") as HTMLElement;
  return { handle, host, root };
}

const rowsRouter =
  (rows: Array<{ file: string }>, total = rows.length) =>
  (call: { url: string }) => {
    if (call.url.includes("/overview"))
      return { body: overviewResponse(["freva"], { project: [], variable: [] }) };
    if (call.url.includes("/extended-search/") || call.url.includes("/metadata-search/")) {
      return {
        body: searchResponse({
          total,
          rows,
          facets: { project: ["cmip6", total] },
          primary: ["project"],
        }),
      };
    }
    return { body: {} };
  };

// format detection
test("formatOf detects exactly zarr / nc / grib, else null", () => {
  assert.equal(formatOf("/d/tas_day.nc"), "nc");
  assert.equal(formatOf("/d/x.nc4"), "nc");
  assert.equal(formatOf("/d/x.cdf"), "nc");
  assert.equal(formatOf("/store/data.zarr"), "zarr");
  assert.equal(formatOf("/store/data.zarr/.zmetadata"), "zarr"); // zarr dir with inner path
  assert.equal(formatOf("/d/gfs.grib2"), "grib");
  assert.equal(formatOf("/d/gfs.grb"), "grib");
  assert.equal(formatOf("/d/notes.txt"), null);
  assert.equal(formatOf("/d/table.csv"), null);
  assert.equal(formatOf("/d/noext"), null);
  assert.equal(genericExt("/d/table.csv"), "csv");
  assert.equal(genericExt("/d/noext"), "file");
});

test("nc/grib/zarr rows render an SVG thumbnail; others keep the .ext text tile", async () => {
  const { root, handle } = await mount(
    rowsRouter([
      { file: "/d/tas_day_200601.nc" },
      { file: "/store/pr.zarr" },
      { file: "/d/gfs.grib2" },
      { file: "/d/table.csv" },
    ]),
  );
  const rows = qa<HTMLElement>(root, ".row");
  assert.equal(rows.length, 4);
  assert.ok(q(rows[0], ".ftile.nc svg"), "nc thumbnail");
  assert.ok(q(rows[1], ".ftile.zarr svg"), "zarr thumbnail");
  assert.ok(q(rows[2], ".ftile.grib svg"), "grib thumbnail");
  assert.ok(!q(rows[3], ".ftile"), "csv keeps generic tile");
  assert.equal(q<HTMLElement>(rows[3], ".ext")?.textContent, "csv");
  // The tiles reference the brand sprite by id (heavy geometry lives in the DOM once, not per-card),
  // and the mark maps nc -> netcdf.
  assert.equal(
    q<Element>(rows[0], ".ftile.nc svg use")?.getAttribute("href"),
    "#freva-brand-netcdf",
    "nc tile <use>s the netcdf sprite mark",
  );
  assert.equal(
    q<Element>(rows[1], ".ftile.zarr svg use")?.getAttribute("href"),
    "#freva-brand-zarr",
    "zarr tile <use>s the zarr sprite mark",
  );
  // The sprite itself is injected once, carrying every brand symbol the tiles/menus reference.
  for (const id of ["netcdf", "grib", "zarr", "stac", "intake"]) {
    assert.ok(q(root, `symbol#freva-brand-${id}`), `sprite defines #freva-brand-${id}`);
  }
  handle.destroy();
});

test("thumbnails appear in grid view too", async () => {
  const { root, handle } = await mount(rowsRouter([{ file: "/d/x.nc" }]), {});
  (q<HTMLButtonElement>(root, '.seg button[aria-label="Grid view"]') as HTMLButtonElement).click();
  await wait(5);
  assert.ok(q(root, ".gcard .ftile.nc svg"), "grid card shows the nc thumbnail");
  (q<HTMLButtonElement>(root, '.seg button[aria-label="List view"]') as HTMLButtonElement).click(); // reset persisted view
  handle.destroy();
});

// collapsible sidebar
test("sidebar collapse toggles a class and persists", async () => {
  const { root, host, handle } = await mount(rowsRouter([{ file: "/d/x.nc" }]));
  const shell = q<HTMLElement>(root, ".fdb-app") as HTMLElement;
  assert.equal(shell.classList.contains("side-collapsed"), false);
  (q<HTMLButtonElement>(root, ".side-collapse") as HTMLButtonElement).click();
  assert.equal(shell.classList.contains("side-collapsed"), true, "collapses");
  handle.destroy();

  // a fresh mount reads the persisted choice
  installFetch(rowsRouter([{ file: "/d/x.nc" }]));
  const host2 = makeHost();
  const handle2 = mountDataBrowser(host2, {});
  await wait(30);
  const shell2 = q<HTMLElement>(host2, ".fdb-app") as HTMLElement;
  assert.equal(shell2.classList.contains("side-collapsed"), true, "persisted collapsed on remount");
  (q<HTMLButtonElement>(host2, ".side-collapse") as HTMLButtonElement).click(); // reset for other tests
  handle2.destroy();
  void host;
});

// manual load-next proportion loader
test("load-next shows a proportion loader and still triggers a page load", async () => {
  const { root, handle } = await mount(
    rowsRouter(
      Array.from({ length: 100 }, (_, i) => ({ file: `/d/f${i}.nc` })),
      2481,
    ),
  );
  const loader = q<HTMLElement>(root, ".more-loader");
  assert.ok(loader, "proportion loader rendered when total > shown");
  assert.match(loader!.textContent ?? "", /Showing 100 of 2,481/);
  assert.ok(q(loader!, ".more-bar-fill"), "proportion bar present");
  const before = fetchCalls.filter((c) => c.url.includes("/extended-search/")).length;
  (q<HTMLButtonElement>(root, ".load-next") as HTMLButtonElement).click();
  await wait(20);
  const after = fetchCalls.filter(
    (c) => c.url.includes("/extended-search/") && c.url.includes("start=100"),
  ).length;
  assert.ok(after >= 1, "clicking load-next fetches the next page at start=100");
  void before;
  handle.destroy();
});

// row focus ring + geo-chip tagging
test("focusing a row applies .focus without an inset strip class change", async () => {
  const { root, handle } = await mount(rowsRouter([{ file: "/d/a.nc" }, { file: "/d/b.nc" }]));
  const row = q<HTMLElement>(root, ".row") as HTMLElement;
  row.click();
  assert.ok(row.classList.contains("focus"), "row gains .focus (treatment is CSS: tint + ring)");
  handle.destroy();
});

test("a geo chip renders the mode as a .chip-tag, with no `·` separator", async () => {
  const { root, handle } = await mount(rowsRouter([{ file: "/d/a.nc" }]));
  // open the time editor from the sidebar special, set a from-year, apply
  const timeSpecial = qa<HTMLButtonElement>(root, ".special").find((b) =>
    (b.textContent ?? "").includes("Time range"),
  );
  assert.ok(timeSpecial, "time special present");
  timeSpecial!.click();
  await wait(5);
  const fromInput = q<HTMLInputElement>(root, ".pop .editor .daterow input");
  assert.ok(fromInput, "time editor open");
  fromInput!.value = "2006";
  fromInput!.dispatchEvent(
    new (globalThis as unknown as { Event: typeof Event }).Event("input", { bubbles: true }),
  );
  // Editors apply LIVE (no Apply button) - a valid edit commits on `change`.
  fromInput!.dispatchEvent(
    new (globalThis as unknown as { Event: typeof Event }).Event("change", { bubbles: true }),
  );
  await wait(5);
  const geo = q<HTMLElement>(root, ".chips .chip.geo");
  assert.ok(geo, "geo chip rendered");
  assert.ok(q(geo!, ".chip-tag"), "mode shown as a tag, not inline text");
  assert.ok(!(geo!.textContent ?? "").includes("\u00b7"), "geo chip carries no middot separator");
  assert.match(geo!.textContent ?? "", /flexible/); // the default mode as a tag
  handle.destroy();
});

// shell layout: the scroller and height chain the fixed header/footer depend on
test("metadata-focused view keeps the file list (overview + files share the scroller)", async () => {
  const { root, handle } = await mount(rowsRouter([{ file: "/d/a.nc" }, { file: "/d/b.nc" }]));
  // switch to overview / metadata-focused layout
  (q<HTMLButtonElement>(root, '.ctrl[aria-label="Overview"]') as HTMLButtonElement).click();
  await wait(5);
  const shell = q<HTMLElement>(root, ".fdb-app") as HTMLElement;
  assert.ok(shell.classList.contains("metaview"), "entered metaview");
  // the results scroller must still exist and still contain the file rows (not hidden/removed)
  const scroll = q<HTMLElement>(root, ".results-scroll");
  assert.ok(scroll, "results-scroll still present in metaview");
  assert.ok(q(scroll!, ".rows"), "file rows container still inside the scroller");
  assert.equal(qa(scroll!, ".row").length, 2, "file rows still rendered in metadata-focused view");
  // overview lives in the SAME scroller (so files sit below it), not in a separate region
  assert.ok(q(scroll!, ".overview-mode"), "overview shares the results scroller");
  handle.destroy();
});

test("shell has the height chain (.freva-db fills its target) so header/footer can stay fixed", async () => {
  const { root, handle } = await mount(rowsRouter([{ file: "/d/a.nc" }]));
  // structural: header, body, footer are the three grid rows of .fdb-app; all present as
  // direct children in order (the fixed-shell contract).
  const shell = q<HTMLElement>(root, ".fdb-app") as HTMLElement;
  const kids = Array.from(shell.children).map((c) => c.className.split(" ")[0]);
  assert.deepEqual(kids, ["top", "body", "status"], "header / body / footer are the grid rows");
  // .center is explicitly in column 2 so hiding the sidebar can't mis-place it
  const styleText = q<HTMLElement>(root, "style")?.textContent ?? "";
  assert.match(
    styleText,
    /\.freva-db\s*\{[^}]*height:\s*100%/,
    ".freva-db fills its target (height chain)",
  );
  assert.match(styleText, /\.center\s*\{\s*grid-column:\s*2/, ".center pinned to grid column 2");
  handle.destroy();
});

test("sidebar collapse chevron points left when open, right when collapsed", async () => {
  const { root, handle } = await mount(rowsRouter([{ file: "/d/a.nc" }]));
  const styleText = q<HTMLElement>(root, "style")?.textContent ?? "";
  // open state (default): chevron rotated 180deg (points to the edge it collapses to)
  assert.match(
    styleText,
    /\.side-collapse \.chev\s*\{[^}]*rotate\(180deg\)/,
    "open chevron points left",
  );
  // collapsed state: chevron un-rotated (points outward to expand)
  assert.match(
    styleText,
    /\.side-collapsed \.side-collapse \.chev\s*\{[^}]*rotate\(0deg\)/,
    "collapsed chevron points right",
  );
  const btn = q<HTMLButtonElement>(root, ".side-collapse") as HTMLButtonElement;
  assert.equal(btn.getAttribute("aria-label"), "Collapse filters");
  btn.click();
  assert.equal(btn.getAttribute("aria-label"), "Expand filters");
  btn.click(); // reset persisted state for other tests
  handle.destroy();
});
