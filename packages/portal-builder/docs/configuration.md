# Configuration reference

`portal.yaml` is validated against the published
[`portal.schema.json`](../schema/portal.schema.json) (JSON Schema 2020-12). Every
portal-owned object is closed: an unknown key is an error carrying a JSON Pointer
and, where the parser reported one, a line.

## Parsing rules

- YAML 1.2 **core** scalar semantics, so `yes` is the string `"yes"` and
  `2026-08-18` is a string. A value never changes type because of its spelling.
- Duplicate keys are an error, not last-one-wins.
- Anchors, aliases, merge keys and custom tags are refused rather than resolved.
- Environment-variable interpolation does not exist.
- Paths are relative to the file that declares them, then contained by
  `--source-root`. Symlinks are refused. `..` is fine while the resolved target
  stays inside the root.
- File and path names are UTF-8 and Unicode NFC; a non-NFC name is an error.
- Globs use one pinned implementation: `**` is a globstar, dotfiles are excluded
  unless the pattern segment starts with `.`, matching is case-sensitive,
  symlinks are never followed, results are sorted by Unicode code point, and a
  case-folded output collision is an error.

## `site`

| Field                               | Rule                                                                                                                                                                                |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                | Stable machine identifier. It never selects a theme.                                                                                                                                |
| `title`, `subtitle`                 | Human text.                                                                                                                                                                         |
| `language`                          | BCP 47-shaped tag.                                                                                                                                                                  |
| `canonicalUrl`                      | The exact absolute HTTPS site-base URL, with a trailing slash and no user-info, query or fragment. **Its pathname is the base path**; there is no second field to disagree with it. |
| `identity.logo`, `identity.favicon` | Local files. An SVG is published only as its sanitized derivative.                                                                                                                  |
| `institution`                       | Optional name and HTTPS URL.                                                                                                                                                        |

## `chrome` and `navigation`

Typed links only. Each link names exactly one of `landing`, `component` or
`href`; `href` must be an internal site path that exists, an HTTPS URL or a
`mailto:` address.

- A link to an **unknown** target is an error.
- A link to a **known but disabled** component is omitted with an informational
  diagnostic. That is what makes enable/disable a one-field operation without
  also accepting typos.

`chrome.header.prose` and `chrome.footer.prose` point at a local Markdown or RST
source; it is a fragment, so it owns no route.

## `theme`

```yaml
theme:
  preset: waterpark
  tokens:
    colorAccent: "#006f86"
```

A preset is a registered, content-free visual entry: `default`, `freva`,
`waterpark`, `contour`, `cosmos`. Changing it changes styling and nothing else — not the title,
the logo, the routes, the components or the endpoints.

Two of them ask for one thing more than a stylesheet: a **drawn backdrop** behind the configurable
landing page, and nowhere else.

- `contour` draws animated pressure contours over a warming-stripe band.
- `cosmos` draws a cross-section of an observing system, from orbit to the ocean floor, with a
  context-aware Scene key under the header explaining what each field and instrument is. It ships
  about 210 kB of object bodies and a deferred renderer chunk, both of which exist only in a
  `cosmos` build and are fetched only on a landing route.

Neither adds a component, a service or a route, and neither is fetched by any other preset. On a
documentation, Data Browser, STAC or error page a backdrop preset keeps its palette and does not
run its scene. `tokens` is a finite
override surface; arbitrary CSS and asset imports are not accepted in v1. A
generally useful new token is a contribution to the framework, which then gets
tests across every built-in component.

## `rendering`

```yaml
rendering:
  profile: portal-content-v1
  sources:
    - root: ./content
      mount: /docs/
      files:
        include: ["**/*.md", "**/*.rst"]
        exclude: ["_fragments/**", "**/README.md"]
  assets:
    - root: ./assets
      mount: /assets/
  downloads:
    - root: ./downloads
      mount: /downloads/
  diagnostics:
    warningsAsErrors: true
  limits:
    maxPages: 2000
```

- **Sources** produce routes. `guide.md` becomes `/docs/guide/`, and
  `guide/index.rst` wants the same route — that collision fails the build rather
  than being resolved in one file's favour.
- **Assets** accept only the published embeddable MIME allowlist. HTML,
  JavaScript, CSS, WebAssembly, source maps and unknown active formats are
  errors. Every SVG passes through the one sanitizer.
- **Downloads** accept arbitrary bytes, copied byte-for-byte. A recognized
  extension gets its MIME type from the profile; an unrecognized one
  deterministically gets `application/octet-stream`. Every download is recorded
  with `Content-Disposition: attachment` and `nosniff` requirements. Consumer
  configuration cannot make a download an active inline type.
- **Limits** may only _raise_ the published operational guardrails.

## `landings`

```yaml
landings:
  home:
    path: /
    source: ./landings/home.yaml
```

A landing file is an ordered list of framework-owned block types carrying your
data: `hero`, `prose`, `cards`, `links`, `callout`, `component-link`,
`component-search`, `dataset-tree`. A landing name is a project-local identifier.

`component-search` produces a plain GET form whose action is the target
component's route and whose hidden fields carry a versioned `SearchIntentV1`.
That is why a search started on a landing page survives a reload, a bookmark and
a paste into a chat window — and why it works with JavaScript switched off.

### `dataset-tree`

A browsable dataset archive, drawn in the hero column where `component-search`
would go, so a deployment can offer either one.

The block has **two source modes, and exactly one of them is required**. Give it
`catalog` for a build-time snapshot, or `s3` for a live object store. Both keys
is an error, and so is neither: they answer the same question two different ways,
and a build that had both would have to pick one silently.

```yaml
- type: dataset-tree
  catalog: ../data/archive.json # SNAPSHOT: project-owned, inside the source root
  heading: Browse the archive
  summary: Expand a collection to see what is published.
  expand: # node ids opened as soon as they appear
    - cmip6
  statusLabel: SNAPSHOT # the footer pill's text
```

The catalogue is a `dataset-tree-catalog-v1` document — the schema is published
by `@freva-org/dataset-tree` and is closed, so an unrecognised property is an
error rather than a silent drop. It is read through the same containment anchor
as every other input, validated while the artifact is produced, and **embedded
in the page**. There is no request at page load, no service to be up, and no
catalogue file beside the page for anything to fetch. A node identifier under
`expand` that the catalogue does not contain fails the build.

Two consequences worth knowing before you reach for it. The catalogue is paid
for by every visitor to that landing, in the HTML itself, so it is capped at
512 KiB; an archive larger than that has outgrown a snapshot. And a portal that
declares no `dataset-tree` block contains none of the component — not its
JavaScript, not its stylesheet, not a byte — which is checked against built
output, so switching the block on and off is a real decision rather than a
cosmetic one.

Producing the catalogue from a live archive is not this builder's job. It is a
crawl, with credentials and a failure surface of its own; run it as a scheduled
job that commits a file, the way the STAC materials are prepared — or use the
live source below, which does not crawl at all.

#### `s3`: a live archive, one prefix at a time

A petabyte archive has no catalogue, and building one would mean walking the
whole store at build time to produce a file too large to embed. The `s3` source
lists **one prefix, when a row is expanded**, straight from the visitor's
browser:

```yaml
- type: dataset-tree
  heading: Currently available datasets
  s3:
    endpoint: https://s3.eu-dkrz-1.dkrz.cloud # https, or http on loopback
    style: path # path | virtual-host
    roots: # the buckets and prefixes this tree may browse
      - name: cmip6
        bucket: cmip6
        prefix: healpix/cmip6/ # must end with '/', must not start with one
        title: Coupled Model Intercomparison Project Phase 6
        description: Model output on a HEALPix grid.
      - name: cordex
        bucket: cordex
        prefix: healpix/cordex/
        link: # optional: a project page, shown as an external-link control
          href: https://cordex.org
          label: Project page
      - name: xspies
        bucket: xspies
        planned: coming soon # announced, not browsable: a badge and no chevron
    maxKeys: 1000 # keys per page; the adapter follows continuation tokens
    maxPages: 25 # the bound on one listing; reaching it is reported in the page
    retries: 1 # network errors and 5xx only, never a 403
```

**A root may be announced before it exists.** `planned` makes a root a badge with
that text — no chevron, no `aria-expanded`, and not one request, including the
availability probe below. It is the honest way to list a collection that is
coming, and it costs nothing to show.

**One bounded probe per root, at load.** Every browsable root is asked for a
single key (`max-keys=1`, no continuation token, bounded concurrency, cancelled
when the block is destroyed) so that a collection which lists successfully and
holds nothing can say so, instead of a visitor paying a full listing to find out.
That is the only request made before a row is expanded, and a failure is never
read as emptiness: a bucket that refuses listing, or is not there, keeps its
error, and a root whose probe never answered says nothing at all.

**The roots are declared, never discovered.** This never issues `ListBuckets`,
and cannot be made to: an S3 root legitimately answers 403, and asking a
visitor's browser to enumerate an account is not a thing a landing page does.
What a visitor can reach is exactly what is listed here.

**A `.zarr` prefix is a dataset, not a folder.** It is a leaf with an access
panel, and the tree does not descend into its chunks — which is the difference
between one row and forty thousand. `datasetSuffixes` changes the list if your
archive uses another convention.

**What this costs.** The endpoint's origin is added to the artifact's recorded
`connect-src`, and nothing else about the policy changes. The gateway has to be
up and CORS-readable, which a snapshot never needed. `Expand all` is not offered,
because over a lazy source it means "issue a request per branch, recursively, and
hope"; the toolbar carries `Collapse all` and `Reload` instead. And a branch that
fails gets its own message and its own **Retry**, rather than taking out the tree.

**Python, through registered recipes.** A live block may enable the playground.
What makes that safe is that nothing composed in the page is ever executed: the
build registers a **recipe template** — `xarray` over HTTPS — and hashes it, and
the only thing the page contributes is the store's own node id. That id is
validated in the browser against this block's configured endpoint and declared
roots before it is substituted, so a name a source produced fills a hole in a
program the build hashed, and Python source never crosses into a runner.

A store's panel carries **Inspect** and **Try in Python** side by side — the two
things you can do with the store — and the snippet below keeps its own **Copy**.
The recipe is shown whatever the deployment, because it is documentation somebody
may paste into a notebook, and it carries a run control only when the configured
profile actually holds the packages it imports; `FP1217` says so at build time
rather than leaving the absence to be guessed at.

There used to be a second recipe, `s3fs`. It is gone: it needs botocore and a
credential chain a browser does not have, so it was in no profile and never
carried a run control, and a reader met a tab they could not run beside a tab
they could. A deployment that needs another route adds it as its own example.

**A separate playground origin cannot run a recipe.** The embed protocol carries
an example name and a digest and no parameters — deliberately, since that is what
keeps source from crossing origins — and a recipe needs the store substituted
into it. So a block that sets `playgroundOrigin` shows the recipe without a run
control, and `FP1217` reports it. Run recipes in the portal's own document, or
keep the separate origin and treat them as documentation.

**A store is inspectable.** Every `.zarr` prefix carries the plain HTTPS URL of
the store, built from the configured endpoint and addressing style, which is what
the **Inspect** control opens (see below).

#### Opening a node elsewhere

A catalogue node may carry `inspect`, a URL for whatever tool a deployment uses to
look inside a dataset. When it does, the tree offers an **Inspect** control that
dispatches a cancelable `portal:dataset-inspect` event on the block, with
`{ node, inspect }` in its `detail`. A deployment that mounts its own inspector
listens for it (the event bubbles, so any ancestor will do) and calls
`preventDefault()`. A portal built by this package mounts `@freva-org/data-inspector`
and opens the store in the page. Nothing opens a raw storage URL in a browser tab:
handed a listing document instead of a dataset, a reader would reasonably conclude
the inspector was broken. Nothing about a particular inspector lives in the
component.

#### Code samples, and running them

A catalogue node may carry `examples`, and they are shown whether or not
anything can run them:

```json
{
  "id": "cmip6/tas",
  "kind": "dataset",
  "name": "tas.zarr",
  "examples": [
    {
      "id": "python",
      "label": "Python",
      "language": "python",
      "code": "import xarray as xr\n\nds = xr.open_zarr(\"s3://…/tas.zarr\")\nprint(ds)\n",
      "executable": true
    },
    { "id": "cli", "label": "CLI", "language": "shell", "code": "s5cmd cp s3://…/tas.zarr ." }
  ]
}
```

`id` and `language` are required, and there is nowhere to put a digest: a digest
a catalogue author typed is a digest nobody computed, so the build computes one
for every example that is Python **and** says `executable: true`.

Adding `python` to the block turns those digests into a run control:

```yaml
- type: dataset-tree
  catalog: ../data/archive.json
  python:
    enabled: true
    profile: xarray-zarr # a browser-python profile name
    autostart: never # never | after-interactive | immediately
    maxSessions: 2 # 1 or 2; two is the ceiling
    initialSource: |
      print("Python is ready")
    playgroundOrigin: https://play.example.org # optional, and recommended
    runtimeIndexUrl: https://mirror.example.org/pyodide/v314.0.6/full/ # optional
    terminal:
      style: freva-client-terminal
      osControls: auto # auto | mac | windows | linux
      alwaysOnTop: true
      rememberAppearance: true
```

A **Try in Python** button appears beside **Copy** on an example that is Python,
is marked executable, has a registered digest, and contains no unresolved
placeholder (`{{…}}`, `${…}`, `<YOUR_TOKEN>`). Pressing it opens one persistent
terminal window — the real `freva-client-terminal` chrome — and runs the snippet
**as a file**, once, into the session that is already there: the namespace, the
transcript, the history and anything half-typed at the prompt are untouched, and
a press while the interpreter is busy is queued in order.

**What travels.** Not the Python. The tree reports
`{ exampleId, digest, datasetId }`, and the runner resolves that name in the
manifest the build produced. Across a `playgroundOrigin` the same message goes
over `postMessage` and the frame refuses anything it did not register, so a
portal and a playground deployed from different builds fail loudly instead of
running the wrong snippet under a familiar name.

**The way back.** Every dataset-tree block that declares a playground gets a **Python** control in
its own toolbar, beside **Maximize**. It is there from page load — before any of the heavy chunks
are fetched — so a catalogue with nothing runnable in it still has a way to the prompt, and it hides
itself while the window is on screen. It replaced a pill pinned to the bottom-right corner of every
page: that overlapped the tree and the footer, reported the terminal's readiness and session count
from somewhere that was not the terminal, and could not be dismissed. Readiness, the session count
and loading progress are now in the window's own status row, and minimizing collapses that same
window to its own title bar rather than handing you a different control.

**Confirmations.** Starting a second session and restarting one are asked for inside the terminal
window — a focus-trapped `role="alertdialog"` in the window's own colours, with Cancel focused and
Escape cancelling. Nothing in the playground calls `window.confirm()`, `alert()` or `prompt()`; a
browser-test monkeypatches all three to throw. At the session ceiling the menu row says so instead
of raising a question whose "yes" cannot succeed.

**More than one block.** A page has one window, one interpreter and one session limit, so every
Python-enabled block on it must declare the **same** `python` stanza apart from its catalogue —
`profile`, `autostart`, `maxSessions`, `initialSource`, `playgroundOrigin` and every `terminal`
key. Two blocks that disagree are a build error (`FP1215`) naming the key and both blocks, rather
than a precedence rule that answers a question you did not know you had asked. A block with no
`python` stanza beside one that has it stays Copy-only, which is not a disagreement.

Registered examples are named `<block instance>/<node id>/<example id>`, each segment
percent-escaped. The block instance is in there because node ids are unique within a _catalogue_
and a page may carry two: without it, two archives that both call a node `cmip6/tas` minted one
name twice and the later block silently won.

**What it costs.** The interpreter, the terminal and jQuery Terminal are behind
a dynamic import: a visitor who never presses the button downloads none of them,
and `autostart` is what trades that for a warm interpreter. A second session is
a second WebAssembly heap, so it is asked for rather than offered, and two is
the hard ceiling. With `python` absent or `enabled: false` the block is
Copy-only: no chunk, no Worker, no frame, and **the artifact's
Content-Security-Policy is not widened** — which is checked against built output
in `tests/artifact/python-playground.test.ts`.

**Give the interpreter its own origin.** Without `playgroundOrigin`, visitor
Python — and anything it installs at the prompt — runs with the portal's origin
authority: its cookies where CORS allows, its IndexedDB, its Cache Storage. With
one, the portal's policy gains a single `frame-src` entry and nothing else.

**Hosting the runtime yourself.** `runtimeIndexUrl` points the interpreter at a
directory you serve instead of the pinned CDN — for a network that does not reach
one, or a deployment that will not depend on one. Mirror the release
`@freva-org/browser-python` pins, keep the trailing slash, and the recorded
Content-Security-Policy names your origin instead: in `script-src` as well as
`connect-src`, because `pyodide.mjs` is a module the interpreter _imports_ and
not only bytes it fetches. A loopback `http://` origin is accepted here (and for
`playgroundOrigin`) so a development server and an acceptance run can use one;
every other origin must be HTTPS.

### The generated playground artifact

You do not write the playground page. Setting `playgroundOrigin` makes the build
emit one, into `playground-origin/` of the artifact, containing:

| File          | What it is                                                                                                                                                                  |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.html`  | The playground document. Its configuration and its example manifest travel in `application/json` blocks; there is no inline script, so the origin needs no `unsafe-inline`. |
| `deploy.json` | The exact list of files to copy, the origin they belong at, and the response headers that origin must send.                                                                 |
| `README.md`   | The same thing in prose, with the command.                                                                                                                                  |

The manifest registers every runnable example on the portal with its `id`,
`datasetId`, `title`, `source` and `sha256`. The document verifies each digest
against its own source **before** it imports the console or creates an
interpreter: a manifest that disagrees with itself refuses to start rather than
serving the entries that happen to be right. A run request from the portal
carries an id and a digest and never source, and an id this build did not
register — or a known id under a digest it did not register it under — is
refused and said so.

Deploy it, and only it:

```bash
jq -r '.files[]' <artifact>/playground-origin/deploy.json \
  | rsync -a --files-from=- <artifact>/ <playground-root>/
mv <playground-root>/playground-origin/index.html <playground-root>/index.html
```

`deploy.json` lists the child page, its entry chunk, the console, the bridge,
the terminal library and the interpreter's Worker — that last one by name,
because the bundler emits it beside the module graph and no import edge reaches
it. Nothing of the portal is in the list, which is checked against the built
output in `tests/artifact/playground-origin.test.ts`.

The headers in `deploy.json` include the child's own
Content-Security-Policy: `default-src 'none'`, `frame-ancestors` naming the
portal and only the portal, `script-src 'self' 'wasm-unsafe-eval'` (which
permits compiling WebAssembly and neither `eval` nor `new Function`),
`worker-src 'self' blob:`, `connect-src` reaching the runtime index, and
`style-src-attr 'unsafe-inline'` — the one style grant, because jQuery Terminal
sets style attributes on the markup it builds. `style-src` itself stays `'self'`:
no `<style>` element and no stylesheet from anywhere else. Each of those grants
is checked by removing it in a real browser and watching what breaks, in
`browser-tests/python-real-interpreter.mjs`.

One origin per portal: the artifact is one document with one merged manifest, so
two landings naming different origins is a build error (`FP1216`).

**What the portal downloads in this mode.** The window chrome and the embed
bridge, and nothing else — no console, no jQuery Terminal, no Prism, no Worker,
no runtime. That is a property of the emitted chunk graph rather than of a
branch at run time: the build writes one literal import for the topology it was
configured with, and the parent's graph is checked for the absence of the rest.

## `services`

Services are named instances discriminated by `kind`, and the three kinds do not
share a URL rule:

| Kind          | URL field                                                         | Query     | Trailing slash  | Credentials                    |
| ------------- | ----------------------------------------------------------------- | --------- | --------------- | ------------------------------ |
| `databrowser` | `baseUrl` — the complete API root the adapter appends to          | forbidden | normalized away | `none`, `optional`, `required` |
| `stac`        | `catalogUrl` — an exact resource URL the adapter never appends to | allowed   | preserved       | `none` in v1                   |
| `auth`        | `baseUrl` — the complete auth-broker v2 root                      | forbidden | normalized away | not applicable                 |

All three refuse fragments, user-info, protocol-relative URLs, backslashes and
non-loopback HTTP. Plain HTTP is accepted only by `dev`, and only for loopback.
A root-relative URL such as `/api/data` is an origin-root URL and is never
prefixed by the site base path.

Service configuration must not contain credentials. Frontend artifacts are
public, and the builder refuses values that look like secrets.

## `components`

```yaml
components:
  data:
    kind: databrowser
    enabled: true
    service: dataApi
    route: /data/
    options:
      defaultFlavour: freva
      fixedFacets: { project: example }
```

The key (`data`) is your instance id; `kind` selects the registry entry. An
enabled component must reference a valid service of the required kind. A disabled
one needs no service. v1 allows at most one enabled instance per kind, because the
current auth and STAC integrations use page-global state; lifting that is a
component change with multi-instance tests, not a schema edit.

See [components.md](./components.md) for each kind's options.

## `announcements`

```yaml
announcements:
  - id: winter-maintenance
    message: The archive is read-only during the maintenance window.
    level: warning
    dismissible: true
    startsAt: "2026-01-05T08:00:00Z"
    endsAt: "2026-01-09T18:00:00Z"
```

A dated announcement is selected **during the build**, against the explicit
`--effective-at` instant, which is recorded in the input manifest. Inclusion is
`startsAt <= effectiveAt < endsAt`. Crossing a boundary therefore requires a
scheduled build and deployment — inconvenient exactly once, and correct every
time, because nothing depends on an unrecorded browser clock. `SOURCE_DATE_EPOCH`
is a separate input for archive timestamps and never doubles as this.

A small client island may remember that a reader dismissed an announcement. It
cannot decide whether one exists.

## `trustedSubsites`

See the [consumer guide](./consumer-guide.md#documentation-that-outgrows-the-portal)
and [`subsite-policy.schema.json`](../schema/subsite-policy.schema.json). The
policy accepts no raw CSP, no script origin, no `unsafe-inline`, no `unsafe-eval`
and no consumer JavaScript. `connectOrigins` and `frameOrigins` list _additional_
exact HTTPS origins; same-origin connections are already permitted by the
profile, which is precisely why a team that needs isolation should use a separate
origin instead.

## Retired runtime fields

`html-fragment`, `sandbox-html`, `public_extensions`, `uiId` and
`deployment-config.json` have no build-time representation. Each occurrence is
reported with its supported replacement rather than silently dropped. See
[migration.md](./migration.md).
