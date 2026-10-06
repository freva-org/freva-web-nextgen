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

| what                                         | code     |
| -------------------------------------------- | -------- |
| the marker on a language that is not Python  | `PC1022` |
| the marker twice on one fence                | `PC1022` |
| the marker on an empty block                 | `PC1022` |
| `editable` without `try-in-python`, or twice | `PC1022` |
| anything else on the fence                   | `PC1021` |

**A marked block in a portal with no `pythonPlayground` is ordinary copyable code.** No control, no
identity, no digest, and nothing of the interpreter in the artifact. That is the same page it was
before the marker was added, byte for byte.

There are no per-snippet profiles and no per-snippet packages. What a page's interpreter contains is
the deployment's decision, in one place.

### Editable snippets

A runnable snippet can be made editable, so a reader can change it and press Try in Python again.
It is off by default. Opt one snippet in with `editable` on the fence (any order beside `title` and
`try-in-python`):

````markdown
```python try-in-python editable title="area.py"
def area(r):
    return 3.14159 * r * r

print(area(2))
```
````

or every runnable snippet on the portal with `pythonPlayground.editableSnippets: true` (this is also
the way to do it for RST, which has no per-block `editable` option).

With scripts on, an editable snippet looks like an editor before anyone clicks it: line numbers
in a gutter (never selected or copied, and fixed while a long line scrolls), an **Editable** tag
beside the language, and a text cursor. Read-only code blocks get none of this.

The editor loads only when the reader clicks into the block (or focuses it and presses Enter): a
small chunk of its own, like the interpreter. Once open, it offers:

- Python syntax highlighting, drawn as DOM nodes with the theme's `--syn-*` colours. There are no
  inline styles and no `eval`, so the page policy is unchanged.
- Tab and Shift+Tab to indent and outdent (four spaces, for a line or a selection), and Enter to keep
  the indentation, adding a level after a colon.
- Escape, then Tab, to leave the editor, so the keyboard is never trapped.
- Ctrl+Enter (Cmd+Enter on a Mac) to run.
- A light background on the cursor's line while the editor has focus, and line numbers that
  follow edits.
- An **Edited** marker beside the title (beside the Editable tag when there is no title) while the
  code differs from the author's. On a phone the two header tags show as a pencil and a dot.
- **Reset**, beside Try in Python, shown once the code differs from the author's. It puts the
  author's code back.
- **Copy**, which copies what is on screen, edits included.

Editing needs the interpreter on the portal's own origin. With `playgroundOrigin`, a snippet that
asks to be editable stays read-only and runnable, and the build warns once (`FP1227`) and names the
key. See _What a press sends_ for why.

### When the controls show

On a runnable snippet, Copy and Try in Python are always on the block's bar.
`pythonPlayground.controls: hover` shows them only under the pointer or with the focus, on devices
that can hover (touch screens always show them). A plain code block's Copy appears on hover either
way.

While a press runs the button reads **Running…**, then **Done** when the program ran to the end,
or **Failed** if it raised (the traceback is in the transcript) or could not run (refused, or no
interpreter). Presses made while the interpreter is busy queue, and the button stays Running…
until the last one finishes. With `playgroundOrigin` the bridge reports nothing back: **Done**
means handed over, and an exception shows only in the transcript.

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

  controls: always # or hover
  editableSnippets: false # true needs the interpreter on this origin (no playgroundOrigin)

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

### Which configuration wins

There is one playground per page, and one per portal. Nothing is resolved by precedence; the
rules only say where each key comes from, and anything that would need a tie-break is an error.

| Where Python runs                                                              | Its configuration                                                                  |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| A `try-in-python` block on a documentation page or in a landing prose fragment | `pythonPlayground`, as written. Prose has no stanza of its own.                    |
| A `dataset-tree` block with `python: { enabled: true }`                        | `pythonPlayground`, with the keys the block's `python` stanza writes overriding it |
| A `dataset-tree` block with `python` and no `pythonPlayground`                 | the block's stanza, with the defaults for everything it does not write             |

Then:

- **`python` is a `dataset-tree` key only.** Written on a `prose` block (or any other block) it is
  refused as `FP1104` at that block, with a hint pointing at `pythonPlayground`. A prose block that
  wants a different interpreter is asking for a second playground on the page, which does not exist.
- **One page, one playground (`FP1215`).** Every provider on a page that actually runs Python -
  each Python-enabled tree, and `pythonPlayground` when the page has a `try-in-python` block - must
  resolve to the same `profile`, `autostart`, `network`, `maxSessions`, `initialSource`, origins
  and `terminal.*`. A disagreement is an error per differing key, naming both providers. A tree
  that writes only `enabled: true` cannot disagree.
- **One portal, one playground (`FP1215` again).** The same comparison runs across pages, because
  the portal emits one Content-Security-Policy and at most one playground artifact.
- A `pythonPlayground` that no page uses emits nothing and warns once (`FP1222`).

So a landing with `dataset-tree` + `python: { enabled: true }` and a prose fragment with a
`try-in-python` snippet runs both on the portal's `pythonPlayground`. To give the landing a
different interpreter, change `pythonPlayground` - not the blocks.

### Profiles are singular

```text
minimal
└── xarray-zarr
    └── freva-client
```

A chain, so a list would only ever be a longer way of naming the last one — and a composed
environment would be one nobody had tested as a whole. `freva-client` **already includes** xarray,
Zarr, fsspec, numcodecs and cftime (for model calendars); there is no "xarray plus Freva" to ask
for. One session can do all of:

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

## Sessions: a setup per session, measured, and put to sleep

Without `sessionChoices` every session gets the configured setup and nothing below applies. With it:

```yaml
pythonPlayground:
  enabled: true
  profile: xarray-zarr # the default setup: this profile ...
  addons: [dask] # ... with these add-ons
  initialSource: |
    import xarray as xr
  maxSessions: 2
  sessionChoices:
    profiles:
      minimal: {}
      xarray-zarr:
        allowedAddons: [dask, cartopy-natural-earth-110m]
    starterProfiles: [xarray-zarr] # where `initialSource` runs (default: the configured profile)
    allowSkipStarter: true # a visitor may switch it off where it would run
  resources:
    maxLiveSessions: 1 # sessions holding an interpreter at once (default: maxSessions)
```

- **Choosing.** `+ New session` offers _Same as current_ or _Custom setup_ (profile, the add-ons
  allowed on it, the starter), then a review step, then **Start**. Start reserves a live slot
  first - atomically, so two presses cannot start two. When every slot is taken, the least recently
  used idle session is put to sleep for it (as below; its tab says so), also in another frame of the
  page; only sessions running code make Start wait, and it says so. The setup is locked for the
  session: a restart keeps it, a different setup is a new session.
- **The configured setup must be a choice.** `profile` must be one of `profiles` and `addons` must
  be allowed on it; an add-on must work with the profile it is allowed on; `starterProfiles` needs
  `initialSource`. Each is `FP1219` at the key that is wrong.
- **Every allowed setup is prepared and permitted.** `prepare-playground` prepares the union of the
  allowed add-ons (and the Freva wheelhouse when `freva-client` is allowed), and the page's
  `connect-src` covers the union - a package index when any allowed profile needs one.
- **Telemetry.** The window's status row shows the active session's setup and what was measured:
  WASM linear-memory _capacity_ (not memory use), the bytes in `/workspace`, the output the window
  retains, what the worker fetched, the time to a usable interpreter, and the live slots in use. A
  busy interpreter cannot answer, so the row shows its last sample, marked as such.
- **Sleep.** _Sleep session…_ in the ⋮ menu stops the interpreter and frees its slot. The transcript
  and the committed files in `/workspace` are kept - streamed into a separate checkpoint in the
  origin private file system, each with its SHA-256, under a manifest written last - and Python's
  variables and imports are lost. _Wake session_ starts a fresh interpreter with the same setup,
  restores the files (verifying each digest) before any code runs, then runs the starter; cells are
  never replayed. A checkpoint that does not verify is quarantined and the session says it could not
  wake. Sleep is refused while Python runs or holds a file open, and where the browser cannot write
  to its private file system (download the files instead). Sleep is automatic only to make room for
  a session being started or woken.
- **With `playgroundOrigin`** the chooser, the telemetry and the Sleep/Wake control live in the
  playground's own document, and the portal learns the chosen setup through one message carrying
  only `{profile, addons, runStarter, frontend}` and the policy's fingerprint (see the embed
  protocol in `@freva-org/browser-python`). A setup the playground's policy does not allow is never
  offered.

## The notebook

```yaml
pythonPlayground:
  playgroundOrigin: https://python.example.org
  notebook:
    enabled: true
    seeds: # optional: notebooks of your own, beside one per registered example
      - ./notebooks/start-here.ipynb
```

A JupyterLite notebook (the Notebook interface only) on the playground's origin, whose _Freva
Python_ kernels are the allowed setups - one kernel each, the default first. Cells are plain CPython
on `@freva-org/browser-python`: rich output (pandas and xarray HTML, SVG, PNG) is sanitised before
it reaches the page, and magics, `!shell`, `input()`, inspection, the debugger, comms and widgets
are not supported - each is answered, never left hanging. Stopping a cell that never yields
restarts Python after a grace period, and says that its state was lost. The window menu gains
_Open as notebook_, which opens the example last run (each registered example is a seed notebook)
or the notebook's file list, where `seeds` and the examples are.

It requires `playgroundOrigin` (`FP1235`): the notebook runs only there, under its own policy, and
the portal's pages keep theirs. `consoleInPage: true` keeps that origin for the notebook alone and
runs everything else in the portal's own pages (see [configuration.md](./configuration.md)). Prepare
the notebook like the other materials, and give it to the build:

```bash
freva-portal-builder prepare-notebook --source-root . --config portal/portal.yaml --out .notebook
freva-portal-builder build --source-root . --config portal/portal.yaml --out build/portal \
  --notebook .notebook
```

`prepare-notebook` installs a pinned, hash-checked JupyterLite toolchain into a cache outside the
artifact (`--python` picks the interpreter that runs it; a portal that needs `--stac-materials` or
`--python-materials` to build needs them here too), builds the site in isolation - no stock
kernels, no service worker, nothing from a CDN, no inline script - and writes
`NOTEBOOK-INVENTORY.json` with every file's digest. `build` refuses a site prepared for another
configuration (`FP1605`) or a missing one (`FP1604`), copies it under `playground-origin/notebook/`,
and `deploy.json` lists its files and the headers for `/notebook/`. `verify` checks the copy against
the inventory. The notebook's policy is the playground's network plus `style-src 'unsafe-inline'`
(JupyterLab injects its stylesheets at run time; Python-authored markup never keeps a style) and
`frame-ancestors 'none'`; it has no `'unsafe-eval'`. Notebooks live in the visitor's browser
storage; `.ipynb` files (nbformat 4) can be uploaded, are validated and never run on import, and are
downloaded as nbformat 4.5. Saving one into `/workspace` is an explicit command.

### The assistant and the data panel

```yaml
pythonPlayground:
  playgroundOrigin: https://python.example.org
  notebook:
    enabled: true
    assistant:
      climateclaw:
        host: https://freva.example.org
        # The identity provider's issuer, when it sends `iss` (Keycloak does).
        expectedIssuer: https://keycloak.example.org/realms/Freva
        defaultModel: gpt-5
        runAndFixModel: gpt-5-mini # optional; defaults to defaultModel
        scopeNote: Answer about the ERA5 and NextGEMS data of this portal.
        examples:
          - title: Plot mean 2m temperature
            prompt: Plot the global mean 2m temperature of ERA5 for 2020.
        hideCodeByDefault: false
        # Where ClimateClaw serves files its code saved (its CLIMATECLAW_PROJECT_WEBSITE), when
        # not the host: figures saved with savefig are read from there. Default: the host.
        previewOrigin: https://freva-web.example.org
    dataPanel:
      tree: home-2 # a dataset-tree block, `<landing id>-<block index>`
      title: Example data # optional; default "<site title> data"
      icon: ./icons/data.svg # optional, checked like the portal's other SVGs
      defaultAction: open-in-notebook # the primary action: its button, and Ctrl/Cmd+Enter
      seedNotebooks: [./notebooks/era5.ipynb]
      startNotebook: ./notebooks/start.ipynb # optional; opened when the Lab starts
      gridlook: true # optional; GridLook's 3D globe for public stores (default false)
```

`startNotebook` opens when the Lab starts, in place of the Launcher, as the visitor's own copy
(made once from the published seed, so later visits open their version). Its saved outputs show
as they are: a map can be there before anything runs, and running the cell computes it again. It
stays behind a document of theirs restored from their last visit.

The notebook's browser tab carries the portal's name ("<site title> Playground") and its favicon
(`site.identity.favicon`, as an SVG, PNG or ICO), not JupyterLite's; both are part of what
`prepare-notebook` records, so a site prepared for another name or icon is refused (`FP1605`).

Either block (`FP1236`, `FP1237`) adds a trimmed JupyterLab interface to the notebook site, at
`/notebook/lab/`, beside the Notebook interface. Trimmed: no new text, Markdown or Python files, no
contextual help, no JupyterLite logo. The console stays: a Freva Python console from the Launcher (a
kernel of its own), and _New Console for Notebook_, which shares the notebook's kernel - its
interpreter and variables, nothing loaded twice. `prepare-notebook` checks each disabled plugin
against the built bundle. The portal's _Open as notebook_ still opens the Notebook interface; link a
landing, a card or the navigation to the Lab with the `notebook` target:

```yaml
- type: links
  items:
    - label: Ask ClimateClaw in a notebook
      notebook: lab # {playgroundOrigin}/notebook/lab/; `files` opens the file list
```

It opens in a new tab, and is an error (`FP1201`) without the notebook or, for `lab`, without
`assistant` or `dataPanel`.

#### The notebook in a landing

A `notebook` landing block puts the notebook itself in the page, in a frame:

```yaml
- type: notebook
  heading: Ask ClimateClaw, in a notebook
  summary: JupyterLab with this portal's kernel, data panel and assistant. # optional
  view: lab # default; `files` shows the Notebook interface's file list
  title: Waterpark Playground # optional: the window's name; default "<site title> Playground"
```

Above the frame are two controls. _Maximize_ works like the dataset browser's: the window takes the
screen between the header and the footer over a dim, and the button, a click outside, the browser's
Back and Escape (with the focus outside the frame, which keeps its own keys) restore it. The frame
is never moved, because a moved frame loads again and the open notebook, its kernel and the chat
would be lost. _Open in a new tab_ opens the same page. The frame loads when the block scrolls near.
It is sandboxed: scripts, its own origin's storage, downloads and popups (Freva's sign-in), but
never navigation of the portal's page.

The block adds the playground origin to the portal's `frame-src`, and the notebook's policy then
has `frame-ancestors` with the portal's own origin (`site.canonicalUrl`) instead of `'none'`.
Without the block, the notebook stays a top-level page that nothing can frame.

**Keep the playground origin on the same site as the portal** (for example `portal.example.org`
and `play.example.org`). A framed page on another site gets partitioned storage. Its notebooks
are then not the ones a new tab shows. The sign-in callback, a top-level page, also cannot reach
the framed notebook, so signing in to ClimateClaw works only in a new tab. The block is an error
(`FP1201`) under the same conditions as the `notebook` link target.

**The assistant** is [jupyterlite-ai](https://github.com/jupyterlite/ai) 0.20.1, used as it is, with
`@freva-org/jupyterlite-climateclaw` as its provider. `prepare-notebook` downloads jupyterlite-ai
and the eight prebuilt extensions it needs from PyPI, pinned with hashes; none of it is committed or
hosted by this project. The provider and model are preselected through settings overrides, and
jupyterlite-ai's AI settings panel (`@jupyternaut/persona:settings-panel`), its MCP manager (it
needs a Jupyter server), its file-editor diff (the file editor is disabled) and its chat panel
(`@jupyterlite/ai:chat`) are disabled. ClimateClaw shows chats in a panel of its own instead, on
jupyterlite-ai's chat models: the chat's name (click to rename), delete, _New chat_, _History_, open
in a tab and the account; a first page with _Sign in with Freva_; the model picker beside Send; a
rating and versions of edited messages under the replies. Each example is also a slash command; the
notebook toolbar gains _Run at DKRZ_. Nothing in jupyterlite-ai's settings, browser storage or a URL
is a credential.

- **Register the sign-in callback.** Visitors sign in with Freva in a popup that returns to the
  shared callback on the notebook's origin, under the deployment's base path:
  `{playgroundOrigin}{basePath}auth/callback/` (the portal's own callback path,
  `auth.options.callbackPath`). The playground origin serves the whole deployment under the
  portal's base path, because the compiler writes that path into every URL of the pages deployed
  there: with `site.canonicalUrl: https://portal.example.org/showroom/`, the console is at
  `{playgroundOrigin}/showroom/`, the notebook at `{playgroundOrigin}/showroom/notebook/` and the
  callback at `{playgroundOrigin}/showroom/auth/callback/`. The build emits the callback beside
  the playground document, and `deploy.json` records `basePath` and lists the callback with its
  headers (`no-store`, no referrer, never framed, its own script only). Sign-out returns there
  too. `build` and `prepare-notebook` print the exact URLs:

  ```text
  sign-in callbacks: register each in the identity provider (Keycloak: Valid redirect URIs,
                     Valid post logout redirect URIs) and in freva-rest's redirect allow-list
    portal    login   https://portal.example.org/auth/callback/
              logout  https://portal.example.org/auth/callback/
    notebook  login   https://play.example.org/auth/callback/
              logout  https://play.example.org/auth/callback/
              legacy  https://play.example.org/notebook/freva-login-callback.html (keep during the migration)
  ```

  A notebook reached at another origin (a development port, staging) calls back to that origin:
  register it as well. The notebook page never navigates; a blocked popup offers the login in a new
  tab.

- **How the response reaches the notebook.** The popup carries a record naming its attempt; the
  callback hands the response to that tab on a channel named after the attempt and, same origin
  only, by `postMessage` to the window that opened the popup. The tab holds the login transaction
  (state, PKCE, issuer), acknowledges, and exchanges the code; the popup closes on the
  acknowledgement. The second transport matters when a `notebook` block frames the notebook from
  a portal on another _site_: the frame's storage and channels are then partitioned under the
  portal, and only the opener's `postMessage` reaches it - unless the identity provider's page
  sends `Cross-Origin-Opener-Policy`, which cuts the popup from its opener. Then nothing can
  reach the frame, and the popup says to open the notebook in its own tab (the block's _Open in a
  new tab_) and sign in there. Same-site framing (`portal.example.org` and `play.example.org`)
  needs neither.
- **Expiry.** An attempt is good for 10 minutes. A popup left open longer is let go: the next
  _Sign in_ closes it and opens a new one, and a callback that finds its record expired tells the
  notebook, which lets it go too.

- **Migrating from `/notebook/freva-login-callback.html`.** The old page stays in the notebook and
  answers sign-ins from tabs loaded before the upgrade (it relays the response it receives,
  unchanged). Keep it registered until those tabs are gone, then remove it from the identity
  provider and freva-rest.
- **Name the issuer** when the identity provider sends `iss` with its authorization response (RFC
  9207; Keycloak does, and says so as `authorization_response_iss_parameter_supported` in its
  discovery document). Copy `issuer` from
  `{host}/api/freva-nextgen/auth/v2/.well-known/openid-configuration` into `expectedIssuer`; without
  it the sign-in is refused (`issuer-unexpected`).
- **Locally**, `host` may be a loopback origin over http (e.g. `http://127.0.0.1:4330`, the mock in
  `@freva-org/jupyterlite-climateclaw`:
  `MOCK_FREVA_PORT=4330 node browser-tests/mock-freva.mjs <callback URL>`), but only with a loopback
  `playgroundOrigin`.
- **The browser never sends `x-freva-rest-url`.** ClimateClaw requires it, so the deployment's
  reverse proxy in front of `{host}/api/chatbot` must set it to its own freva-rest - and should
  overwrite any value a client sends (see below).
- **The scope note steers; it does not restrict.** It is prepended to a new thread's first message
  and shown in the chat. A visitor can ask about anything the ClimateClaw deployment can reach. To
  confine the assistant to this portal's data, scope the deployment itself: its instance
  (`CLIMATECLAW_INSTANCE_NAME`) and prompt, the data it mounts, the network it may reach, the Freva
  configuration of its kernel and its retrieval corpus.
- **Run & fix at DKRZ is not this notebook's kernel.** It sends the cell to ClimateClaw with a fixed
  instruction - run it as it is; only if it fails, fix the minimal cause and run the fix - and
  writes the result into the cell's outputs, labelled _ran at DKRZ (ClimateClaw)_. A model is in the
  loop: it is slower, costs tokens, is not deterministic, and nothing it defines exists in the
  browser kernel. A changed cell is shown as a diff and replaced only by _Apply fix to cell_.

**The data panel** (`@freva-org/jupyterlite-freva-data`) shows the named dataset-tree block in the
left side bar - its build-time catalogue, or its live S3 roots with the published search index -
under a card naming the selected dataset, with _Open in notebook_ (the primary action), _Insert_ (or
drag onto a notebook), _Inspect_ (the store's metadata in a tab), _View on globe_ (with `gridlook`),
_Ask ClimateClaw_ (with the assistant), _Copy URL_ and _Copy code_. Only Python examples the build
registered, runnable and without placeholders, whose bytes match their recorded digest, go into a
notebook; a live archive's recipe is filled only with a store identifier validated against its
roots. The launcher shows the site's kernel and its own cards, each with its own logo in the colour
of the panel's icon: _New &lt;site&gt; notebook_, _Browse data_ (the panel's icon), _Example
notebooks_ (copied into the visitor's files when opened) and _Ask ClimateClaw_ (ClimateClaw's logo).

**GridLook** (`gridlook: true`) adds the 3D viewer: Inspect's _3D Viewer_ tab and _View on globe_
show the store on [GridLook](https://gridlook.pages.dev)'s globe, in a sandboxed frame that never
receives the page's referrer. GridLook fetches the store itself, so only stores readable without a
token are shown; for a protected one the tab stays disabled and says why. The same switch gives the
panel's tree on the portal's own pages the globe in its Inspect (the portal's `frame-src` names
GridLook); without it that tab is disabled and says the viewer is not enabled. Off by default: it
loads a third-party application that this project neither builds nor hosts.

**The notebook's policy** adds the Freva host and the data panel's store origins (the live gateway,
or the catalogue's `inspect` URLs) to `connect-src`, and with `gridlook` exactly
`frame-src https://gridlook.pages.dev`. jupyterlite-ai's bundled zod probes `Function("")` once at
start-up; without `'unsafe-eval'` it is refused (zod works without it) and the browser reports that
one violation.

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

**An edited snippet is the one exception, and it is visitor input.** Until the reader changes the
code (or after Reset), a press is the unedited press above: id and digest, verified. Once the text
differs, what runs is code the reader wrote, as if typed at the prompt, in the same session
(interpreter, namespace, queue). The transcript labels it as an edit on a line above the echoed
code (`# Edited snippet · area.py` when copied), never under the registered example's name; the
label does not run, so traceback line numbers match the editor. The id only names the snippet it
started from, and must still be one the page registered.

That is why editing is same-origin only: the separate-origin bridge carries registered ids and
digests and has nowhere to put source. The build does not make a snippet editable with
`playgroundOrigin` (`FP1227`), and a framed session refuses edited source even if a changed page
asks.

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
- Editable snippets with `playgroundOrigin` (`FP1227`), and a per-block `editable` option in RST
  (use `editableSnippets`).
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
- A build that fetches. `prepare-playground` and `prepare-notebook` are the only commands that open
  a socket; `validate` and `build` consume what they produced and nothing else.
- Sleep on a timer, more than two live interpreters, or parallel workers.
- `sessionChoices` on a snapshot dataset tree's own `python` stanza: choices are a portal-wide
  policy, used by runnable content and by trees that inherit the portal's playground.
