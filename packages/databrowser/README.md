# @freva-org/databrowser

[![npm](https://img.shields.io/npm/v/@freva-org/databrowser)](https://www.npmjs.com/package/@freva-org/databrowser)
[![CI](https://github.com/freva-org/freva-web-nextgen/actions/workflows/ci.yml/badge.svg)](https://github.com/freva-org/freva-web-nextgen/actions/workflows/ci.yml)
[![License: BSD 3-Clause](https://img.shields.io/badge/License-BSD--3--Clause-yellow.svg)](../../LICENSE)

Framework-free, strictly-typed, **zero runtime dependencies** climate-data browser for the
`freva-nextgen` REST API. Single mount point, self-contained styles, near-total teardown (one
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

| Option                  | Type                                                                                         | Default                          | Description                                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `apiBase`               | `string`                                                                                     | `/api/freva-nextgen/databrowser` | Base URL of the `freva-nextgen` databrowser REST API                                                             |
| `flavour`               | `FlavourName`                                                                                | `freva`                          | Default metadata lens                                                                                            |
| `authEnabled`           | `boolean`                                                                                    | `false`                          | When off, heavy/auth-gated operations render as disabled placeholders                                            |
| `getAuthToken`          | `() => string \| null`                                                                       | `() => null`                     | OIDC bearer-token supplier, used when `authEnabled`                                                              |
| `enableHeavyOps`        | `boolean`                                                                                    | `false`                          | Data-portal heavy ops (load / zarr convert / status / share / inspect) require this in addition to `authEnabled` |
| `getCsrfToken`          | `() => string \| null`                                                                       | -                                | Optional; sends `X-CSRFToken` on mutating requests only when provided                                            |
| `enableStrictBBoxModes` | `boolean`                                                                                    | `false`                          | Config back-compat flag for strict/file bbox semantics                                                           |
| `syncUrl`               | `boolean`                                                                                    | `true`                           | Mirror the active query into the page URL and read it back on load (deep links)                                  |
| `baseFilters`           | `Record<string, string \| string[]>`                                                         | -                                | Always-applied client-side scope for a hosted filtered instance (not an auth boundary)                           |
| `inspectorUrl`          | `string`                                                                                     | CDN default                      | ESM URL for the lazy `@freva-org/data-inspector` component (self-host for air-gapped)                            |
| `brand`                 | `{ title?, mark?, description? }`                                                            | `Freva` / `≈`                    | Brand title, mark, and description shown in the shell                                                            |
| `devNotes`              | `boolean`                                                                                    | `false`                          | Opt-in developer drawer + `window.__frevaPerf` instrumentation                                                   |
| `metadata`              | `{ [facetKey]: { [value]: string } }`                                                        | `undefined`                      | Facet-value descriptions; overrides the deployment script per (key, value)                                       |
| `metadataScriptUrl`     | `string \| null`                                                                             | `/static/js/metadata.js`         | An asset for facet descriptions; `null` = config only                                                            |
| `theme`                 | `{ both?, day?, night? }`                                                                    | -                                | Per-token colour overrides (see Theming)                                                                         |
| `features`              | `{ themeToggle, terminal, overview, export, details, search, lensSwitcher, inspect, brand }` | all `true`                       | Feature gating - every flag defaults to on                                                                       |

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

## Contract notes

`load/{flavour}` is a **GET**; time is sent **unbracketed** (`time=<from> TO <to>` + `time_select`);
catalogue export requests `max-results=100000` and handles the exact 413 detail
`"Result stream too big."`, disabling export past 100,000 files. Browsing never fetches per-file
metadata - the Details panel fetches it lazily via a `?file=` call. All API/user strings reach the
DOM via `textContent`; the terminal overlay escapes every token.

## Source layout

- `src/types.ts` - wire shapes + view model + public surface
- `src/api.ts` - typed fetch wrappers (abort-per-channel, monotonic request ids)
- `src/state.ts` - AppState, selectors, wire->view, query/CLI/Python builders
- `src/dom.ts` - escaping, `el()` (no innerHTML hatch), `Disposables` registry
- `src/index.ts` - `mountDataBrowser` controller (shell DOM, search loop, wiring)
- `src/components/*` - sidebar, chips, results, pickbar, overview, details, terminal, autocomplete,
  timeEditor, bboxEditor, notes
- `src/styles.css` - readable styling source; `src/styles.ts` - generated injectable string

## Development

```bash
npm install
npm run build       # emits dist/ (JS + .d.ts + maps)
npm test            # type-checks tests then runs node --test (pure-fn + DOM/integration via jsdom)
npm run typecheck   # tsc --strict --noEmit
npm run gen:styles  # regenerate src/styles.ts from src/styles.css
```

`src/styles.ts` is **generated** - never edit it by hand; edit `styles.css` and re-run
`npm run gen:styles`. `jsdom` is a devDependency only (tests); the shipped component imports nothing
external.
