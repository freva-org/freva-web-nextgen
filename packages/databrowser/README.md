# @freva-org/databrowser

[![npm](https://img.shields.io/npm/v/@freva-org/databrowser)](https://www.npmjs.com/package/@freva-org/databrowser)
[![CI](https://github.com/freva-org/freva-web-nextgen/actions/workflows/ci.yml/badge.svg)](https://github.com/freva-org/freva-web-nextgen/actions/workflows/ci.yml)
[![License: BSD 3-Clause](https://img.shields.io/badge/License-BSD--3--Clause-yellow.svg)](../../LICENSE)

Framework-free, strictly-typed climate-data browser for the `freva-nextgen` REST API. Its only
runtime dependency is the first-party [`@freva-org/freva-client-terminal`](../freva-client-terminal),
which owns the terminal window; there are **no third-party runtime dependencies**. Single mount point, self-contained styles, near-total teardown (one
documented page-global exception for the opt-in Leaflet map - see below).

## Install

```bash
npm install @freva-org/databrowser
```

## Quick start

```ts
import { mountDataBrowser } from "@freva-org/databrowser";

const handle = mountDataBrowser(document.getElementById("app")!, {
  apiBase: "/api/freva-nextgen/databrowser", // default
  flavour: "freva", // default lens
  authEnabled: false, // heavy ops show disabled placeholders when off
  getAuthToken: () => null, // OIDC bearer supplier when authEnabled
  // carve-outs, off by default until verified against a live backend:
  enableStrictBBoxModes: false, // strict/file time+bbox semantics
  devNotes: false, // opt-in developer drawer
  // metadata.js (facet value descriptions):
  metadata: undefined, // { facetKey: { value: 'human description' } } - config wins
  metadataScriptUrl: "/static/js/metadata.js", // deployment script; pass null to disable (config-only)
});

handle.destroy(); // removes the root, flushes every listener/timer/in-flight request
handle.getState(); // Readonly<AppState>
handle.setTheme("night"); // drive light/dark from a host control (fires theme.onModeChange)
```

The mount target must have a definite height (the component fills it); a full-viewport host uses
`100vh`.

### Teardown exception (page globals)

`destroy()` returns the mount to a clean state - DOM removed, listeners/timers/requests flushed -
with one deliberate exception: if the user opted into the Leaflet map (the on-demand "Zoom"
upgrade), Leaflet's stylesheet, its `window.L` global, and the Leaflet custom-element registration
are page-global and intentionally survive teardown, so a later re-mount reuses them instead of
re-fetching the library. This is standard for a page-global script dependency and is why the map
upgrade is gesture-gated (nothing loads until the user asks). If you never enable the map, nothing
page-global is ever installed.

## Configuration

| Option                  | Type                                                                                                 | Default                          | Description                                                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `apiBase`               | `string`                                                                                             | `/api/freva-nextgen/databrowser` | Base URL of the `freva-nextgen` databrowser REST API                                                                  |
| `flavour`               | `FlavourName`                                                                                        | `freva`                          | Default metadata lens                                                                                                 |
| `authEnabled`           | `boolean`                                                                                            | `false`                          | When off, heavy/auth-gated operations render as disabled placeholders                                                 |
| `getAuthToken`          | `() => string \| null`                                                                               | `() => null`                     | OIDC bearer-token supplier, used when `authEnabled`                                                                   |
| `enableHeavyOps`        | `boolean`                                                                                            | `false`                          | Data-portal heavy ops (load / zarr convert / status / share / inspect) require this in addition to `authEnabled`      |
| `getCsrfToken`          | `() => string \| null`                                                                               | -                                | Optional; sends `X-CSRFToken` on mutating requests only when provided                                                 |
| `enableStrictBBoxModes` | `boolean`                                                                                            | `false`                          | Config back-compat flag for strict/file bbox semantics                                                                |
| `syncUrl`               | `boolean`                                                                                            | `true`                           | Mirror the active query into the page URL and read it back on load (deep links)                                       |
| `baseFilters`           | `Record<string, string \| string[]>`                                                                 | -                                | Always-applied client-side scope for a hosted filtered instance - positive and/or `_not_` keys (not an auth boundary) |
| `inspectorUrl`          | `string`                                                                                             | CDN default                      | ESM URL for the lazy `@freva-org/data-inspector` component (self-host for air-gapped)                                 |
| `brand`                 | `{ title?, mark?, description?, showMark?, showTitle? }`                                             | `Freva` / `≈`, both shown        | Brand title, mark, description; `showMark`/`showTitle` hide either half independently                                 |
| `devNotes`              | `boolean`                                                                                            | `false`                          | Opt-in developer drawer + `window.__frevaPerf` instrumentation                                                        |
| `metadata`              | `{ [facetKey]: { [value]: string } }`                                                                | `undefined`                      | Facet-value descriptions; overrides the deployment script per (key, value)                                            |
| `metadataScriptUrl`     | `string \| null`                                                                                     | `/static/js/metadata.js`         | An asset for facet descriptions; `null` = config only                                                                 |
| `theme`                 | `{ both?, day?, night? }`                                                                            | -                                | Per-token colour overrides (see Theming)                                                                              |
| `features`              | `{ themeToggle, terminal, overview, export, details, search, lensSwitcher, inspect, brand, footer }` | all `true`                       | Feature gating - every flag defaults to on                                                                            |

### Handle

`mountDataBrowser` returns a handle:

| Member     | Signature                          | Description                                                       |
| ---------- | ---------------------------------- | ----------------------------------------------------------------- |
| `destroy`  | `() => void`                       | Removes the root and flushes every listener, timer, and request   |
| `getState` | `() => Readonly<AppState>`         | Current application state                                         |
| `setTheme` | `(mode: "day" \| "night") => void` | Drive light/dark from a host control (fires `theme.onModeChange`) |

## Theming

All palette colours are CSS custom properties on the root and are embedder-adjustable two ways:
(a) the `theme` mount-config section, or (b) setting the CSS variables directly on `.freva-db`.
Documented tokens (each `--<token>`): `bg`, `surface`, `surface-2`, `surface-3`, `text`, `dim`,
`faint`, `border`, `border-2`, `accent`, `accent-2`, `accent-soft`, `good`, `warn`, `danger`,
`ocean`, `land`.

```js
theme: {
  both: { accent: "#4f8df7" },
  night: { bg: "#0a1120" },
  day: { bg: "#ffffff" },
}
```

`both` applies to both themes; `day` / `night` win per token. Any omitted token keeps its default.

## metadata.js - facet value descriptions

Facet **values** can carry human descriptions from two optional sources, both degrading silently
when absent:

- **Mount config** - a `metadata` object shaped `facetKey -> (value -> description)`
  (e.g. `{ project: { cmip6: "Coupled Model Intercomparison Project 6" } }`).
- **Deployment script** - `metadataScriptUrl` (default `/static/js/metadata.js`). Only an
  allow-list of known facet keys is read off the global, and only when the value is a plain
  `string -> string` block; arbitrary globals are ignored. Pass `metadataScriptUrl: null` to load
  from config only.

**Config wins per (key, value):** the deployment script fills gaps, the config object overrides on
conflicts. Descriptions surface as hover tooltips on facet value rows (sidebar and overview); every
description reaches the DOM via `textContent`. Resolution is async and non-blocking - the config
object is applied synchronously at mount, the script merges under it when it lands.

## The compact data picker (`@freva-org/databrowser/picker`)

A lab application usually does not want a data _browser_. It wants the user to choose some data and
get back to what they were doing. `mountDataPicker` is that: a small panel with value-first search,
compact Include/Exclude facet filters, a lean file list and one primary action.

It ships as a **subpath of this package**, not a separate package, because it shares the query
boundary with the full browser (see "Two decisions worth knowing" below). Its
entry imports **none** of the terminal, overview, inspector, details panel, brand, footer, export
menus or the full stylesheet - `tests/picker-import-graph.test.ts` walks the built module graph and
fails if any of them reappear.

```ts
import { mountDataPicker, isDataReference } from "@freva-org/databrowser/picker";

const picker = mountDataPicker(document.getElementById("picker")!, {
  apiBase: "/api/freva-nextgen/databrowser",
  commitLabel: "Add to experiment",
  baseFilters: { project: "waterpark" }, // same scope semantics as the full browser
  features: { time: true }, // flavour / time / bbox are opt-in
  initialState: JSON.parse(sessionStorage.getItem("picker") ?? "null") ?? undefined,
  onStateChange: (state) => sessionStorage.setItem("picker", JSON.stringify(state)),
  onCommit: (ref) => {
    // ref is a versioned DataReference: kind "asset" | "selection" | "query"
    if (ref.kind === "query")
      experiment.addQuery(ref.query); // re-run it server-side
    else if (ref.kind === "asset") experiment.addFiles([ref.asset.uri]);
    else experiment.addFiles(ref.assets.map((a) => a.uri));
  },
});

// Accepting a drop is the same contract, one guard:
dropZone.addEventListener("drop", (e) => {
  const raw = e.dataTransfer?.getData("application/vnd.freva.data-reference+json");
  const ref: unknown = raw ? JSON.parse(raw) : null;
  if (isDataReference(ref)) experiment.add(ref);
});

picker.getReference(); // exactly what the primary action would deliver right now, or null
picker.destroy();
```

The mount target needs a **definite height**, like the full browser. Without one the picker grows to
its content and the file list cannot scroll (a `max-height: 100vh` safety cap bounds the worst case,
but it is a fallback, not the intended layout).

### Configuration

| Option          | Type                                         | Default                           | Description                                                                      |
| --------------- | -------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------- |
| `apiBase`       | `string`                                     | `/api/freva-nextgen/databrowser`  | Base URL of the databrowser REST API                                             |
| `flavour`       | `string`                                     | `freva`                           | Metadata lens                                                                    |
| `baseFilters`   | `Record<string, string \| string[]>`         | -                                 | Always-applied scope; positive and `_not_` forms, exactly as in the full browser |
| `commitLabel`   | `string`                                     | `Add selection`                   | Label and accessible name of the primary action                                  |
| `initialState`  | `Partial<PickerState>`                       | -                                 | Restore a previous session; unknown fields are ignored, never thrown on          |
| `onStateChange` | `(state: PickerState) => void`               | -                                 | Serialisable snapshot whenever the question or the selection changes             |
| `onCommit`      | `(ref: DataReference) => void`               | -                                 | The primary action, or a drag the host accepted                                  |
| `client`        | `SearchClient`                               | freva-rest                        | Inject a transport (mock, proxy, cache)                                          |
| `getAuthToken`  | `() => string \| null`                       | -                                 | Bearer supplier for the **default** client only; never stored in picker state    |
| `features`      | `{ flavour, time, bbox, allFiltered, drag }` | `false, false, false, true, true` | Optional controls                                                                |
| `theme`         | `"day" \| "night"`                           | `day`                             | Initial mode; `handle.setTheme` switches it later                                |
| `overlayRoot`   | `HTMLElement`                                | the picker root                   | Where anchored overlays go. The default survives transformed/clipped hosts       |
| `debounceMs`    | `number`                                     | `250`                             | Search debounce - the same default as the full browser                           |

The handle exposes `getState()`, `setState()`, `getReference()`, `setTheme()` and `destroy()`.
`PickerState` is **not** `AppState`: it is a small, versioned (`version: 1`), JSON-serialisable
object holding the flavour, the facet selection (including `_not_` keys), time/bbox, the search text
and the chosen files. The picker never touches `window.location`.

### Selections are durable snapshots

`state.assets` holds full `AssetReference` snapshots, not row keys. That is what makes a selection
survive filtering, paging, a lens change and restoration: nothing about a chosen file needs the
result list to still contain its row. Consequently

- `getReference()` never returns a partial selection, and the Add button is enabled **exactly**
  when `getReference()` is non-null;
- everything handed to a host is a deep copy - including the nested `stac` locator - so mutating a
  reference or a state snapshot cannot reach inside the picker;
- restoring `assets` works before any row has loaded;
- there is no `truncated` flag - a reference that could not represent the whole selection is not
  emitted at all.

Restoration sanitises each asset (a snapshot with no usable URI is dropped), deduplicates by id and
caps at 25.

### Scope, in the UI as well as on the wire

`baseFilters` behaves exactly as in the full browser, and the picker now enforces it where the user
can see it:

- a **positive** scope (`{ project: "waterpark" }`) OWNS `project`. Its facet renders locked, showing
  only in-scope values and offering no toggle at all; the key cannot be chipped, autocompleted,
  excluded, restored through `initialState`, or set through `setState`. An inert filter - present in
  state, absent from the request - cannot be created.
- a **negative** scope (`{ project_not_: "cmip6" }`) owns nothing. Its excluded values never appear
  in the facet list at all, so it is shown as an immutable `Scope: project ≠ cmip6` indicator, and
  further narrowing (`project=cordex`, or another exclusion) stays fully available.
- **Clear all** clears the user's question. It never clears the scope.

### Custom flavours fail closed

A **custom** (non-builtin) flavour combined with `baseFilters` needs that flavour's facet-key
mapping before any request can be scoped correctly - the scope's keys are freva-canonical, and a
custom index may call `project` something else. Until the mapping is known the picker issues **no
search at all** and says `Preparing scoped browsing…`; if it cannot be loaded, it shows an error and
still issues none. A request that is silently unscoped is worse than no request.

The default REST client fetches this itself. An **injected `client`** has no such endpoint, so pass
`resolveFlavourMaps` (it may return the array or a promise):

```ts
mountDataPicker(el, {
  client: myTransport,
  flavour: "custom",
  baseFilters: { project: "waterpark" },
  resolveFlavourMaps: () => [{ flavour_name: "custom", mapping: { project: "dataset" } }],
});
// → one request: …/extended-search/custom/file?translate=true&max-results=100&dataset=waterpark
```

Builtin flavours and unscoped instances never wait: the gate is about the scope, not the lens.

### Changing the lens is atomic

Switching flavour re-keys the selection through the same suffix-aware translator the full browser
uses (`project_not_=cmip5` → `mip_era_not_=cmip5`) rather than discarding it, and explicit asset
picks are untouched - they are concrete files and have nothing to do with the metadata lens.

If entering the new lens needs a mapping that has not arrived, **nothing happens yet**: the last
valid flavour and selection are preserved, no request goes out, and the list says
`Preparing scoped browsing…`. When the mapping lands, the translation, the scope sanitisation, the
state notification, the repaint and exactly one request happen together. If it never lands, the
picker keeps the last valid state and shows the error.

`setState` follows the contract that `selected` is expressed in the flavour it ships with:

| Call                              | Behaviour                                                              |
| --------------------------------- | ---------------------------------------------------------------------- |
| `setState({ flavour, selected })` | keys are taken **verbatim** - the host already wrote them in that lens |
| `setState({ flavour })`           | the existing selection is **translated** into the new lens             |
| `setState({ selected })`          | same lens; nothing to translate                                        |

### Feature flags are enforced in state

`features.allFiltered: false` does not merely hide the control: `useAllFiltered` cannot be set
through `initialState` or `setState` either. A hidden control can never drive a hidden action.
Query mode and an explicit selection are always mutually exclusive.

### Keyboard and assistive technology

The file list is a real `listbox`. The **listbox** holds focus and the active option is addressed
with `aria-activedescendant` - the canonical pattern for a recycling list, where a per-row
`tabindex` would put focus on a node the next scroll destroys. Arrow Up/Down, Home/End, Enter and
Space are all implemented, focus never moves off the list, and the windowing wrappers are
`role="presentation"` (never `aria-hidden`), so every materialised option is exposed as a child of
the listbox.

### The `DataReference` contract

One versioned, discriminated union crosses the boundary - identically for a drop and for `onCommit`:

| Kind        | Carries                                                  | When                                |
| ----------- | -------------------------------------------------------- | ----------------------------------- |
| `asset`     | one `AssetReference` (uri + optional fsType/format/STAC) | exactly one file is selected        |
| `selection` | up to 25 `AssetReference`s                               | several files are explicitly ticked |
| `query`     | the `EffectiveSearchQuery`                               | "use all N filtered results"        |

`query` exists so that "everything matching this filter" stays bounded: a 41,253-file answer is a
query the host can re-run, never 41,253 URIs in a drag payload. Explicit selections are hard-capped
at 25 in the UI, the contract and the runtime guard.

A `query` reference is only offered when it **describes a real, current search**: the flavour must be
mappable, the visible result must belong to the engine's current query revision, and the count must
be a positive integer from a search that actually succeeded. Change the filters, lose the mapping or
fail the request and the "use all filtered results" control disables itself, the stale number
disappears, and `getReference()` returns `null`. Explicit asset references are unaffected - the files
the user already chose do not depend on the current search.

Alongside the JSON payload, a **single, fetchable http(s)** asset also populates `text/uri-list`, in
canonical (parsed) form. Other schemes - `swift:`, `s3:`, and emphatically `javascript:`, `data:` and
`file:` - travel in full inside the `DataReference` and the `text/plain` description but are never
offered as URLs, because `text/uri-list` is a handoff the drop target may follow.

**The runtime guard and the JSON Schema accept and reject exactly the same documents.** Every object
in the contract is closed - `additionalProperties: false` throughout, `unevaluatedProperties: false`
at the top level where the `oneOf` branches contribute the kind-specific properties - and the guard
enforces the same closure plus the same value rules (`stac` fields are strings, `estimatedCount` is
a non-negative integer). `tests/picker-schema-parity.test.ts` runs both against one fixture corpus
with a real draft-2020-12 validator. That validator is a **dev-only** dependency; the shipped
package gains no runtime validator.

**No reference ever contains a credential.** Closed objects make that structural - a credential
field is simply an unknown property - and `isDataReference()` additionally names the failure. A test
asserts that a configured bearer token appears in neither `getState()`, `getReference()`, nor any
`DataTransfer` slot. A `DataTransfer` is readable by whatever page the user drops onto, so this is a
security property, not tidiness.

Alongside the JSON payload, a single **remote** asset also populates `text/uri-list`, and every kind
populates a human-readable `text/plain`. A POSIX archive path is deliberately _not_ offered as a URI.

Dragging is optional convenience. The primary action performs the identical operation, is a real
`<button>`, and reports an accurate accessible name - WCAG 2.2 _Dragging Movements_: no function may
require a dragging gesture. Rows are focusable and selectable with Enter/Space, and focus survives
the selection.

Also exported: `FREVA_DATA_REFERENCE_MIME`, `DATA_REFERENCE_JSON_SCHEMA` (for hosts validating with
their own tooling, possibly in another language), `parseDataReference`, `uriListFor`,
`describeReference`, and the shared search boundary (`effectiveSearchQuery`, `buildSearchUrl`,
`createSearchEngine`, `createRestSearchClient`, `rankValueMatches`) for a host that has its own UI
but wants this package's exact query construction.

## Contract notes

`load/{flavour}` is a **GET**; time is sent **unbracketed** (`time=<from> TO <to>` + `time_select`);
catalogue export requests `max-results=100000` and handles the exact 413 detail
`"Result stream too big."`, disabling export past 100,000 files. Browsing never fetches per-file
metadata - the Details panel fetches it lazily via a `?file=` call. All API/user strings reach the
DOM via `textContent`; the terminal overlay escapes every token.

## Two decisions worth knowing

**The picker lives here, not in its own package.** It shares `src/search/*` with the browser. That
code encodes a freva-rest contract - the `_not_` negation suffix, server-side flavour translation,
the base-scope merge - which drifts silently the moment it is copied elsewhere.

**A landing page should call freva-rest directly, not mount this.** A mounted browser is a UI, not
an API: it injects a stylesheet, builds hundreds of nodes and owns the page URL. Use
`metadata-search` / `extended-search` for a search box.

## Source layout

- `src/types.ts` - wire shapes + view model + public surface, including `QueryScope`
- `src/api.ts` - typed fetch wrappers (abort-per-channel, monotonic request ids)
- `src/state.ts` - AppState, selectors, wire->view, the facet algebra and query builders
- `src/commands.ts` - the copyable `freva-client` CLI command builders (shell dialects)
- `src/search/*` - the **shared, DOM-free search boundary**: `query.ts` (effective query + URL),
  `engine.ts` (debounce / abort / stale-response), `client.ts` (default freva-rest transport),
  `rank.ts` (value-match ranking). Used by both the full browser and the picker.
- `src/dom.ts` - escaping, `el()` (no innerHTML hatch), `Disposables` registry
- `src/index.ts` - `mountDataBrowser` controller (shell DOM, search loop, wiring)
- `src/components/*` - sidebar, chips, results, pickbar, overview, details, terminal, autocomplete,
  timeEditor, bboxEditor, notes
- `src/picker.ts` + `src/picker/*` - the `@freva-org/databrowser/picker` subpath entry
- `src/styles.css` / `src/picker.css` - readable styling sources; `src/styles.ts` and
  `src/picker/styles.ts` are the generated injectable strings

## Development

```bash
npm install
npm run build       # emits dist/ (JS + .d.ts + maps)
npm test            # type-checks tests then runs node --test (pure-fn + DOM/integration via jsdom)
npm run typecheck   # tsc --strict --noEmit
npm run gen:styles  # regenerate the generated stylesheet modules from their .css sources
npm run test:browser        # real-Chromium layout suites (see browser-tests/README.md)
npm run test:browser:strict # …with a missing engine treated as a failure, not a skip
```

`src/styles.ts` and `src/picker/styles.ts` are **generated** - never edit them by hand; edit
`styles.css` / `picker.css` and re-run `npm run gen:styles`. `jsdom` is a devDependency only (tests). The shipped component imports one
first-party package, `@freva-org/freva-client-terminal` (which ships its own stylesheet, injected
into the terminal window's own root), and nothing third-party.

### Building in this workspace

`@freva-org/databrowser` is compiled against `@freva-org/freva-client-terminal`'s build output, so
that package must be built first. `typecheck` and `build` establish this automatically via
`npm run build:deps`, and `test` runs a full `npm run build` first - both because of the dependency
and because `tests/picker-import-graph.test.ts` measures the SHIPPED `dist/`, and a test that
silently skips when the artifact is missing proves nothing. So a direct

```bash
npm run test -w @freva-org/databrowser
```

works from a clean checkout with no manual ordering. The root `build` script also builds the
terminal explicitly before iterating the workspaces, so the order does not depend on how npm happens
to enumerate them.

## Scoping an instance with `baseFilters`

`baseFilters` makes a mount behave as if a subset of the archive were the whole archive. Keys are
**freva-canonical** and are translated suffix-aware when the flavour changes.

```js
// POSITIVE - the scope OWNS `project`
mountDataBrowser(el, { baseFilters: { project: "waterpark" } });

// NEGATIVE - the scope narrows `project` without owning it
mountDataBrowser(el, { baseFilters: { project_not_: ["cmip6", "cordex"] } });
```

| Form                        | Sent on every query | Owns the key                                              | Shown as                                                 |
| --------------------------- | ------------------- | --------------------------------------------------------- | -------------------------------------------------------- |
| `{ project: "waterpark" }`  | yes                 | **yes** - no user include or exclude on `project` is sent | the value renders **locked** in the sidebar and overview |
| `{ project_not_: "cmip6" }` | yes                 | **no** - the user can still narrow with `project=cordex`  | an immutable `Scope: project ≠ cmip6` indicator          |

A base-_excluded_ value never comes back in the facet list, so there is no row to lock - hence the
scope indicator instead. Neither form is a removable chip, neither is written to the URL, and
**"Clear all" removes neither**.

> **This is client-side scoping, not an authorization boundary.** It shapes what _this UI_ sends and
> shows. It does not stop anyone calling the API directly. Enforce real tenant isolation on the
> server or in an auth proxy.

## Excluding facet values

Every facet value carries two controls: the row itself **includes** it, and the `≠` control beside it
**excludes** it. Exclusions are sent as freva-rest's unambiguous key form, `project_not_=cmip6`, and
round-trip through the URL, the copied CLI command, the python call and the terminal.

A `(facet, value)` can never be both included and excluded: choosing one mode removes it from the
other and commits a single search.

> **Known backend limitation.** freva-rest _also_ accepts negation written into the value
> (`project="not cmip6"`, `!cmip6`, `-cmip6`). This client neither reads nor writes that form, because
> a real value can begin the same way - `ensemble` genuinely has the value `not set`. Such a value is
> therefore sent verbatim under its positive key, and freva-rest will still read it as a negation.
> No client-side workaround can fix that; it needs an escaping rule in the REST API.

## Optional chrome

The top-bar brand and the status footer can be removed independently:

```js
mountDataBrowser(el, {
  brand: { showMark: true, showTitle: false }, // keep the mark, drop the wordmark
  features: { footer: false }, // remove the status strip entirely
});
```

With `features.footer:false` the strip consumes **no height**, but status and toasts keep working:
the status message moves to an off-screen `aria-live` region, so screen-reader feedback is preserved
rather than silenced by `display:none`. Set `brand.description: ""` to omit the result-set
description, as before.
