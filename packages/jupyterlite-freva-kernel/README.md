# @freva-org/jupyterlite-freva-kernel

The **Freva Python** kernel for [JupyterLite](https://jupyterlite.readthedocs.io/): a prebuilt
federated extension whose kernels run notebook cells in
[`@freva-org/browser-python`](../browser-python) - Pyodide 314.0.6 in a Worker - with sanitised rich
output. No xeus, no stock JupyterLite kernels, no server.

Published on npm (with a `prepare-notebook` tool) and on PyPI as `jupyterlite-freva-kernel`, which
installs the same prebuilt extension where Jupyter looks for one.

## What a cell is

Plain CPython: the last expression is the cell's result, `display()` and `clear_output()` work,
Matplotlib figures appear when the cell ends, and top-level `await` works. Output is HTML, SVG, PNG
or text, sanitised before it reaches the page (scripts, handlers, forms, frames, `<style>` and
external loads are removed; SVG is shown as an image). One kernel owns one interpreter.

| Request                                   | Reply                                                                  |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| `kernel_info`                             | the interpreter's real Python and Pyodide versions; no debugger        |
| `execute`                                 | in order, each output under its own request's header                   |
| `complete`                                | Python's completions, offsets converted between code points and UTF-16 |
| `is_complete`                             | complete, or incomplete with an indent (open block, bracket or string) |
| `inspect`, `history`                      | the documented "not supported" answers (`found: false`, `[]`)          |
| `comm_open`                               | `comm_close`: there are no comm targets, so no ipywidgets              |
| magics, `!shell`, `input()`, the debugger | not supported; a cell that uses them fails with Python's own error     |

**Interrupt** cancels queued cells and asks Python to stop. Code that waits (`await`, a request, a
sleep) stops with `KeyboardInterrupt`. A loop that never yields cannot be interrupted without
`SharedArrayBuffer`, which this does not require; after a grace period (`interruptGraceMs`, 3 s by
default) the notebook offers to restart Python, and says that Python state was lost. **Restart** and
**Shut down** dispose the worker.

## Settings

The extension reads `litePluginSettings["@freva-org/jupyterlite-freva-kernel:kernel"]` from the
site's `jupyter-lite.json`:

```json
{
  "runtimeIndexUrl": "https://python.example.org/pyodide/",
  "addonBaseUrl": "https://python.example.org/python-addons/",
  "maxLiveInterpreters": 2,
  "interruptGraceMs": 3000,
  "starter": "import xarray as xr",
  "setups": [
    {
      "id": "default",
      "label": "xarray-zarr + dask",
      "profile": "xarray-zarr",
      "addons": ["dask"],
      "runStarter": true
    },
    { "id": "minimal", "label": "minimal", "profile": "minimal", "addons": [], "runStarter": false }
  ]
}
```

One kernel per setup: `freva-python` for the first, `freva-python-<id>` for the others. A kernel
starts Python when its first cell runs, so an open notebook holds no interpreter.
`maxLiveInterpreters` (at most 2) caps running interpreters: when another notebook needs one, the
least recently used idle kernel stops its interpreter and its next cell says so. Its files in
`/workspace` are kept first (in memory, up to 1024 files and 256 MiB) and put back before anything
runs in the fresh interpreter; they are let go only once a fresh interpreter has them and its
starter ran, so a failed wake keeps them for the next. A kernel starting, restarting or running the
starter is not idle. Only notebooks running code, or whose files cannot be kept (one open in
Python, too many), make a cell wait. An interpreter whose start, restore or starter fails ends at
once (disposed, then its slot given back) and the next cell starts a fresh one. Unknown profiles,
add-ons and non-HTTP(S) URLs are dropped. `@freva-org/portal-builder prepare-notebook` writes these
settings from `portal.yaml`.

## Building a notebook site

```bash
freva-prepare-notebook --out site --settings settings.json [--seed examples/intro.ipynb=intro.ipynb] [--python python3]
freva-prepare-notebook verify site
```

`prepareNotebookSite()` (also `@freva-org/jupyterlite-freva-kernel/prepare`) installs JupyterLite
0.8.5 and its pinned, hash-checked dependencies into an isolated cache, builds the **Notebook**
interface only with this extension and nothing else - no service worker, no CDN, no stock kernels,
no `lab`/`repl` apps - moves every inline script into a file, and writes `NOTEBOOK-INVENTORY.json`
with every file's SHA-256. Seed notebooks are validated (nbformat 4) and never executed.
`verifyNotebookSite()` re-checks a site against its inventory and the same audit. The inventory
also records `preparedBy` (`PREPARE_DIGEST`, the digest of the preparation script), so a site made
by another revision is prepared again instead of reused.

`appName` names the app (the tab's title). `favicon` (`{ path: "favicon.svg" | "favicon.png" |
"favicon.ico", bytes, type }`) is the site's own tab icon: written at the site root, linked from
every page in place of JupyterLite's and named as every `jupyter-lite.json`'s `faviconUrl` (the
icon JupyterLite's boot script adds), and the Notebook interface's kernel-status icon swap
(`@jupyter-notebook/notebook-extension:tab-icon`) is disabled so it stays. Both are recorded in the
inventory, and `verifyNotebookSite()` checks the `faviconUrl`s (`faviconProblems`).

The `lab` option adds a trimmed **JupyterLab** interface beside it, for further prebuilt extensions
(`@freva-org/jupyterlite-climateclaw`, `@freva-org/jupyterlite-freva-data`):

| `lab.`               | Meaning                                                                                                                                                                                             |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extensions`         | Prebuilt extension directories (`labextension/` with its `package.json`) to federate.                                                                                                               |
| `requirements`       | A pip requirements file of wheels with `--hash` pins (e.g. jupyterlite-ai's), downloaded `--require-hashes --no-deps --only-binary=:all:` into the cache; JupyterLite reads each wheel's extension. |
| `overrides`          | Settings overrides, written to `overrides.json`.                                                                                                                                                    |
| `disabledExtensions` | Plugin ids to disable, added to the site's own; each must exist in the built bundle.                                                                                                                |
| `files`              | `{ path, text }` files added to the site (a login callback page, a panel's data).                                                                                                                   |

The inventory then records the apps, the federated extensions and the wheels they came from, the
overrides' digest and the added files, and the audit requires exactly those: a missing or
unexpected app or federated extension fails it, as does an asked-for id that is not disabled or
that the bundle does not have.

## Content-Security-Policy

`notebookCsp()` (`@freva-org/jupyterlite-freva-kernel/csp`) writes the policy the site is tested
under:

- `script-src 'self' 'wasm-unsafe-eval'` plus the runtime's origin. No `'unsafe-eval'`: JupyterLab's
  Ajv-based settings validation is replaced by an interpreting validator. No `'unsafe-inline'`.
- `style-src 'self' 'unsafe-inline'`, because JupyterLab and CodeMirror inject their stylesheets at
  run time. Python-authored markup never keeps a style.
- `img-src 'self' data: blob: attachment:`, `connect-src` the runtime and the data origins,
  `frame-ancestors 'none'`.
- No `frame-src` unless `frameSources` names origins (a site that opted into a viewer such as
  GridLook); then exactly those origins, never a scheme.

Serve the notebook on its own origin - never the origin of a page that holds credentials.

## Files

Notebooks live in the browser's storage (JupyterLite contents). `.ipynb` uploads are checked
(nbformat 4.x, at most 32 MiB) before they are saved and are never run on import; downloads are
nbformat 4.5. Nothing syncs them into the kernel's `/workspace`: **File → Save a Copy to Python's
/workspace** copies the open notebook there, starting Python if needed.

## Development

```bash
npm run build && npm run build:labextension
npm test
node browser-tests/notebook.mjs           # Chromium; BROWSER_ENGINE=firefox|webkit for the others
node browser-tests/notebook-integrity.mjs # no JSPI, tampered runtime, tampered add-on
```
