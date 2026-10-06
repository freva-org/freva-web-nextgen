# @freva-org/data-inspector

NetCDF / Zarr file inspection dialog as a **framework-agnostic Web Component**. Works in React, Vue, Svelte, Angular, plain HTML, and Django templates - anything that can load a JS module.

> **Styling is self-contained.** The component ships its own modal CSS (injected into `<head>` once) and inline SVG icons, so its own chrome needs **no external Bootstrap or Font Awesome**. Only the aggregation-config sub-form still uses a few Bootstrap utility classes, so load Bootstrap CSS v5 if you use aggregation mode and want that form fully styled.

## Install

```bash
npm install @freva-org/data-inspector
```

## Quick start

`attachInspector` drives the element: zarr stores are read in the browser, anything else goes
through freva-rest's data-loader (convert, poll, read), with a share link for the 3D viewer.

```js
import { attachInspector, scopedBearerAuth } from "@freva-org/data-inspector";

const el = document.createElement("data-inspector");
document.body.append(el);

const inspector = attachInspector(el, {
  dataPortalBase: "/api/freva-nextgen/data-portal", // omit to read zarr stores only
  getAuthHeaders: scopedBearerAuth({
    getToken: async () => (await auth.getToken())?.accessToken ?? null,
  }),
  signIn: () => auth.login({ next: location.pathname + location.search }),
});
el.addEventListener("inspector-close", () => {
  inspector.detach();
  el.remove();
});

void inspector.load("https://s3.example.org/bucket/dataset.zarr"); // or a file path, or [paths]
el.setAttribute("open", "");
```

Call `load()` before setting `open`: it sets `status="loading"`, so opening does not submit a
second read.

xarray's repr caps at 700px. To fill the modal, lift the cap in the host page:

```css
data-inspector .xr-wrap {
  max-width: none;
}
```

| Option            | Default                         | Description                                              |
| ----------------- | ------------------------------- | -------------------------------------------------------- |
| `dataPortalBase`  | none (zarr stores only)         | freva-rest data-portal URL: conversion, share links      |
| `dataLoader`      | `true` with `dataPortalBase`    | `false`: never submit a conversion                       |
| `getAuthHeaders`  | legacy cookie, same origin only | Per-request headers, may be async - see Auth             |
| `signIn`          | -                               | Offered as a "Sign in" button when sign-in is missing    |
| `isStore`         | http(s) link or `.zarr` path    | Inputs read directly instead of converted                |
| `shareTtlSeconds` | `3600`                          | Share link lifetime                                      |
| `pollMs`          | `1500`                          | Conversion status poll interval                          |
| `startupGraceMs`  | `30000`                         | How long an early status `5` still means queued          |
| `timeoutSeconds`  | `300`                           | Conversion deadline unless the aggregation form sets one |

- **Zarr stores** are read in the browser. A store the auth hook sent a token to is protected: it
  gets a share link (`/share-zarr`), or `viewer-disabled` when none can be made. On `401`/`403`
  the store is converted if the user has a data-portal session, else `signIn` is offered.
- **Anything else** needs `dataPortalBase` and a signed-in user. A `401` at any step offers
  sign-in again.
- `load()` sets `file`, `is-aggregation` and `aggregationConfig` / `loadOptions`, so Retry
  re-submits exactly that read. A newer `load()` or `detach()` cancels every request in flight.

## Driving the element yourself

Without `attachInspector`, handle the events and set the state:

```js
import "@freva-org/data-inspector";

el.addEventListener("inspector-submit", ({ detail: { file, aggregationConfig } }) => {
  el.setAttribute("status", "loading");
  // ...fetch, then set `el.output` (trusted xarray HTML), `zarr-url`, and status "ready" / "error"
});
el.addEventListener("inspector-close", () => el.removeAttribute("open"));
el.setAttribute("open", "");
```

## Framework examples

<details>
<summary>React</summary>

```tsx
import "@freva-org/data-inspector";
import { useRef } from "react";

export function Inspector({ file }: { file: string }) {
  const ref = useRef<HTMLElement>(null);
  return (
    <data-inspector
      ref={ref}
      file={file}
      open
      onInspector-submit={(e) => handleSubmit(e.detail)}
      onInspector-close={() => setOpen(false)}
    />
  );
}
```

</details>

<details>
<summary>Vue</summary>

```vue
<template>
  <data-inspector
    :file="file"
    :open="open || undefined"
    @inspector-submit="handleSubmit"
    @inspector-close="open = false"
  />
</template>
```

</details>

## API

### `<data-inspector>` attributes

| Attribute          | Type                        | Description                                       |
| ------------------ | --------------------------- | ------------------------------------------------- |
| `open`             | boolean                     | Controls visibility                               |
| `file`             | `string \| JSON string[]`   | Single path or JSON-encoded array for aggregation |
| `status`           | `ready \| loading \| error` | Current operation status                          |
| `error`            | `string`                    | Error message to display                          |
| `zarr-url`         | `string`                    | Presigned Zarr URL for GridLook                   |
| `zarr-status-code` | `number`                    | Status code from `ZarrPoller.onStatus`            |
| `is-aggregation`   | boolean                     | Enables aggregation mode                          |
| `error-action`     | `string`                    | Label of an extra button beside Retry             |
| `viewer-disabled`  | `string`                    | Disables the 3D tab; the value is its tooltip     |
| `viewer-off`       | `string`                    | The host's policy: no 3D viewer (reads keep it)   |
| `embedded`         | boolean                     | No dialog chrome; fills its container (see below) |
| `view`             | `metadata \| viewer`        | The view to show (default `metadata`)             |

### `<data-inspector>` JS properties

| Property            | Type                                       | Description                                                  |
| ------------------- | ------------------------------------------ | ------------------------------------------------------------ |
| `output`            | `string \| null`                           | HTML string from xarray repr (too large for an attribute)    |
| `aggregationConfig` | `Partial<AggregationConfigValues> \| null` | What Aggregate / Retry submit until the user edits the form  |
| `loadOptions`       | `Record<string, unknown> \| null`          | Single-file loader options Retry re-submits; reset by `file` |
| `activeView`        | `metadata \| viewer` (read-only)           | The view shown now: the viewer only while it can show        |

`error` and `file` are rendered as **text** (never parsed as HTML). `output` is injected as HTML, so pass only trusted markup - the xarray repr from `loadZarrMetadataHtml` / `buildXarrayRepr` is safe; arbitrary remote HTML is not.

#### In a host's own pane: `embedded`

A host that shows the inspector in a tab or pane of its own - which already names the file and
closes it - sets `embedded`: no backdrop, title, close button, path field or focus trap, and the
inspector fills its container (give it a height). The views, the tabs between them, errors (with
Retry and `error-action`) and loading stay. `view="viewer"` opens on the 3D viewer once the store
is read; while the viewer cannot show (a read under way, `viewer-disabled`), the metadata does, and
`activeView` says which is shown.

#### GridLook 3D viewer

GridLook cannot send a token, so `zarr-url` must be readable without one - a share link for a
protected freva store. When there is none, set `viewer-disabled`. A host whose page may not frame
GridLook at all (its CSP) sets `viewer-off` instead: the pipeline clears `viewer-disabled` at every
read, never `viewer-off`, so the viewer stays off through Load, Retry and another store, and no
frame is made.

The viewer is shown in a sandboxed iframe (`sandbox="allow-scripts allow-same-origin allow-popups allow-downloads"`, `referrerpolicy="no-referrer"`). The iframe is created once on first view and reused, so switching tabs or other re-renders no longer reload it. The Zarr URL is placed in the viewer's URL fragment **verbatim** (GridLook reads `location.hash` as-is):

```
https://gridlook.pages.dev/#<zarr-url>
```

The URL is never interpolated into HTML - it is assigned via the iframe `src` property and shown via `textContent` - so a raw value cannot inject markup or attributes.

#### Path / Zarr rows

The header shows the inspected path. A separate **Zarr:** row appears only when the resolved `zarr-url` genuinely differs from `file` (i.e. a real server-side conversion produced a new store URL). When the input is already a Zarr store (`zarr-url === file`), the duplicate row is suppressed and only the single path row is shown.

### `<data-inspector>` events

| Event                    | `detail`                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| `inspector-close`        | `null`                                                                                      |
| `inspector-submit`       | `{ file: string \| string[], aggregationConfig: Partial<AggregationConfigValues> \| null }` |
| `inspector-error-action` | `null`                                                                                      |

### Theming

The dialog chrome reads host-adjustable CSS custom properties (light defaults shown):

| Variable       | Default   | Used for                                  |
| -------------- | --------- | ----------------------------------------- |
| `--di-bg`      | `#fff`    | Dialog / surface background               |
| `--di-fg`      | `#1f2937` | Primary text                              |
| `--di-muted`   | `#6b7280` | Secondary / muted text                    |
| `--di-border`  | `#e5e7eb` | Borders, dividers                         |
| `--di-surface` | `#f3f4f6` | Raised surfaces (rows, active tab, menus) |
| `--di-accent`  | `#3b82f6` | Header icon, primary buttons, active tab  |

Set any of these on the element or on any ancestor - for example, scoped to your app's dark-scheme selector - and the element follows:

```css
html.dark data-inspector {
  --di-bg: #1e293b;
  --di-fg: #e5e7eb;
  --di-muted: #94a3b8;
  --di-border: #475569;
  --di-surface: #334155;
  --di-accent: #14b8a6; /* match your brand */
}
```

The host-set values always win. `prefers-color-scheme: dark` is used only as a fallback default when no host override is present, so the host's chosen scheme takes precedence over the OS. Error styling stays semantic (red) and is intentionally not themed.

### Accessibility

The dialog uses `role="dialog"` + `aria-modal="true"` and is labelled by its title (`aria-labelledby`). Opening moves focus into the dialog and traps Tab/Shift+Tab within it; closing restores focus to the previously-focused element. <kbd>Escape</kbd> closes the dialog. The tabs expose `role="tab"`/`tablist`/`tabpanel` with `aria-selected`, and the close button has an `aria-label`.

### `ZarrPoller`

```ts
const poller = new ZarrPoller(zarrUrl, options);
poller.start();
poller.stop();
```

| Option           | Type                                                   | Default                             |
| ---------------- | ------------------------------------------------------ | ----------------------------------- |
| `intervalMs`     | `number`                                               | `2000`                              |
| `getAuthHeaders` | `(url) => headers \| Promise<headers>`                 | cookie, same origin only (see Auth) |
| `getStatusUrl`   | `(encoded: string) => string`                          | Freva `/zarr-utils/status` endpoint |
| `onStatus`       | `(statusCode: number, reason: string \| null) => void` | -                                   |
| `onError`        | `(error: string) => void`                              | -                                   |

**Backend status codes:** `0` ok · `1` failed · `2` not found · `3` waiting · `4` processing · `5` gone · `6` permission denied

The second `onStatus` argument carries the optional `reason` string returned by the status endpoint (e.g. a human-readable explanation for a failed/not-found conversion), or `null` when none was provided.

### Auth (`getAuthHeaders`, `scopedBearerAuth`)

Every fetcher (`ZarrPoller`, `detectZarrStore`, `openDatasetMeta`, `loadZarrMetadataHtml`) awaits
`getAuthHeaders(url)` once per request, with the absolute URL, so a credential goes only where it
belongs. A provider that throws sends the request anonymously. Without one, the legacy
`freva_auth_token` cookie is sent to the page's own origin only. `scopedBearerAuth` sends a bearer
to the listed origins only (default: the page's own):

```ts
import { loadZarrMetadataHtml, scopedBearerAuth } from "@freva-org/data-inspector";

const getAuthHeaders = scopedBearerAuth({
  getToken: async () => (await auth.getToken())?.accessToken ?? null,
  origins: ["https://freva.example.org"], // freva-rest, if not on this page's origin
});
const html = await loadZarrMetadataHtml(url, { getAuthHeaders });
```

### `detectZarrStore`

Probe a URL to see whether it already points at a Zarr store. When it does, a host can skip the server-side conversion step and stream/render the store directly.

```ts
import { detectZarrStore } from "@freva-org/data-inspector";

const info = await detectZarrStore(url);
// { isZarr: true, version: 2, consolidated: true }

if (info.isZarr) {
  // skip server conversion - point GridLook at `url` directly
}
```

It probes `<url>/.zmetadata` (v2 consolidated) first, then `<url>/zarr.json` (v2/v3).

| Field          | Type             | Description                                             |
| -------------- | ---------------- | ------------------------------------------------------- |
| `isZarr`       | `boolean`        | Whether the URL points at a readable Zarr store         |
| `version`      | `2 \| 3 \| null` | Detected Zarr format version (`null` when not a store)  |
| `consolidated` | `boolean`        | Whether consolidated metadata is available (renderable) |

| Option           | Type                                   | Default                             |
| ---------------- | -------------------------------------- | ----------------------------------- |
| `getAuthHeaders` | `(url) => headers \| Promise<headers>` | cookie, same origin only (see Auth) |
| `timeoutMs`      | `number`                               | `5000`                              |

### Client-side Zarr metadata (`loadZarrMetadataHtml`)

Parse a store's consolidated metadata (v2 `.zmetadata` or v3 `zarr.json`) **in the browser** and build the same xarray-style HTML repr that xarray renders in a notebook - no server round-trip. This replaces the removed server-side `/zarr-utils/html` endpoint.

```ts
import { loadZarrMetadataHtml } from "@freva-org/data-inspector";

const html = await loadZarrMetadataHtml(zarrUrl); // injects CSS into <head> once
el.output = html; // feed straight into <data-inspector>
```

Lower-level building blocks are also exported:

| Export                 | Signature                                        | Description                                                  |
| ---------------------- | ------------------------------------------------ | ------------------------------------------------------------ |
| `openDatasetMeta`      | `(url, options?) => Promise<ZarrMetadataResult>` | Fetch + parse metadata into a flat dataset or named groups   |
| `ZarrMetadataError`    | `Error` with `status: number \| null`            | Thrown when no metadata can be read (see below)              |
| `buildXarrayRepr`      | `(result: ZarrMetadataResult) => string`         | Render parsed metadata to the xarray HTML repr               |
| `injectXarrayCss`      | `(options?: { mainColor?: string }) => void`     | Inject the repr CSS into `<head>` once (idempotent)          |
| `loadZarrMetadataHtml` | `(url, options?) => Promise<string>`             | Convenience: fetch + parse + render (injects CSS by default) |

`openDatasetMeta` and `loadZarrMetadataHtml` take `getAuthHeaders` (see Auth) and `signal` (an `AbortSignal`; aborting rejects with an `AbortError`). `loadZarrMetadataHtml` adds `mainColor` (chunk-cube accent, defaults to `window.MAIN_COLOR`, then `#9b7a52`) and `injectCss` (set `false` to skip CSS injection).

When neither document can be read, a `ZarrMetadataError` is thrown; its `status` is `401`, then `403`, then any other HTTP status, or `null` when nothing answered.

Both v2 (`.zmetadata`) and v3 (`zarr.json`) consolidated metadata are supported, including **nested, multi-group hierarchies** at any depth. A flat store renders as a single `xarray.Dataset` repr; a hierarchical store renders one card per group, labelled with its full path (the root group is shown as `/`), each listing the variables directly under it.

## Development

```bash
npm install
npm run dev
npm test
npm run typecheck
npm run build
```
