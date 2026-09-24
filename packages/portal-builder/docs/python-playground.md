# Runnable code, and the Python playground

A portal can let a reader press **Try in Python** beside a snippet and watch it run, in their own
browser, with no server. This is what enables that, what it costs, and what it deliberately will
not do.

Two things can ask for a playground: a `dataset-tree` block's own `python` stanza, which came first
and is unchanged, and the portal-level `pythonPlayground` stanza described here, which is what gives
a marked code block a meaning. **A page has one playground.** If a page carries both, they must agree
about the interpreter, and a build that finds them disagreeing says which line differs.

## Marking a snippet

Execution is metadata on a Python block, not a language. The fence still says `python`, so the
highlighter, the language label and a reader all see what they saw before.

Markdown:

````markdown
```python try-in-python title="quickstart.py"
import xarray as xr
print(xr.__version__)
```
````

reStructuredText:

```rst
.. code-block:: python
   :try-in-python:

   import xarray as xr
   print(xr.__version__)
```

`title="…"` and `try-in-python` may appear in either order. The marker works in first-party
documentation under `rendering.sources` and in the Markdown or RST fragments a landing page's
`prose` block points at. It does not work in header or footer prose — that appears on every page,
including the error documents, and a run control there would put an interpreter on all of them; the
build refuses it by name.

The build refuses, with the file and line:

| what                                        | code                |
| ------------------------------------------- | ------------------- |
| the marker on a language that is not Python | `PC1022`            |
| the marker twice on one fence               | `PC1022`            |
| the marker on an empty block                | `PC1022`            |
| anything else on the fence                  | `PC1021`, as before |

**A marked block in a portal with no `pythonPlayground` is ordinary copyable code.** No control, no
identity, no digest, and nothing of the interpreter in the artifact. That is the same page it was
before the marker was added, byte for byte.

There are no per-snippet profiles and no per-snippet packages. What a page's interpreter contains is
the deployment's decision, in one place.

## Enabling it

```yaml
pythonPlayground:
  enabled: true
  profile: freva-client

  addons:
    - dask
    - cartopy-natural-earth-110m

  autostart: never
  maxSessions: 1

  initialSource: |
    print("Python is ready")

  playgroundOrigin: https://python.example.org
  runtimeIndexUrl: https://mirror.example.org/pyodide/v314.0.6/full/
  wheelhouseUrl: https://mirror.example.org/python-wheels/
  addonBaseUrl: https://mirror.example.org/python-addons/

  connectOrigins:
    - https://freva.example.org
    - https://auth.example.org

  persistCredentials: false

  terminal:
    style: freva-client-terminal
    osControls: auto
    alwaysOnTop: true
    rememberAppearance: true
```

Everything except `enabled` is optional. Enabling this **does not** turn Python on for an existing
dataset tree — that is still the tree's own stanza — and it does not by itself put an interpreter on
any page. A portal that enables it and marks nothing emits no interpreter, no Worker and no widened
policy, and the build says so once (`FP1222`).

### Profiles are singular

```text
minimal
└── xarray-zarr
    └── freva-client
```

A chain, so a list would only ever be a longer way of naming the last one — and a composed
environment would be one nobody had tested as a whole. `freva-client` **already includes** xarray,
Zarr, fsspec and numcodecs; there is no "xarray plus Freva" to ask for. One session can do all of:

```python
from freva_client import authenticate, databrowser
import xarray as xr
import zarr
import fsspec
```

Authentication is awaitable in the browser:

```python
token = await authenticate(host="https://freva.example.org", timeout=180)
```

`intake_catalogue()` is **not** supported: its dependency closure conflicts with the pinned runtime,
and that is unresolved.

### Add-ons are not profiles

A profile is which interpreter you get. An add-on is an extra capability prepared for it, from a
**closed** list — not package names. Nothing accepts a URL, a distribution name or an install script
from a content author, and no add-on is inferred from what a snippet imports.

| id                           | what it adds                                                                        | profiles                      |
| ---------------------------- | ----------------------------------------------------------------------------------- | ----------------------------- |
| `dask`                       | Dask core, `dask.array`, and xarray's `chunks={}` path on one synchronous scheduler | `xarray-zarr`, `freva-client` |
| `cartopy-natural-earth-110m` | Natural Earth 110m coastlines and country borders, offline                          | all three                     |

An unknown add-on, a duplicated one, or one the chosen profile cannot carry is a build error
(`FP1219`) naming both — not a `ModuleNotFoundError` in a visitor's face.

Add-ons are prepared in the **registry's** order, not the portal's, so two configurations naming the
same set get the same interpreter and a restart reproduces it. That order is worth knowing when you
choose what to configure: `cartopy-natural-earth-110m` is prepared before `dask`, so an add-on you
do not need can stop one you do.

### Optional add-ons

`addons` is **required**: if one cannot be prepared, the interpreter does not start. That is the
right default — a page offering a Try button over an interpreter that cannot do what the page
promises is worse than a page that says why it will not start.

`optionalAddons` names the subset whose absence is tolerable:

```yaml
pythonPlayground:
  profile: freva-client
  addons:
    - dask
    - cartopy-natural-earth-110m
  optionalAddons:
    - cartopy-natural-earth-110m
```

The artefacts are still fetched, still digest-checked, and still refused if they are wrong. What
changes is only what a **failure** means: the interpreter starts without that capability, the ready
information reports it as unavailable with a reason and a remedy, and one warning is written — not a
traceback, and not once per restart.

**Not every add-on may be listed here, and the restriction is a proof rather than a policy.**
Preparation is: fetch every artefact, verify every digest, write the files, activate. An add-on
qualifies only when nothing before the write can leave the interpreter changed — true of one that
ships data and no wheels, false of one that installs any. `dask` installs three wheels through
micropip, and a failure on the second leaves a session holding its dependency closure and not Dask;
nothing can undo that in a live interpreter. So:

| id                           | may be optional | why                                               |
| ---------------------------- | --------------- | ------------------------------------------------- |
| `cartopy-natural-earth-110m` | yes             | data only; activation is one environment variable |
| `dask`                       | no              | installs wheels, which mutates the interpreter    |

Listing `dask` in `optionalAddons` is a build error with that reason, not a silent promotion back to
required. An id in `optionalAddons` that is not also in `addons`, or a duplicate, is an error too.

**What "unavailable" means for the Cartopy add-on.** It is a DATA capability, not the Cartopy
package. `import cartopy` still works; what is missing is the offline coastline and border files, so
`ax.coastlines()` would try to download them and fail. The report says exactly that.

## Hosting the artefacts

The playground needs static files a deployment serves itself: the Freva client's wheel, for the
`freva-client` profile, and every configured add-on's pinned artefacts. They are digest-checked by
the interpreter at start, so they cannot come from a CDN that does not have them.

**The supported way is to let the portal serve them.** One command, with the network, reads this
portal's own configuration and prepares exactly what it needs:

```sh
freva-portal-builder prepare-playground \
  --source-root . --config portal/portal.yaml --out .python-materials

freva-portal-builder build \
  --source-root . --config portal/portal.yaml --out build/portal \
  --python-materials .python-materials
```

The build copies them into the artifact **before** its manifests and checksums are computed, so they
are covered by `verify` like every other file. That ordering is the whole point: adding them
afterwards is what makes an artifact unverifiable, and the artifact's own checker will say so —

```
error FP1603 freva-wheels/…whl: … is in the artifact but not in checksums.sha256.
```

With the materials incorporated, the page points at `/freva-wheels/` and `/python-addons/` —
root-relative, so one artifact is correct in a local preview, on a staging host and in production
with nothing rewritten per environment, and `portal.yaml` names no host at all.

### The cache

`--out` is a cache and belongs **outside** the artifact directory. `prepare-playground` verifies it
by hashing its bytes against the pins, not by looking for a manifest, so a stale or partly-written
directory is prepared again rather than served. It publishes atomically: the destination is replaced
only once every asset group has succeeded, and every group is attempted so two missing directories
are reported together rather than one per rebuild.

The cache key covers the pin catalogue, the profile and the add-on set. It deliberately does **not**
cover the base URLs or whether the runtime is self-hosted — neither changes a byte of what is
prepared, and folding them in threw good caches away when a preview moved port.

`validate` and `build` never open a socket. `prepare-playground` is the only command that does.

### Hosting them somewhere else

A deployment that intentionally serves these files from another origin sets `wheelhouseUrl` and
`addonBaseUrl` explicitly, and those win over everything else. The underlying commands are:

```sh
# The Python runtime, if you do not want the pinned CDN
npx freva-browser-python prepare-runtime --version 314.0.6 --out ./pyodide --full

# The Freva client's wheel, for the freva-client profile       → wheelhouseUrl
npx freva-browser-python prepare-freva-wheelhouse --out ./python-wheels

# The curated add-ons' wheels and data                          → addonBaseUrl
npx freva-browser-python prepare-addons --out ./python-addons
```

Each downloads from recorded URLs, verifies a recorded SHA-256, writes atomically and leaves a
`MANIFEST.json`. That manifest is a record for you, not the check: the digests a running interpreter
enforces are compiled into `@freva-org/browser-python` itself, so a stale or substituted file fails
the start with both digests in the message rather than being used.

**Serve them with CORS if they are on another origin** (`Access-Control-Allow-Origin`), and add that
origin to nothing — the build puts it in the policy for you.

### "Beside the runtime" is not always a place

Both URLs default to a sibling of the runtime — `../freva-wheels/` and `../python-addons/`. That is
right for a deployment that mirrors Pyodide onto its own origin and copies the three directories
together. Against the **pinned public CDN** it resolves to

```
https://cdn.jsdelivr.net/pyodide/v314.0.6/freva-wheels/
https://cdn.jsdelivr.net/pyodide/v314.0.6/python-addons/
```

which are directories that do not exist, on a host this project does not control. A build in that
position is refused (`FP1223`) rather than left for a visitor to discover as a 403:

```
error FP1223 portal.yaml#/pythonPlayground: The Python playground uses the freva-client profile,
which installs the Freva client's wheel at startup, and this build has no way to serve it.
```

The diagnostic names the key, the preparation command, and all three ways out. A self-hosted runtime
keeps the convenience unchanged.

## Packages: a curated environment, and what the help says about it

There are two modes, chosen with `pythonPlayground.network`, and this section describes the
**restricted** one — `network: "origins"`, the default. For the open one, see
[Open mode](#open-mode-network-https) below; everything here still applies to it as the _starting_
environment, and what changes is that it stops being the ceiling.

A restricted playground does **not** offer installation of arbitrary packages by name from a public
index, and it does not pretend to. Three things supply packages, and there is no fourth:

| Where a package comes from | When it arrives                                                  | Who chose it                 |
| -------------------------- | ---------------------------------------------------------------- | ---------------------------- |
| The pinned Pyodide runtime | On first `import`, from `runtimeIndexUrl`                        | The pinned release           |
| The Freva client's wheel   | At startup, for the `freva-client` profile, from `wheelhouseUrl` | The pinned wheelhouse        |
| A curated add-on           | At startup, when you enabled it, from `addonBaseUrl`             | You, from a closed catalogue |

Every one of those is fetched from an explicit URL that the build resolved, and every wheel is
checked against a SHA-256 compiled into `@freva-org/browser-python`. A missing or altered artefact
fails the start — before the terminal reports ready — with both digests in the message.

**The `freva-client` profile is the exception, and it is a deliberate one.** Its wheel is installed
with dependency resolution enabled, so micropip fetches freva-client's ordinary dependencies from
PyPI while the page starts. `resolvePackagePolicy` therefore adds `https://pypi.org` and
`https://files.pythonhosted.org` to that portal's `connect-src`, and `packagePolicy.packageIndex`
records that it did. **A portal on this profile is no longer fully curated:** the index is
reachable from the page, so a visitor can install other packages from it too. The help panel says
so in those words rather than claiming a restriction the header does not impose. Every other
profile still has no fall-through to an index — a name that is not in one of the three places above
is not installed.

**A content author cannot change any of this.** Manifests, URLs and digests come from the portal
configuration and the pinned catalogue. A snippet marked `try-in-python` contributes an id and a
digest of its own bytes and nothing else; there is nowhere in the authoring surface to put a package
name, an index, a wheel URL or an install command, and no `data-*` attribute the page reads carries
one.

**micropip is still there, and still useful.** It is the mechanism the curated installs themselves
run on, and `micropip.list()` is how a visitor sees what a session actually holds. Whether
`await micropip.install("name")` is offered follows the resolved policy and nothing else. On a
profile whose policy names no index the call fails in metadata lookup with
`ValueError: Can't fetch metadata for …` — before wheel compatibility is even considered, so the
failure says nothing useful about the package — and the help panel does not offer it. On
`freva-client`, where the index is in `connect-src` because the profile resolves against it, the
call works and the panel says so.

### The help panel and the policy are one decision

`src/model/package-policy.ts` resolves the package origins once, from the resolved playground. That
one value:

- is unioned into the parent page's `connect-src`;
- is unioned into the separate-origin child's `connect-src`;
- is carried into the page configuration as `packagePolicy`, and the terminal's **Python packages**
  panel is rendered from it.

So the published policy and the sentence describing it cannot drift: adding an origin changes both,
and there is no second place to edit. The panel also reports what the interpreter actually said when
it started — the profile, the add-ons and their installed versions, the loaded package versions, and
whether `/workspace` is disk-backed in this browser or only in memory — rather than repeating the
configuration back as if it were an observation.

`pypi.org`, `files.pythonhosted.org` and `test.pypi.org` are refused outright: they are listed in
`REFUSED_PACKAGE_ORIGINS` and asserted against in the test suite, for the parent policy and the child
policy alike.

<h3 id="open-mode-network-https">Open mode (<code>network: "https"</code>)</h3>

The mode the section above said would be a separate feature. It is that feature, and it arrived as
`pythonPlayground.network: "https"` — a named second value of `PackagePolicy.kind`, not a boolean
bolted onto the old one.

```yaml
pythonPlayground:
  profile: freva-client
  network: https # any TLS origin in connect-src; never plaintext
```

**What it changes.** One thing, in one directive: `https:` — the _scheme_ — is added to
`connect-src`. Any TLS origin may be fetched; plaintext HTTP may not; and no other directive moves.
`script-src` still names only this origin, the inline hashes and the runtime, so nothing new may be
executed _as a page script_. It is deliberately not `*`, which would also carry `ws:`, `data:` and
plaintext and would make the header indistinguishable from having none.

That one change is what makes the ordinary things work:

- `await micropip.install("name")` — metadata from the public index, wheel from its host;
- `await micropip.install("https://…/thing-1.0-py3-none-any.whl")` — a wheel URL a visitor names;
- a CORS-enabled dataset that nobody listed at deployment time;
- Cartopy fetching the Natural Earth resolution a regional map happens to need.

**What it does not change.** Everything in the table above is still exactly true: the runtime is
still pinned, the derived Freva wheel and the prepared add-ons are still digest-checked against hashes
compiled into `@freva-org/browser-python`, and a mismatched prepared artefact still fails the start.
Open mode widens what a **visitor** may fetch for themselves. It does not lower the bar on what
**we** distribute, and it is not an operator approval step for anything a visitor installs.

**The scope of the widening, stated precisely.** A dedicated Worker loaded from a URL is governed
by the Content-Security-Policy delivered on **its own script response** — it does not simply inherit
the document's. (`worker-src` is a different question: it governs where a Worker may be _loaded_
from, not where it may connect.) So a narrower Worker policy is a **hosting** decision rather than
something CSP makes impossible. What this artifact records is ONE policy per artifact —
`host-policy.json` carries a single `csp.portal` block — and every deployment recipe and the preview
server send it on every response, the Worker script included. Hence:

- with `playgroundOrigin` set, the interpreter's Worker is served from the **child artifact**, which
  records and carries its own policy, and the scheme goes there; the portal page's own `connect-src`
  is untouched. That is the narrow boundary, and it exists today;
- without it — the same-origin arrangement — the Worker script is served by the portal under the
  portal's one policy, so that policy carries the scheme and therefore the page carries it too.
  Narrowing it in place would mean emitting a second policy for one path and requiring every static
  host to apply it per-path; the two-origin arrangement already expresses the same boundary in a way
  any host can honour.

**What to weigh before enabling it.** The points the earlier draft of this section listed have not
gone away; they are the decision, not an obstacle to it:

- **The credential boundary.** A visitor who installs a package runs it in the same interpreter as
  the rest of the session, so it can read what that origin holds and reach what `connect-src`
  permits. Weigh `network` together with `playgroundOrigin` and `persistCredentials`, not
  separately. The build already warns when credentials are persisted without a dedicated origin.
- **Supply chain.** A named install is not pinnable, by construction. What is pinned stays pinned;
  what a visitor adds is theirs, for that session.
- **Honest UI.** The help panel is still generated from the resolved policy — it shows the install
  example in open mode and the refusal in restricted mode, from one value — so the failure this
  addendum corrects cannot recur in either direction.

**What a visitor should expect.** An experiment. Pure-Python wheels usually work; packages with
compiled extensions usually do not, because a wheel has to have been built for WebAssembly.
A package that breaks the session is not something to undo by hand: `Restart session` replaces the
interpreter and gives back the starting environment.

Restricted mode remains, unchanged and still the default, for deployments that want a fixed
reviewable environment. `REFUSED_PACKAGE_ORIGINS` still applies there, still refuses at build time,
and still names the field.

## CSP and CORS

The build writes the policy; you serve it. `host-policy.json` in the artifact carries it verbatim.

A page with a same-origin playground gains exactly:

```
script-src  … 'wasm-unsafe-eval' <runtime origin>
worker-src  'self'
img-src     … blob:
media-src   'self' blob:
style-src-attr 'unsafe-inline'
connect-src … <runtime origin> <wheelhouse origin> <add-on origin> <connectOrigins…>
```

`'unsafe-eval'` is never added. `connect-src` is never widened by anything in a snippet: no origin
is derived from an import, a URL in a string, or any other reading of Python. The three package
origins come from `resolvePackagePolicy`, which is the same value the **Python packages** help panel
is rendered from. `pypi.org`, `files.pythonhosted.org` and `test.pypi.org` are refused whatever a
deployment CONFIGURES; the first two are added anyway on `freva-client`, because that profile's
startup resolves against them and a policy omitting them would produce a page that builds and
cannot start. The difference is who chose. A portal that emits no
runnable provider gains none of these directives at all — `default-src 'none'` denies workers,
frames and media by fallback, so their absence is real rather than implied.

With `playgroundOrigin`, the parent gains only `frame-src <origin>` and `style-src-attr`; the child
document carries its own policy, in `playground-origin/deploy.json`, alongside the exact file list
to copy.

## What a press sends

Nothing executable. The build gives every marked snippet a deterministic id
(`content:<source path>#<code-block occurrence>`) and a lowercase SHA-256 over the author's exact
bytes. A press sends **only** that id and that digest.

Same-origin, the page reconstructs the source from the copy control the author's own bytes already
live in, and verifies it against the build's digest before enabling the button — so a page edited
after the build has a Copy control that works and a Try control that never appears.

Separate-origin, the child owns a manifest with the sources, verifies every source/digest pair
before importing an interpreter, and refuses an id it does not know. A stale child deployment fails
visibly rather than running a different snippet.

## Credentials

`persistCredentials` defaults to `false`. What is persisted is a refresh token in browser storage,
readable by any same-origin script — including anything a visitor manages to execute at the prompt.
Turning it on is a statement that the origin is one you trust with a credential, so give the
playground its own origin; the build warns (`FP1220`) when it is on without one.

This is why `network` and `persistCredentials` are one decision rather than two. An authenticated
Freva session and install-anything-by-name are not independent settings: together they mean code the
visitor chose, running with a live credential and the portal's `connect-src`. A warning dialog is
not a control here — what enforces anything is the policy and the digest-checked loader — so a
deployment that wants open installs alongside authentication should give the playground its own
origin rather than add a prompt. Waterpark does neither halfway: it runs open, and it keeps
`persistCredentials` off.

A dedicated `playgroundOrigin` is recommended whenever Freva authentication is used at all, for the
same reason: visitor Python otherwise runs with the portal's origin authority.

## Browser Dask: what it is for

```python
import dask
import xarray as xr

dask.config.set(scheduler="synchronous")  # the add-on has already done this
ds = xr.open_dataset("https://example.org/small.zarr", engine="zarr", chunks={})
subset = ds.isel(time=slice(0, 2)).chunk({"time": 1})
print(subset)
```

**One Worker, one synchronous scheduler.** Not a cluster, not threads, not CPU parallelism. It is
for bounded examples: demonstrations, exploration, subsetting, and computations whose result fits in
one tab. It is not a way to rechunk a climate archive, and it will not become one by being asked
more insistently.

`.values` materialises and removes most of the benefit of chunking. The browser HTTP filesystem is
**read-only**: a small rechunked result may be written to `/workspace` within the usual limits, and
a remote write fails clearly. Remote Zarr reads need the browser filesystem and WebAssembly stack
switching (JSPI); where a browser lacks it the console says so at startup.

## Cartopy without the downloader

```python
import cartopy.crs as ccrs
import cartopy.feature as feature
import matplotlib.pyplot as plt

fig = plt.figure(figsize=(10, 5))
ax = plt.axes(projection=ccrs.Robinson())
ax.coastlines(linewidth=0.4)
ax.add_feature(feature.BORDERS, linewidth=0.3, edgecolor="0.3")
plt.show()
```

Unchanged code, and no network. Cartopy's runtime Natural Earth downloader is **intentionally
bypassed**: the add-on stages the 110m coastline and boundary shapefiles under Cartopy's own layout
and points `CARTOPY_DATA_DIR` at them. A missing or corrupt file is an add-on preparation error, not
a silent fall back to `naturalearth.s3.amazonaws.com` — which is not in any policy this build
writes. Cartopy and Matplotlib still load lazily, on import; enabling the add-on does not preload
either.

The data is Natural Earth 5.1.2 (public domain), with its `LICENSE.md` staged beside it.

## The combined environment

```python
import dask
import xarray as xr
import cartopy.crs as ccrs
import cartopy.feature as feature
import matplotlib.pyplot as plt
from freva_client import databrowser

dask.config.set(scheduler="synchronous")

ds = xr.open_dataset(
    "https://example.org/small.zarr",
    engine="zarr",
    chunks={},
)

subset = ds.isel(time=slice(0, 2)).chunk({"time": 1})
print(subset)

fig = plt.figure()
ax = plt.axes(projection=ccrs.Robinson())
ax.coastlines()
ax.add_feature(feature.BORDERS)
plt.show()
```

`https://example.org/small.zarr` is a placeholder. Point it at a store you host, and add that
origin to `connectOrigins` — a URL in a snippet grants nothing by itself.

## Not supported

- Python inside `trustedSubsites`. Those are opaque prebuilt HTML artifacts and are outside this
  feature entirely.
- Per-snippet profiles, per-snippet packages, or arbitrary package metadata on a fence.
- Composed profiles.
- `dask.distributed`, multiprocessing, thread pools.
- Runtime dependency resolution from PyPI, or runtime downloads from Natural Earth. Neither origin
  is in any policy this build writes.
- Installing a package by name at the prompt, in a RESTRICTED deployment.
  `await micropip.install("name")` reaches an index that `network: "origins"` does not permit, and
  the terminal does not suggest it there — see _Packages: a curated environment_. In open mode it
  works and the terminal shows it; that is the mode's whole point.
- A promise that any package will install. Open mode permits the fetch; it does not make a package
  with compiled extensions build for WebAssembly. Unsupported packages fail, and `Restart session`
  is the way back.
- Global `pyodide_http` monkey patching. This project relies on Pyodide's native `requests`
  behaviour for Freva and tests that `pyodide_http` is never loaded.
- Best-effort add-ons in general. `optionalAddons` is a closed subset decided by whether preparation
  can fail without mutating the interpreter; it is not a switch that makes every add-on advisory.
- A build that fetches. `prepare-playground` is the only command that opens a socket; `validate` and
  `build` consume what it produced and nothing else.
