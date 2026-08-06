# @freva-org/data-inspector

## 2608.0.0

_Adopts CalVer (`YYMM.MINOR.PATCH`). Supersedes 3.2.0; no functional difference._

### Minor Changes

- Fix the GridLook regression and improve `<data-inspector>` layout, theming and accessibility.
- the Zarr URL is passed RAW in the viewer fragment again; encoding it broke GridLook ("No data available").
- The error banner shows on its own; entering the error state returns to the metadata tab.
- GridLook Refresh reliably reloads - it recreates the iframe from `zarr-url` and resets the URL cache.
- The duplicate header **Zarr:** row is suppressed when the input is already a Zarr store.
- stable dialog width (`min(1100px, 96vw)`), body scrolls in a fixed frame, metadata left-aligned at full width, long attribute values wrap.
- host-adjustable CSS custom properties: `--di-bg`, `--di-fg`, `--di-muted`, `--di-border`, `--di-surface`, `--di-accent`. Host values win; `prefers-color-scheme: dark` is only a fallback.
- `role="dialog"` + `aria-modal` + `aria-labelledby`, focus trap and restore, <kbd>Escape</kbd> to close, `role="tab"`/`tablist`/`tabpanel`, `aria-label` on close.
- Harden and rework the `<data-inspector>` web component.
- `error` and aggregation `file` paths render as text; the iframe `src` is set via the DOM property; the iframe is sandboxed with `referrerpolicy="no-referrer"`.
- changing `file` resets stale `output` / `zarr-url` / `error` / active tab.
- chrome, metadata container and iframe are built once and patched by delta instead of rewriting `innerHTML`; scroll position, expand/collapse state and caret survive updates.
- ships its own modal CSS and inline SVG icons, so the chrome needs no Bootstrap or Font Awesome. Internal class names `token-*` -> `di-*`.
- Support nested / multi-group Zarr stores in the client-side metadata parser.

## 3.1.0

### Minor Changes

- Add client-side Zarr tooling, mirroring the latest freva-web REST/data-loader changes:
  - `detectZarrStore(url, options?)` - probe a URL for an existing Zarr store (v2 `.zmetadata` / v3 `zarr.json`) so hosts can skip server-side conversion.
  - `loadZarrMetadataHtml(url, options?)` plus `openDatasetMeta`, `buildXarrayRepr`, and `injectXarrayCss` - parse a store's consolidated metadata in the browser and render the xarray-style HTML repr, replacing the removed server `/zarr-utils/html` endpoint.
  - `ZarrPoller`'s `onStatus` callback now receives the status endpoint's optional `reason` string as a second argument: `onStatus(statusCode, reason)`. Existing callers that ignore the extra argument are unaffected.

## 3.0.0

### Major Changes

- 2f3f4b6: A Typescript web client component for data-loader endpoints to stream the dataset into zarr store and demonestrate them
