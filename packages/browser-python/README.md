# @freva-org/browser-python

Python in the browser, in a Web Worker, with no backend: CPython compiled to WebAssembly
(Pyodide), a typed engine API, and an optional console Web Component.

```ts
import { createBrowserPython } from "@freva-org/browser-python";

const python = createBrowserPython({ profile: "xarray-zarr" });

python.onOutput((event) => {
  if (event.type === "display" && event.mime === "image/png") showFigure(event.data);
  else if ("text" in event) print(event.text);
});

await python.start();
await python.push("import xarray as xr");
await python.push("ds = xr.open_zarr(URL, consolidated=True, chunks=None)");
```

Everything runs in the visitor's browser. Your servers serve JavaScript; the runtime comes from a
CDN or from your own origin. Nothing typed at the prompt reaches your infrastructure.

## Entry points

| Specifier                                  | Contents                                                       |
| ------------------------------------------ | -------------------------------------------------------------- |
| `@freva-org/browser-python`                | the headless engine. No DOM, no CSS, no custom element.        |
| `@freva-org/browser-python/console`        | `BrowserPythonConsole`, `defineBrowserPythonConsole()`, types. |
| `@freva-org/browser-python/console/auto`   | the above, plus `<freva-python-console>`. Browser only.        |
| `@freva-org/browser-python/console.css`    | the stylesheet, for hosts that prefer a `<link>`.              |
| `@freva-org/browser-python/embed`          | the two-origin playground bridge and host.                     |
| `@freva-org/browser-python/embed/examples` | the registered-example manifest helpers.                       |

`/console` is side-effect free and safe to import during a server render; `/console/auto` is not.

## Profiles

```ts
createBrowserPython({ profile: "minimal" }); // an interpreter, and nothing else
createBrowserPython({ profile: "xarray-zarr" }); // + xarray, zarr, fsspec, numcodecs
createBrowserPython({ profile: "freva-client" }); // + the Freva client
```

`xarray-zarr` and `freva-client` also register the read-only browser filesystem, which is what
makes `xr.open_zarr("https://…")` work. Matplotlib is in no profile: the display bridge costs
nothing at startup, and the wheel is fetched only if something imports it.

`start()` reports what actually came up, rather than what was configured:

```ts
const info = await python.start();
// { profile, pythonVersion, pyodideVersion, packages, startupMs, addons,
//   workspace: { available, maxFiles, … }, credentialsPersisted, jspi }
```

`jspi` is WebAssembly stack switching, detected in the worker (`WebAssembly.Suspending`), never
inferred from the browser's name. It is not needed to start an interpreter, to run Python or to use
`/workspace`, but reading a **remote** dataset is, because a synchronous Zarr decode calls an
asynchronous fetch underneath. Without it nothing is printed at startup or after ordinary commands;
the one call that needs it fails with a short, actionable `RuntimeError` naming the browser versions
that provide it (Safari 27, Chrome and Edge 137, Firefox 153), and the session carries on.

## The download

Nothing is fetched until `start()`.

| what                                   | on the wire                                               | when                                 |
| -------------------------------------- | --------------------------------------------------------- | ------------------------------------ |
| this package, engine only              | <!-- size:root-entry-gz --> 7.0 KiB gzipped               | with your bundle                     |
| this package, with the console         | <!-- size:console-entry-gz --> 123.9 KiB gzipped          | with your bundle, `/console` only    |
| Pyodide runtime + stdlib               | 12.8 MB (6.0 MB gzipped)                                  | first `start()`                      |
| xarray, zarr, fsspec, numcodecs, numpy | 9.6 MB, 17 wheels                                         | first `start()`, `xarray-zarr` only  |
| the derived Freva wheel + PyPI deps    | 38 KiB gzipped for the wheel, plus what micropip resolves | first `start()`, `freva-client` only |
| matplotlib                             | ~5 MB                                                     | the first `import matplotlib`        |
| dataset chunks                         | as much as you ask for                                    | when you read data                   |

The emitted headless-engine files - everything in `dist/` except the console and optional embed
bridge - are

<!-- size:engine-dist-gz --> 80.4 KiB gzipped against a budget of
<!-- size:engine-budget-gz --> 83.0 KiB. None of the runtime is in your bundle: it is a dynamic

import by URL, and `npm run check:bytes` fails the build if that stops being true, or if the
published tarball ever contains a `.wasm`, `.whl` or stdlib zip. `scripts/check-docs-sizes.mjs`
runs in the same gate and fails when the numbers above disagree with the measurement.

## Engine API

```ts
await python.push("def double(v):"); // one REPL line → { syntax, executed, … }
await python.run("import numpy as np\nnp.arange(5).mean()"); // a snippet, file semantics
await python.complete(source, cursor);
await python.interrupt(); // cooperative cancel
await python.restart(); // new worker, new interpreter, no variables
python.clearBuffer(); // discard a half-typed multi-line statement
```

`push()` returns Python's own parser verdict - `"incomplete"`, `"complete"`, `"syntax-error"` - so
a prompt can show `...` without guessing at the text. An expression's value is echoed, a
statement's is not, and `run()` does not touch the console's line buffer. Both share one namespace
and both support top-level `await`.

Anything with a newline in it is compiled as a file, because fed to the REPL a line at a time a
blank line inside a `for` suite arrives as `IndentationError`. The cost is that file mode does not
echo a trailing expression's value; `print()` it.

**`interrupt()` is cooperative.** It returns `true` when the cancellation is recorded, never when
anything has ended: Python delivers it at the next suspension point, so `await`ing code raises
`KeyboardInterrupt` and `while True: pass` does not. For synchronous code only `restart()` works -
a pre-emptive interrupt would need `SharedArrayBuffer`, and the COOP/COEP headers this package
cannot set for you.

**One engine per page.** Create it once and share it; `start()` is idempotent. One interpreter has
one input buffer, so `push(line, { owner })` refuses a second console's line rather than appending
it to somebody else's half-written function.

```ts
python.onOutput((event) => {
  event.type; // "stdout" | "stderr" | "result" | "display"
  event.executionId; // events are ordered within an execution and tagged with it
  // text events carry `text`; display events carry `mime`, `encoding`, `data`
});
```

The protocol carries only `image/png` and `text/plain`, validated at both boundaries - not
`text/html`, not `image/svg+xml`, because both carry script and the payload was authored by
whatever the visitor typed. Render with `textContent`, never `innerHTML`.

Plotting needs `plt.show()`, as outside a notebook: it marks the open figures, which are rendered
to PNG and closed after the command. `MPLBACKEND=Agg` is set before anything can import Matplotlib,
whose default Pyodide backend reaches for `window` at import time.

## Installing packages

There is no backend and no pip. The one supported way to add a package to a session is micropip,
which the `xarray-zarr` and `freva-client` profiles load before they report ready:

```python
import micropip
await micropip.install("cmocean")
```

**Whether that line works is a property of the page, not of this package.** All five of these have
to hold:

1. the package has a pure-Python wheel, or one built for Pyodide's WebAssembly target - a Linux or
   macOS native wheel is compiled for a different platform and nothing in a browser can load it;
2. the embedding page's CSP permits the index **and** the wheel origin in `connect-src` - for the
   default index, `https://pypi.org` and `https://files.pythonhosted.org`;
3. those origins answer with CORS headers the browser accepts;
4. the configured index is reachable from wherever the visitor is;
5. the package does not, once installed, depend on something a browser does not have.

A page whose policy does not name the index gets `ValueError: Can't fetch metadata for …`, raised
during metadata lookup - **before** wheel compatibility is evaluated, so the message says nothing
about whether the package would have worked.

`@freva-org/portal-builder` emits a default-deny policy naming the configured runtime, service and
data origins. On the `freva-client` profile it **also names the index**, because that profile's
wheel is installed with dependency resolution; on the other profiles it names no index at all, and
`micropip.install` of anything else fails there.

**Installing is not the same as working.** A package can install cleanly and still be unable to do
its job, because the browser is not Linux. `s3fs` is the sharp case: its dependency closure
installs and the result still cannot open an S3 store, because what is registered here is a
READ-ONLY adapter over the browser's own Fetch, with no credentials, no signing and no writes.
Cartopy was the older example - it installs, then tries to download Natural Earth shapefiles
through `urllib` - and is now covered by the `cartopy-natural-earth-110m` add-on.

**Installing does not import**, and it lasts only as long as the interpreter: a restart, a reload
or a new tab starts an empty environment. `micropip.list()` reports what this interpreter has,
including what a profile or add-on installed, whatever the host's network policy is.

There is no `%pip`, no `!pip`, no `pip install` and no `subprocess`. None of them can work in a
Worker, and a lookalike that half-works is worse than none.

## Remote Zarr

The engine registers a read-only fsspec filesystem over the browser's own `fetch`, for `http` and
`https`, so the API is the one you already know:

```py
ds = xr.open_zarr(URL, consolidated=True, chunks=None)
ds["sfcWind"].isel(time=0).mean().values
```

Four constraints, all real:

- **Public data only.** Anything in browser JavaScript is readable by whoever opens the tab.
- **CORS is required**, and cannot be worked around from inside the page. A store that fails with a
  network error while `curl` fetches it happily is a CORS answer, not a policy one.
- **Consolidated metadata is required.** Plain HTTP cannot list an object-store prefix, so `_ls()`
  refuses rather than returning an empty list that would read as an empty dataset.
- **`chunks=None`**, unless the `dask` add-on is enabled.

**The server must also expose `Content-Range`.** A browser hides response headers from JavaScript
unless the server lists them, and an unverifiable 206 is refused - a caching proxy that widens or
clamps a range returns bytes of the right length from the wrong place, which Zarr decodes into an
array that is quietly wrong.

```http
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: Content-Range
```

A server that ignores `Range` and answers `200` is refused rather than sliced locally, because that
turns a 4 KiB chunk request into the whole object in tab memory. Every accepted response is read
under a bound that never comes from the wire - an accepted range span, or `MAX_DECODED_BODY_BYTES`
(64 MiB) for a whole-object read - because Fetch hands over the _decoded_ body and
`Content-Encoding`, unlike `Content-Length`, is not CORS-safelisted. Existence is probed with
`HEAD`, falling back to `Range: bytes=0-0`; only `404` means missing, and a `403`, a `500` or a
CORS rejection raises.

### Anonymous `s3://`

**Limited compatibility with an anonymous S3-compatible gateway, not S3 support.** No signing, no
credential chain, no region resolution, no listing. A path is rewritten and handed to the HTTPS
filesystem above - `s3://<bucket>/<key>` + `endpoint_url` → `<endpoint>/<bucket>/<key>`:

```py
ds = xr.open_zarr(
    "s3://cmip6/healpix/ssp245/mean.zarr",
    consolidated=True,
    chunks=None,
    storage_options={"anon": True, "endpoint_url": "https://gateway.example.org"},
)
```

Supported: `anon=True`, an HTTPS `endpoint_url` (also inside `client_kwargs`), path-style
addressing, the `s3`/`s3a`/`s3n` schemes, consolidated Zarr, reads. Keys are preserved byte for
byte - `a/c`, `a//c`, `/a/c` and `a/c/` are four different objects.

Refused by name rather than half-attempted: any credential (`key`, `secret`, `token`, `profile`,
`anon=False`), a missing `endpoint_url`, a plaintext endpoint other than loopback, an endpoint
carrying a query, fragment, userinfo or bad port, a `.` or `..` segment in a key, `ls`/`find`/`glob`,
writes, and virtual-host-style addressing.

## Curated add-ons

Two capabilities the pinned runtime does not carry, prepared as pinned artefacts rather than
installed at a prompt:

| id                           | what it adds                                                                     | profiles                      |
| ---------------------------- | -------------------------------------------------------------------------------- | ----------------------------- |
| `dask`                       | Dask core, `dask.array`, xarray's `chunks={}`, on **one synchronous scheduler**  | `xarray-zarr`, `freva-client` |
| `cartopy-natural-earth-110m` | the Natural Earth 110m coastline and border data Cartopy downloads while drawing | all three                     |

```ts
createBrowserPython({ profile: "xarray-zarr", addons: ["dask"], addonBaseURL: "/python-addons/" });
```

```sh
npx freva-browser-python prepare-addons --out ./python-addons
```

**They are not package names.** The set is closed: each add-on is a list of artefacts with SHA-256
digests compiled into this package's bundle, an install order, and the profiles it works with.
Nothing accepts a URL or a distribution name from a caller. The `MANIFEST.json` in a prepared
directory is a record, not the check. Add-ons install after the profile's packages and before the
REPL, because xarray caches whether Dask exists at import time; a failed add-on fails `start()`
rather than reporting ready over an interpreter that lacks it.

`dask` means Dask core and `dask.array` on one synchronous scheduler: bounded laziness, not
parallelism. No `dask.distributed`, no threads, no spilling, no rewriting a remote store.

## Files Python writes

`/workspace` is the working directory, backed by the origin private filesystem rather than by the
WASM heap, so `to_netcdf`, `to_parquet`, `savefig` and `zipfile` write straight to disk; relative
paths, seeks, appends and `os.replace` all behave. Files are **detected** after every execution by
comparing the workspace with what it held before, so a file written by a C extension is noticed
like one written by `open()`.

```ts
python.onArtifacts((event) => event.added.forEach((name) => console.log("wrote", name)));
const files = await python.artifacts(); // [{ name, size, state, generation, mime, … }]

const handle = await showSaveFilePicker({ suggestedName: "surface_wind.nc" });
await python.streamArtifact("surface_wind.nc", await handle.createWritable(), {
  onProgress: ({ transferred, total, phase }) => setProgress(transferred / total),
  signal: cancelButton.signal,
});
await python.deleteArtifact("surface_wind.nc");
```

- **`streamArtifact()` is the delivery path**: one chunk at a time, transferred rather than copied.
  `readArtifact()` returns a `Blob`, is capped at 8 MiB, and above the cap refuses and names
  `streamArtifact` instead.
- **The engine owns the destination you hand it** and guarantees exactly one of `close()` or
  `abort()` on every path. Do not close it yourself. A `close()` that never returns is given
  `cleanupTimeoutMs` (5 s) and then given up on.
- **Cancellation stops at the finishing phase**, reported as `phase: "finishing"` so a UI can
  replace Cancel rather than offer one that does nothing. A close that fails is a failed transfer.
- **A transfer freezes the artifact**: writing, renaming or deleting it raises `EBUSY`, and every
  chunk re-checks a monotonic `generation`.
- **`showSaveFilePicker()` must be called synchronously in the click handler**, before any `await`,
  because it needs transient user activation and an `await` spends it.
- **OPFS is not the Downloads folder.** It is private, quota-limited browser storage; everything
  Python writes is staged there, and the streamed transfer is what gets it out.

**Two limits.** At most 64 files exist at one time (`workspaceMaxFiles`), because Emscripten's
`open()` is synchronous and acquiring a storage handle is not, so handles are reserved in advance;
exceeding it raises `EMFILE`. And the workspace is **session-scoped** - each worker holds its own
directory exclusively, and artifacts do not survive a restart or a reload. `disposeAsync()` releases
it; otherwise a later session reclaims it, but never one younger than 30 seconds.

**Every write is staging.** A file becomes downloadable only once every descriptor is closed and
nothing went short - which is how the browser reports an exhausted quota. Otherwise it is marked
`failed`, refused for download with a reason, and offered for deletion. Real quota exhaustion
raises `ENOSPC`. A local multi-file Zarr store is not supported: `to_zarr()` raises `EMFILE` rather
than half-writing thousands of chunk files. Write a `zarr.storage.ZipStore` instead, or export
NetCDF and convert outside.

Where synchronous access handles are missing the interpreter still starts and Python still writes
files - into memory. `python.workspace` reports the difference, with a sentence to show.

> **Parquet: load `pyarrow` before pandas is first imported.** pandas registers its Arrow extension
> types at its own import, and only if pyarrow is already loadable; the other order leaves
> `to_parquet` failing with `ArrowKeyError`, which names neither library nor the ordering.

## The Freva client

Two directories of static files, both produced by this package's own CLI:

```bash
npx freva-browser-python prepare-runtime --version 314.0.6 --out public/pyodide --full
npx freva-browser-python prepare-freva-wheelhouse --out public/freva-wheels
```

```ts
createBrowserPython({
  profile: "freva-client",
  pyodide: { indexURL: "/pyodide/" },
  wheelhouseURL: "/freva-wheels/", // defaults to `freva-wheels/` beside indexURL
});
```

```python
from freva_client import authenticate, databrowser

token = await authenticate(host="https://eve.dkrz.de", timeout=180)
db = databrowser(host="https://eve.dkrz.de")
print(len(db))
```

You do not install anything, call `micropip.install`, pass `deps=False`, patch HTTP transports or
pass `flavour="freva"`. If you find yourself doing any of those, it is this package's bug.
`authenticate` is awaitable here deliberately: the device flow is network work, and bridging it
behind a blocking call would freeze the only thread the page has.

**The wheelhouse holds one wheel.** `prepare-freva-wheelhouse` downloads the pinned upstream
freva-client wheel, verifies its SHA-256, and builds a derived one: `Requires-Dist: intake_esm`
moved to an extra rather than dropped, `==` specifiers for the versions this package tests against,
a PEP 440 local version, and one overlaid source file so reaching for intake raises a sentence
instead of a resolver error. A prepared directory is verified against the pinned plan in
`bin/freva-wheelhouse.json` - filenames, digests, and the derived wheel's source relationship -
not against the manifest lying beside it.

**It is installed with dependency resolution**, so micropip fetches the ordinary dependencies from
PyPI, and **every one is pinned** in the derived metadata: `appdirs`, `py-oidc-auth-client` and
`typer` are requirements upstream declares, given `==`; `shellingham` and `annotated-doc` are
transitive and are added as requirements upstream does not declare. The versions are pinned, not
the bytes. So **the page needs PyPI in its `connect-src`** - `packageIndex: true`, below.

`intake_catalogue()` raises with a sentence rather than a resolver error: the runtime ships polars
1.33.1 and intake-esm requires `>=1.24,<1.33`. A version conflict, not a missing build.

**Persisting credentials** is off by default. With `persistCredentials: true` an IndexedDB-backed
directory is mounted before anything imports Freva and the token store is flushed after each
authentication, so a reload reuses the token. `ready` reports `credentialsPersisted`, false both
when you did not ask and when the browser refused; if the origin's quota later fills, the engine
emits one `onStorage` event and flips it to false rather than silently claiming persistence. What
is persisted is a refresh token, readable by any same-origin script - including a package the
visitor installs at the prompt - so a dedicated origin is the safer shape.

**Compatibility patches live in one file**, `src/python/freva_client_compat.py`, each with the
upstream problem and the condition under which it can be deleted:

| patch                | upstream problem                                                                           | delete when                                                  |
| -------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `CONFIG_GET_DIRS`    | `get_dirs(user=True)` indexes a `posix_user` sysconfig scheme that does not exist here     | upstream falls back instead of indexing                      |
| `AUTH_CONFIG_PORTS`  | a synchronous `/auth-ports` request on every `databrowser()` construction                  | the probe becomes lazy, or is skipped for device flow        |
| `INTAKE_CATALOGUE`   | reaches the network before touching intake-esm, so the failure reads as a connection error | intake-esm's polars pin admits the runtime's polars          |
| `AUTHENTICATE_ASYNC` | `authenticate()` bottoms out in `asyncio.run`, which cannot run in Pyodide's loop          | upstream exposes an awaitable authenticate                   |
| `TOKEN_BRIDGE`       | `Config.auth_headers` and `databrowser._authenticate` are synchronous and cannot await     | those paths accept a pre-obtained token, or become awaitable |

They are version-locked to an exact set, not a floor: the module pins the `freva-client` and
`py-oidc-auth-client` versions it was read against and raises `CompatError` on anything else. Treat
an upgrade of either as a compatibility project. No HTTP transport is injected - httpx already
speaks browser networking here, and the suite asserts it still does.

Nothing here can make a server accept your origin; that is CORS, and the deployment's decision.
There is a live check for it, deliberately outside CI:

```sh
BROWSER_PYTHON_NETWORK=1 FREVA_HOST=https://eve.dkrz.de node browser-tests/freva-live.mjs
```

## Self-hosting the runtime

```ts
createBrowserPython({ pyodide: { indexURL: "https://your.site/pyodide/v314.0.6/full/" } });
```

```sh
npx freva-browser-python prepare-runtime --version 314.0.6 --full --out public/pyodide/v314.0.6/full
```

The default is a pinned version, never `latest`: a moving runtime URL means the interpreter your
deployment ships is decided by whoever last published to the CDN. The CLI downloads the official
release, checks its SHA-256 against `bin/runtime-releases.json`, unpacks it, and prints the
directory to pass as `indexURL`. Static files; nothing runs. It refuses `--version latest`, a
version with no recorded digest unless you pass `--sha256`, a digest that does not match, and -
under `--full` - an unpack missing any package named in `pyodide-lock.json`. The distribution is
taken whole; `pyodide-lock.json` is never rewritten.

A warm cache is re-verified against the shipped digests, so a stamp sitting in the directory cannot
vouch for the files beside it, and the stamp records whether the anchor is `package-pinned` or
`trust-on-first-use`. `--cache-key` prints a deterministic key for `actions/cache`. `--full` is
roughly 380 MB for 314.0.6 and is the right choice when visitors may install packages themselves.

> **Not `scripts/prepare-runtime.mjs`.** That script is for this repository's own tests and demo. It
> assembles a runtime from `node_modules`, falls back to PyPI, and **rewrites the `sha256` values in
> `pyodide-lock.json`**. Use the CLI for anything anyone else will load.

## The console

```html
<script type="module">
  import "@freva-org/browser-python/console/auto";
</script>
<link rel="stylesheet" href="@freva-org/browser-python/console.css" />

<freva-python-console autostart profile="xarray-zarr"></freva-python-console>
```

`>>> ` is a prompt, not a form: Enter runs the line, `... ` appears when the statement is
incomplete, state persists between lines, and top-level `await` works.

|                       | `@freva-org/browser-python`             | `@freva-org/browser-python/console`          |
| --------------------- | --------------------------------------- | -------------------------------------------- |
| What you get          | engine, events, `push()`                | the above plus a rendered console            |
| Bundled, gzipped      | <!-- size:root-entry-gz --> **7.0 KiB** | <!-- size:console-entry-gz --> **123.9 KiB** |
| Touches `document`    | no                                      | yes, on `connectedCallback`                  |
| Safe to import in SSR | yes                                     | `/console` yes, `/console/auto` no           |
| jQuery in the bundle  | never (asserted by a test)              | yes, as a private instance                   |

The console layer over the headless engine is <!-- size:console-layer-gz --> 116.9 KiB gzipped, of
which jQuery Terminal and jQuery are 91.7 KiB. `measure-console.mjs` enforces a ceiling rather than
a target - 124 KiB for the layer, 8 KiB for the root entry - and fails if it finds a jQuery or
worker-only add-on pin fingerprint in the root bundle.

### Attributes, properties, methods

| Attribute      | Property           | Default                                         |                                                   |
| -------------- | ------------------ | ----------------------------------------------- | ------------------------------------------------- |
| `autostart`    | `autoStart`        | `false`                                         | start the engine on connect                       |
| `profile`      | `profile`          | `"minimal"`                                     | see [Profiles](#profiles)                         |
| `theme`        | `theme`            | `"auto"`                                        | `auto` follows `prefers-color-scheme`             |
| `hide-toolbar` | `hideToolbar`      | `false`                                         | hide the built-in buttons                         |
| `hide-files`   | `hideFiles`        | `false`                                         | hide the file panel                               |
| -              | `engine`           | `undefined`                                     | inject an engine; the element will not dispose it |
| -              | `banner`           | plain-text default                              | `false` for none. Text only, never markup         |
| -              | `startupSource`    | `undefined`                                     | bootstrap run before ready, off-transcript        |
| -              | `historyOptions`   | `{ persistence: "local", maxEntries: 500, … }`  |                                                   |
| -              | `outputOptions`    | `{ maxEntries: 500, maxCharacters: 2_000_000 }` |                                                   |
| -              | `highlightOptions` | `{ enabled: true, live: true, … }`              |                                                   |

Methods: `start()`, `execute(source)`, `runExample(example)`, `transcript()`, `focus()`, `clear()`,
`clearHistory()`, `restart()`, `dispose()`.

The element creates an engine when it needs one and disposes only what it created; assign `engine`
and it subscribes without taking ownership, so two consoles share one interpreter. A disconnect
never disposes an engine - only an explicit `dispose()` does.

**`execute()` is not for startup work.** It means "behave as though this were typed", so the source
is echoed at a prompt and recorded in history. Installing wheels or warming an import is
`startupSource`, which runs after the profile is up and before ready, touches neither transcript
nor history, runs again after every `restart()`, and **rejects `start()`** with
`code: "startup-source"` if it raises.

### Keyboard

| Key                 | Does                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------- |
| `Enter`             | run the line - or open a continuation if the statement is incomplete                      |
| `Shift+Enter`       | newline inside the current statement, without running it                                  |
| `Tab`               | Python completion; at a whitespace-only prefix, indents instead                           |
| `Tab` / `Shift+Tab` | cycle the completion menu when it is open                                                 |
| `Enter` (menu open) | insert the selected completion. It does not run the line                                  |
| `Escape`            | close the completion menu, or leave history search                                        |
| `↑` / `↓`           | history, filtered by what is already typed                                                |
| `Ctrl+P` / `Ctrl+N` | the same                                                                                  |
| `→` / `Ctrl+E`      | accept the greyed-out history suggestion at end of line                                   |
| `Ctrl+R`            | reverse history search; again for the next older match                                    |
| `Ctrl+G`            | leave history search, restoring what you had typed                                        |
| `Ctrl+L`, `clear`   | clear the transcript. Python state is untouched                                           |
| `Ctrl+C`            | cancel a running execution at its next suspension point, or abandon the statement in hand |

`Ctrl+C` on a synchronous loop never reaches a suspension point, and a second and a half later the
console says so and points at **Stop and restart**. `clear` is shadowed only in the exact case
Python would have answered with a `NameError` - the line must be `clear` or `clear()` with an empty
buffer, so `clear = 5`, `clear(x)` and `del clear` are ordinary Python.

### History, highlighting, theming

History stays in the browser it was typed in and is never synchronised. **The default is
`persistence: "local"`, which outlives the tab** - on a shared or kiosk machine choose `"session"`,
`"memory"` or `"none"` deliberately, because a token pasted at the prompt is a history entry like
any other. A multi-line block is one entry.

Python is highlighted with Prism's Python grammar; output is not, because colouring what Python
said as if it were source would be a guess. The source is never placed into `innerHTML`, and if the
tokeniser and the rendered characters disagree by one character the line is left plain.

Theming is the `--bp-console-*` custom properties, the `--bp-syntax-*` token colours, and
`::part()` (`container`, `toolbar`, `status`, `transcript`, `completion-menu`, `history-search`,
`jump`, the three buttons). A host that gives the element a definite height, or sets the min/max
properties to `0` and `none`, owns the height outright; one with its own chrome can set
`toolbar="none"` and listen for `browser-python-status` rather than scraping the shadow root.

### Display limits

A figure is base64 text and five copies of it are alive on the way through, so:

| Limit                         | Value   | What it bounds                                            |
| ----------------------------- | ------- | --------------------------------------------------------- |
| `MAX_DISPLAY_ENCODED_CHARS`   | 24 MiB  | one image payload, as encoded characters (≈18 MiB of PNG) |
| `MAX_DISPLAY_TEXT_CHARS`      | 256 KiB | one `text/plain` display                                  |
| `MAX_EXECUTION_DISPLAY_CHARS` | 64 MiB  | every display one execution produces, together            |
| `MAX_EXECUTION_TEXT_CHARS`    | 2 MiB   | everything one execution prints                           |

Exceeding one costs a line on stderr naming the limit; the payload is dropped and the interpreter
keeps running. Text is kept from the beginning, because that is where the traceback is. For a
bigger figure, write it to `/workspace` and download it.

jQuery Terminal's shell-shaped defaults are all off in `adapters/surface-options.ts`, held against
the pinned library's own defaults by a test: `processArguments` (which turns `{"Test": 'test'}`
into something Python never sees), `exit`, `clear`, `convertLinks`, `anyLinks`, `invokeMethods`,
`execHash`, `historyState`, `checkArity`. The library is a private instance - `window.$` stays
`undefined` - behind `ConsoleSurfaceAdapter`, the seam to implement for a smaller surface.

## Registered examples

A "Try in Python" button that sends source to the interpreter makes anything that can reach the
interpreter able to run anything in it. So **the source never travels**: a build registers its
snippets, a request names one, and the interpreter runs something it already had.

```ts
import {
  createExampleRegistry,
  parseExampleManifest,
  verifyExampleManifest,
} from "@freva-org/browser-python/embed/examples";

const examples = parseExampleManifest(await (await fetch("/examples.json")).json());
await verifyExampleManifest(examples); // every sha256 really is the hash of its own source
createExampleRegistry(examples).resolve("open-store", digest);
// { ok: true, example } | { ok: false, reason: "unknown" | "digest" | "malformed", message }
```

An entry is `{ id, datasetId?, title, source, sha256 }`, and resolution needs both an id this build
registered and the digest it was registered under. The digest is not a signature - it is an
integrity check between two halves of one deployment, so a stale portal asking a fresh playground
for `open-store` gets a refusal rather than a different program under a name it knew.
`consoleElement.runExample(...)` is always file semantics whatever the length, and resets nothing.

## Security

Python here cannot reach your database, your filesystem or your internal network, and nothing typed
at the prompt is transmitted anywhere. What it does have is everything the Worker's own origin has.
**Python in the browser is not a sandbox around the browser.**

- Never put credentials in browser code. Only public, CORS-enabled endpoints are supported.
- Treat stdout, stderr, results and tracebacks as text. Render with `textContent`.
- A filename is a hint, not a fact: every name in the workspace was chosen by whatever the visitor
  typed. Previews are an allowlist, `text/html` and `image/svg+xml` are download-only, and
  downloaded blobs carry `application/octet-stream` whatever the name says.

### Give the playground its own origin

**Mandatory for untrusted visitors.** A Worker removes DOM access; it does not remove origin
authority. Visitor Python, and any package a visitor installs, runs with the full authority of the
interpreter's origin: OPFS, IndexedDB, Cache Storage, and cookies where CORS allows. A separate
registrable domain buys cookie isolation that a subdomain does not.

|             | origin                        | carries                                          |
| ----------- | ----------------------------- | ------------------------------------------------ |
| portal page | `https://portal.example`      | the shell, the Download control, the file picker |
| playground  | `https://play.portal.example` | the document, the Worker, OPFS, IDBFS, the token |

```ts
// the playground's response - the exact portal origin, not 'self'
contentSecurityPolicy({ frameAncestors: ["https://portal.example"] });
// the portal's response - the exact playground origin
contentSecurityPolicy({ frameSrc: ["https://play.portal.example"] });
```

```html
<iframe src="https://play.portal.example/" sandbox="allow-scripts allow-same-origin"></iframe>
```

`allow-same-origin` is what lets the playground keep its own origin storage; it does not weaken the
boundary, because the frame is cross-origin to begin with. Nothing else is granted.

**A cross-origin sub-frame cannot open a file picker**, so the portal owns the picker and pulls
the bytes out:

```ts
// in the playground
attachPlaygroundBridge({ engine, hostOrigin: "https://portal.example" });

// in the portal
const host = createPlaygroundHost({
  frame: document.querySelector("iframe"),
  playgroundOrigin: "https://play.portal.example",
  onArtifacts: (artifacts) => renderDownloadButtons(artifacts),
});
button.onclick = () => host.download(name, saveFilePickerSink);
```

The playground reports artifact **metadata** only - never bytes, never a token - and the only
execution message carries a registered **name**, `host.runExample(id, digest, targetSession?)`,
which a bridge with no manifest refuses. The portal opens the picker synchronously on its own
activation; the playground then streams one transferred `ArrayBuffer` per message, with the
portal's ack as backpressure. Both directions check the peer origin, the `event.source` window, the
channel marker, the protocol version and a per-frame session id. `host.download()` takes an
`AbortSignal` that reaches a picker still open, a transfer in flight and a chunk already posted,
and stops at the same finishing boundary the engine draws; `host.stop()` awaits every registered
transfer, bounded by `cleanupMs`, but cannot close a native dialog. If a portal cannot adopt this,
open the playground as a top-level page on its own origin, where it calls the picker itself.

Origin separation protects the portal's credentials, storage and authority from visitor code. It
does **not** sandbox a Freva token from code deliberately run beside it: a token obtained by
`authenticate()` lives in the interpreter, and anything in that interpreter can read it. What
bounds the damage is the token - narrow scope, short lifetime, an audience of the Freva API alone,
and a revocation path. Nor is it a defence against availability: a flood of well-formed bridge
messages is work the portal page does.

### Content-Security-Policy

```ts
import { contentSecurityPolicy } from "@freva-org/browser-python";

response.setHeader("Content-Security-Policy", contentSecurityPolicy({ console: true }));
```

which produces, for the engine alone:

```
default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self';
connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:;
style-src 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'
```

> **The two defaults do not compose, on purpose.** `contentSecurityPolicy()` is `script-src 'self'`
> and `connect-src 'self'`; `createBrowserPython()` loads the runtime from jsDelivr. Together the
> policy blocks the engine. Pass `runtimeOrigin`, or self-host the runtime - which is the
> production answer, since the runtime is a dynamic `import()` by URL and subresource integrity
> does not apply to it.

| option                      | adds                                                                     |
| --------------------------- | ------------------------------------------------------------------------ |
| `runtimeOrigin`             | your runtime CDN, to `script-src` and `connect-src`                      |
| `dataOrigins`               | data origins, to `connect-src` only                                      |
| `packageIndex: true`        | `https://pypi.org` and `https://files.pythonhosted.org` to `connect-src` |
| `network: "https"`          | the `https:` **scheme** to `connect-src` - deliberately not `*`          |
| `console: true`             | `style-src-attr 'unsafe-inline'`, and only that                          |
| `frameAncestors`/`frameSrc` | the exact origins you name; the default is `frame-ancestors 'none'`      |

`'wasm-unsafe-eval'` permits compiling WebAssembly and nothing else; `'unsafe-eval'` is not needed
and must not be added. Every origin you pass is parsed with `URL` and only its `.origin` is
serialised, so `"https://data.example; script-src *"` is refused loudly rather than granted. There
is no `default-src *`. `packageIndex` is what the `freva-client` profile needs, and is off by
default and separate from `dataOrigins`, so a deployment that never installs a package emits a
policy naming no index at all.

**The worker needs its own header.** A dedicated Worker's policy comes from the worker script's own
response, not from the page that created it - and every fetch the visitor's Python makes happens
inside that Worker:

```ts
// the page
response.setHeader("Content-Security-Policy", contentSecurityPolicy({ console: true }));
// the worker script's response - where connect-src actually bites
response.setHeader("Content-Security-Policy", contentSecurityPolicy({ dataOrigins: [store] }));
```

`browser-tests/csp.mjs` serves both under real headers, asserts the header is in force, and fails
on any `securitypolicyviolation`; `browser-tests/csp-package-index.mjs` does the same for the index
grant, in both directions.

**CSP cannot fix CORS**, and it is not a boundary inside the interpreter. A cross-origin fetch a
server refuses stays refused, and anything the interpreter holds is readable by any code running
in it.

## Browser support, and what does not work

Chromium is the CI gate. Firefox and WebKit run the same real-interpreter suites through
`npm run test:browser:firefox-full` and `npm run test:browser:webkit-full`: each suite asks the
worker what the engine has, exercises the feature where it exists.
Requirements: WebAssembly, module Workers, and - for remote Zarr - JSPI. An environment that cannot run the
engine reports `BrowserPythonError` with a `reason` (`no-worker`, `no-webassembly`,
`runtime-unreachable`); a missing workspace reports `workspace.available: false` with a reason
(`no-opfs`, `no-sync-access-handles`, `open-failed`) instead of failing to start. Large streamed
downloads are Chromium-tested only.

Consequences of running CPython in a browser sandbox, not defects:

- **`subprocess`** - there are no processes.
- **`%pip`** - IPython magic; this is a plain Python REPL.
- **Native wheels** - a CPython extension built for Linux cannot load.
- **Multiprocessing and threads** - Emscripten has none. (fsspec's synchronous mode starts an IO
  thread, which is why the adapter forces asynchronous mode.) Dask core works on one synchronous
  scheduler with the add-on; nothing that would make it parallel does.
- **Memory** - one tab, typically a couple of gigabytes. Subset before you materialise.
- **Files** - `/workspace` is on disk but session-scoped, bounded in file count, and cannot hold a
  local multi-file Zarr store.

## Development

```bash
npm run build                          # generates the Python string modules, then tsc
npm test                               # unit tests (no browser, no interpreter)
node scripts/prepare-runtime.mjs       # assemble .runtime/ (needs the Pyodide CDN once)
npm run test:browser                   # real Chromium, real interpreter
npm run test:browser:firefox-full      # every suite in Firefox, capability-aware, strict
npm run test:browser:webkit-full       # every suite in WebKit, capability-aware, strict
npm run test:packaging                 # pack, install elsewhere, import from there
npm run check:bytes                    # the size gate
node scripts/measure-console.mjs       # console weight, and no jQuery in the root bundle
node scripts/console-screenshots.mjs   # every console state, as PNGs, for review by eye
node scripts/serve-demo.mjs            # http://127.0.0.1:8123/
```

Every `test:browser*` script builds the package first, and each suite refuses a `dist/` whose
recorded source digest (`.build-stamp.json`, written by `npm run build`) no longer matches the
checked-out sources - by content, not by modification time.

The Python helpers in `src/python/*.py` are the source of truth and are embedded into
`src/worker/python-sources.generated.ts` at build time; `npm run typecheck` fails if they have
drifted. Never hand-edit the generated file.
