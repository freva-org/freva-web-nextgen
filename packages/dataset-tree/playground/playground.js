// The playground's wiring. Not part of the published package.
//
// It imports the built package by relative path, exactly as a consumer would import it by name, so
// what is exercised here is the real `dist/` and not the TypeScript sources.

import { mountDatasetTree } from "../dist/index.js";
import { createSnapshotSource, parseDatasetTreeCatalogV1 } from "../dist/snapshot.js";
import { parseDatasetTreeSearchIndexV1 } from "../dist/search-index.js";

/**
 * A synthetic climate archive. Invented names, invented sizes: it resembles a CMIP-style tree
 * closely enough to look real and describes no actual holdings.
 */
const CATALOG = {
  schemaVersion: 1,
  generatedAt: "2026-01-06T10:00:00Z",
  source: "https://s3.example.org",
  roots: [
    {
      id: "pg:reanalysis",
      kind: "collection",
      name: "reanalysis",
      title: "Global Reanalysis",
      description: "Hourly atmospheric fields on a 0.25° grid, 1979 to present",
      path: "s3://demo-archive/reanalysis/",
      link: { href: "https://example.test/reanalysis", label: "Reanalysis project page" },
      children: [
        {
          id: "pg:reanalysis/surface",
          kind: "directory",
          name: "surface",
          children: [
            {
              id: "pg:reanalysis/surface/tas",
              kind: "dataset",
              name: "tas.zarr",
              title: "Near-surface air temperature",
              path: "s3://demo-archive/reanalysis/surface/tas.zarr",
              size: 1503238553,
              mediaType: "application/vnd.zarr",
              modifiedAt: "2026-02-11T09:14:00Z",
              inspect: "https://example.test/demo-archive/reanalysis/surface/tas.zarr",
              // The row's right edge: one declared metric plus the size. Nothing else appears
              // there, however much the node carries.
              metrics: [{ label: "HP", value: "7" }],
              details: [
                {
                  label: "DIMS",
                  values: [
                    { text: "time", value: "350 640" },
                    { text: "cell", value: "12 582 912" },
                  ],
                },
                {
                  label: "VARS",
                  values: [{ text: "tas" }, { text: "tas_min" }, { text: "tas_max" }],
                },
              ],
              // Carried for a consumer or an inspector; never rendered by the component.
              metadata: {
                dims: { time: 350640, lat: 721, lon: 1440 },
                vars: ["tas", "tas_min", "tas_max"],
                title: "2 m air temperature",
              },
              access: [
                {
                  label: "HTTPS",
                  href: "https://example.test/demo-archive/reanalysis/surface/tas.zarr",
                },
                { label: "S3", value: "s3://demo-archive/reanalysis/surface/tas.zarr" },
              ],
            },
            {
              id: "pg:reanalysis/surface/pr",
              kind: "dataset",
              name: "pr.zarr",
              title: "Precipitation flux",
              path: "s3://demo-archive/reanalysis/surface/pr.zarr",
              size: 987654321,
              mediaType: "application/vnd.zarr",
              modifiedAt: "2026-02-11T09:20:00Z",
              inspect: "https://example.test/demo-archive/reanalysis/surface/pr.zarr",
              metrics: [{ label: "HP", value: "7" }],
              details: [{ label: "VARS", values: [{ text: "pr" }] }],
              metadata: { dims: { time: 350640, lat: 721, lon: 1440 }, vars: ["pr"] },
            },
            {
              id: "pg:reanalysis/surface/readme",
              kind: "file",
              name: "README.md",
              path: "s3://demo-archive/reanalysis/surface/README.md",
              size: 4096,
              mediaType: "text/markdown",
              modifiedAt: "2026-01-04T12:00:00Z",
            },
            {
              id: "pg:reanalysis/surface/checksums",
              kind: "file",
              name: "checksums.sha256",
              path: "s3://demo-archive/reanalysis/surface/checksums.sha256",
              size: 182734,
              mediaType: "text/plain",
            },
          ],
        },
        {
          id: "pg:reanalysis/pressure",
          kind: "directory",
          name: "pressure-levels",
          children: [],
        },
      ],
    },
    {
      id: "pg:scenarios",
      kind: "collection",
      name: "scenarios",
      title: "Scenario Ensemble",
      description: "Six shared socioeconomic pathways, decadal means",
      path: "s3://demo-archive/scenarios/",
      link: { href: "https://example.test/scenarios", label: "Scenario project page" },
      children: [
        {
          id: "pg:scenarios/ssp126",
          kind: "dataset",
          name: "ssp126.zarr",
          path: "s3://demo-archive/scenarios/ssp126.zarr",
          size: 81200000,
          mediaType: "application/vnd.zarr",
        },
        {
          id: "pg:scenarios/ssp245",
          kind: "dataset",
          name: "ssp245.zarr",
          path: "s3://demo-archive/scenarios/ssp245.zarr",
          size: 93400000,
          mediaType: "application/vnd.zarr",
        },
        {
          id: "pg:scenarios/ssp585",
          kind: "dataset",
          name: "ssp585.zarr",
          path: "s3://demo-archive/scenarios/ssp585.zarr",
          size: 102400000,
          mediaType: "application/vnd.zarr",
        },
      ],
    },
    {
      id: "pg:downscaling",
      kind: "collection",
      name: "downscaling",
      title: "Regional Downscaling",
      description: "Convection-permitting runs over Europe",
      availability: "planned",
      availabilityNote: "available 2027",
      hasChildren: false,
    },
    {
      id: "pg:restricted",
      kind: "collection",
      name: "embargoed",
      title: "Embargoed Campaign",
      description: "Released to project members only until publication",
      availability: "restricted",
      availabilityNote: "project members only",
      hasChildren: false,
    },
  ],
};

const catalog = parseDatasetTreeCatalogV1(CATALOG);
const base = createSnapshotSource(catalog);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The snapshot source, slowed down, and rigged to fail one branch once.
 *
 * A demo where everything is instantaneous cannot show a spinner, an error or a Retry button, which
 * are three of the states most worth looking at.
 */
function theatricalSource(inner, { delayMs = 700, failOnce = "pg:scenarios" } = {}) {
  const failed = new Set();
  const wait = async (ms, signal) => {
    await sleep(ms);
    if (signal.aborted) {
      const error = new Error("The operation was aborted.");
      error.name = "AbortError";
      throw error;
    }
  };
  return {
    async loadRoots(context) {
      await wait(delayMs, context.signal);
      return inner.loadRoots(context);
    },
    async loadChildren(node, context) {
      await wait(delayMs, context.signal);
      if (node.id === failOnce && !failed.has(node.id)) {
        failed.add(node.id);
        throw new Error("HTTP 503 - the catalog service is warming up");
      }
      return inner.loadChildren(node, context);
    },
  };
}

// A stand-in for the build-time registered-example manifest.
//
// A real host registers every runnable snippet at build time and hands the component the digest
// it was registered under; this page has no build step, so it hashes the snippets it generates
// and remembers them here. `accessExamples` is synchronous and `crypto.subtle` is not, so the
// cache fills during load and an example is offered as runnable only once its digest has landed -
// which is exactly the behaviour a host with a missing manifest entry should show: no button.
const digests = new Map();

async function register(code) {
  if (digests.has(code)) return;
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
  digests.set(
    code,
    [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join(""),
  );
}

function pythonFor(uri) {
  return `import xarray as xr\n\nds = xr.open_zarr(\n    "${uri}",\n    storage_options={"anon": True},\n)\nprint(ds)`;
}

/** Per-node code samples. A consumer supplies these; the package ships none. */
const accessExamples = (node) => {
  if (!node.path || !node.path.startsWith("s3://")) return [];
  const uri = node.path;
  const code = pythonFor(uri);
  return [
    {
      id: `${node.id}:python`,
      label: "Python",
      language: "python",
      description: "Open the store directly over the object-store protocol.",
      code,
      executable: true,
      digest: digests.get(code),
    },
    {
      id: `${node.id}:cli`,
      label: "CLI",
      language: "shell",
      description: "Copy the store to the current directory.",
      code: `s5cmd --no-sign-request cp "${uri}/*" .`,
    },
    {
      // A template, on purpose. It is Python, it is marked executable and it is registered - and
      // it still gets no run button, because `<YOUR-TOKEN>` is a blank a human has to fill in.
      id: `${node.id}:token`,
      label: "Python (token)",
      language: "python",
      description: "Needs a credential, so it is copyable but not runnable.",
      code: `import xarray as xr\n\nds = xr.open_zarr("${uri}", storage_options={"token": "<YOUR-TOKEN>"})`,
      executable: true,
      digest: "0".repeat(64),
    },
  ];
};

/**
 * The consumer side of "Try in Python", standing in for a portal's execution layer.
 *
 * It prints what actually arrived, which is the point of the demonstration: a name and a digest,
 * and no Python at all. The playground has no interpreter and does not pretend to have one.
 */
const python = {
  enabled: true,
  onTry: (event) => {
    const panel = document.querySelector("#inspector");
    if (!panel) return;
    panel.hidden = false;
    panel.querySelector("[data-inspector-target]").textContent =
      `Try in Python -> ${JSON.stringify(event)}`;
    panel.focus();
  },
};

/**
 * An optional search index for the lazy tree, exactly as a consumer would supply one.
 *
 * It names two stores in a branch this playground's slow source never opens on its own, which is
 * the whole point: type `ocean` into the left-hand tree and they are found, with no request made.
 * Loaded by the host - here, inlined - and never fetched by the package.
 */
const SEARCH_INDEX = parseDatasetTreeSearchIndexV1({
  schemaVersion: 1,
  generatedAt: "2026-02-01T00:00:00Z",
  source: "https://s3.example.org",
  complete: true,
  entries: [
    {
      id: "pg:ocean/sst",
      kind: "dataset",
      name: "sst.zarr",
      title: "Sea-surface temperature",
      path: "s3://demo-archive/ocean/sst.zarr",
      size: 812_000_000,
      modifiedAt: "2026-01-18T06:30:00Z",
      ancestors: [{ id: "pg:ocean", name: "ocean", title: "Ocean" }],
    },
    {
      id: "pg:ocean/sos",
      kind: "dataset",
      name: "sos.zarr",
      title: "Sea-surface salinity",
      path: "s3://demo-archive/ocean/sos.zarr",
      size: 640_000_000,
      ancestors: [{ id: "pg:ocean", name: "ocean", title: "Ocean" }],
    },
    {
      id: "pg:reanalysis/surface/tas",
      kind: "dataset",
      name: "tas.zarr",
      path: "s3://demo-archive/reanalysis/surface/tas.zarr",
      ancestors: [
        { id: "pg:reanalysis", name: "reanalysis", title: "Global Reanalysis" },
        { id: "pg:reanalysis/surface", name: "surface" },
      ],
    },
  ],
});

const treeA = mountDatasetTree(document.querySelector("#tree-a"), {
  source: theatricalSource(base),
  searchIndex: SEARCH_INDEX,
  accessExamples,
  python,
  initialExpandedIds: ["pg:reanalysis"],
  status: {
    tone: "snapshot",
    label: "SNAPSHOT",
    detail: "2026-01-06 10:00 UTC",
    code: "https://s3.example.org",
  },
  // A consumer's own surface. The package deliberately opens no modal of its own, and this is not
  // an `alert()`: an alert is a placeholder that looks like an integration, and the whole point of
  // the two-sided gate (a consumer supplies this, AND the node supplies `inspect`) is that a
  // control the reader can see is a control that does something.
  onInspect: (node) => {
    const panel = document.querySelector("#inspector");
    if (!panel) return;
    panel.hidden = false;
    panel.querySelector("[data-inspector-target]").textContent = node.inspect ?? node.name;
    panel.focus();
  },
});

let treeB = mountDatasetTree(document.querySelector("#tree-b"), {
  source: createSnapshotSource(catalog),
  accessExamples,
  python,
  status: { tone: "snapshot", label: "SNAPSHOT", detail: "2026-01-06 10:00 UTC" },
});

// Register every snippet this page can generate.
//
// Walking the catalog rather than waiting for a node to be rendered keeps the demonstration
// honest: a host's manifest is built from its catalog, not from what a user happened to click.
void (async () => {
  const seen = [];
  const walk = (nodes) => {
    for (const node of nodes ?? []) {
      if (typeof node.path === "string" && node.path.startsWith("s3://")) seen.push(node.path);
      walk(node.children);
    }
  };
  walk(CATALOG.roots);
  for (const uri of seen) await register(pythonFor(uri));
})();

// page chrome

const root = document.documentElement;

const themeButton = document.querySelector("#theme");
themeButton.addEventListener("click", () => {
  const dark = root.getAttribute("data-theme") === "dark";
  root.setAttribute("data-theme", dark ? "light" : "dark");
  themeButton.setAttribute("aria-pressed", String(!dark));
  themeButton.textContent = dark ? "Dark theme" : "Light theme";
});

const tokensButton = document.querySelector("#tokens");
tokensButton.addEventListener("click", () => {
  const on = root.getAttribute("data-tokens") !== "off";
  root.setAttribute("data-tokens", on ? "off" : "on");
  tokensButton.setAttribute("aria-pressed", String(!on));
  tokensButton.textContent = on ? "Host tokens off" : "Host tokens on";
});

document.querySelector("#reload-a").addEventListener("click", () => {
  void treeA.reload();
});

const destroyButton = document.querySelector("#destroy-b");
destroyButton.addEventListener("click", () => {
  if (treeB) {
    treeB.destroy();
    treeB = null;
    destroyButton.textContent = "Re-mount narrow tree";
    return;
  }
  treeB = mountDatasetTree(document.querySelector("#tree-b"), {
    source: createSnapshotSource(catalog),
    accessExamples,
    python,
    status: { tone: "snapshot", label: "SNAPSHOT", detail: "2026-01-06 10:00 UTC" },
  });
  destroyButton.textContent = "Destroy narrow tree";
});
