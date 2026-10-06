// The Lab site the browser suites run on: built by the kernel package's `prepareNotebookSite`
// from exactly what portal-builder's planner (`planLab`, `labSiteOptions`) produces for a portal
// with `notebook.assistant.climateclaw` and `notebook.dataPanel`, against the mock Freva host.
//
// The mock listens on a fixed port (FREVA_MOCK_PORT, default 47901) so the built site - and its
// cache key - stays the same between runs; the notebook origin is a placeholder rewritten at serve.
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ZARR_FIXTURES,
  testSite,
} from "../../jupyterlite-freva-kernel/browser-tests/lite-harness.mjs";
import { AUTH, startMockFreva } from "./mock-freva.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
export const REPO_PACKAGES = resolve(HERE, "..", "..");
export const MOCK_PORT = Number(process.env.FREVA_MOCK_PORT ?? 47901);
export const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
export const NOTEBOOK_PLACEHOLDER = "http://notebook.invalid";
export const SITE_TITLE = "Test Portal";
export const SCOPE_NOTE = "Answer about the test archive.";
export const EXAMPLES = [
  { title: "Global mean", prompt: "Compute the global mean of sfcWind." },
  { title: "Plot map", prompt: "Plot a map of sfcWind." },
];
export const ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle class="jp-icon3" fill="#616161" cx="8" cy="8" r="6"></circle></svg>';
export const SEED = JSON.stringify({
  cells: [
    { cell_type: "markdown", metadata: {}, source: ["# ERA5 walkthrough\n"] },
    { cell_type: "code", execution_count: null, metadata: {}, outputs: [], source: ["1 + 1"] },
  ],
  metadata: {
    kernelspec: { name: "freva-python", display_name: "Freva Python", language: "python" },
  },
  nbformat: 4,
  nbformat_minor: 5,
});
export const STORE_ID = "s3://data/sfcwind.zarr/";
export const STORE_URL = `${MOCK}/s3/data/sfcwind.zarr/`;
/** GridLook: framed by the notebook, served in the tests by a stub (never fetched). */
export const GRIDLOOK = "https://gridlook.pages.dev";

/** A search index for the live tree: one store nobody has opened yet. */
export const SEARCH_INDEX = JSON.stringify({
  schemaVersion: 1,
  complete: true,
  source: `${MOCK}/s3`,
  entries: [
    {
      id: STORE_ID,
      kind: "dataset",
      name: "sfcwind.zarr",
      title: "Near-surface wind speed",
      path: STORE_ID,
      ancestors: [{ id: "s3://data/", name: "data", title: "Test archive" }],
    },
  ],
});

/** A directory served as bucket `data`: one Zarr store. */
export function archiveDir() {
  const dir = mkdtempSync(join(tmpdir(), "freva-archive-"));
  cpSync(join(ZARR_FIXTURES, "zarr-v2"), join(dir, "sfcwind.zarr"), { recursive: true });
  return dir;
}

export async function planInputs() {
  const { planLab, labSiteOptions } = await import(
    join(REPO_PACKAGES, "portal-builder", "dist", "model", "notebook.js")
  );
  const lab = planLab(
    { profile: "xarray-zarr" },
    {
      siteTitle: SITE_TITLE,
      playgroundOrigin: NOTEBOOK_PLACEHOLDER,
      // The site is served at its origin's root here: the shipped callback page, which speaks
      // the shared callback's protocol (the portal's /auth/callback/ is the showroom's to test).
      authCallbackPath: "/freva-login-callback.html",
      assistant: {
        host: MOCK,
        authBaseUrl: `${MOCK}${AUTH}`,
        defaultModel: "gpt-test",
        runAndFixModel: "gpt-fast",
        scopeNote: SCOPE_NOTE,
        examples: EXAMPLES,
        hideCodeByDefault: false,
        fingerprint: "test",
      },
      dataPanel: {
        settings: {
          tree: "home-0",
          defaultAction: "open-in-notebook",
          seedNotebooks: ["examples/era5.ipynb"],
          gridlook: true,
          launcher: { newNotebook: true, browse: true, examples: true, ask: true },
          fingerprint: "test",
        },
        block: {
          instanceId: "home-0",
          mode: "s3",
          catalogScriptJson: "",
          s3: {
            endpoint: `${MOCK}/s3`,
            origin: MOCK,
            style: "path",
            roots: [{ name: "data", bucket: "data", title: "Test archive" }],
          },
          source: "",
          nodeCount: 0,
          rootCount: 1,
          expandedIds: [],
          statusLabel: "LIVE",
          searchIndex: {
            url: "/_portal/dataset-tree-index.0f0f0f0f.json",
            file: "_portal/dataset-tree-index.0f0f0f0f.json",
            entries: 1,
            complete: true,
          },
        },
        searchIndex: Buffer.from(SEARCH_INDEX),
        iconSvg: ICON,
        seeds: [{ name: "examples/era5.ipynb", text: SEED }],
      },
    },
  );
  return { lab, options: labSiteOptions(lab) };
}

/** Build (or reuse) the site; start the mock. */
export async function labSite() {
  const { lab, options } = await planInputs();
  const site = await testSite({
    name: "climateclaw-lab",
    lab: options,
    seeds: [{ name: "examples/era5.ipynb", text: SEED }],
  });
  const archive = archiveDir();
  const mock = await startMockFreva({ zarrRoot: archive, port: MOCK_PORT });
  return { site, mock, lab, options };
}

/** What the served site's placeholders become. */
export const replacements = (urls) => ({
  [`${NOTEBOOK_PLACEHOLDER}/notebook/`]: `${urls.notebook}/`,
});
