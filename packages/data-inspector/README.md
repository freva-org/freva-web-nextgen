# @freva-org/data-inspector

[![npm](https://img.shields.io/npm/v/@freva-org/data-inspector)](https://www.npmjs.com/package/@freva-org/data-inspector)
[![CI](https://github.com/freva-org/freva-web-nextgen/actions/workflows/ci.yml/badge.svg)](https://github.com/freva-org/freva-web-nextgen/actions/workflows/ci.yml)
[![License: BSD 3-Clause](https://img.shields.io/badge/License-BSD-3-Clause-yellow.svg)](../../LICENSE)

NetCDF / Zarr file inspection dialog as a **framework-agnostic Web Component**. Works in React, Vue, Svelte, Angular, plain HTML, and Django templates - anything that can load a JS module.

> Bootstrap CSS v5 must be provided by the host application.

## Install

```bash
npm install @freva-org/data-inspector
```

## Quick start

```js
import "@freva-org/data-inspector";
```

```html
<data-inspector id="inspector" file="/data/myfile.nc"></data-inspector>
```

```js
const el = document.getElementById("inspector");

el.addEventListener("inspector-submit", ({ detail: { file, aggregationConfig } }) => {
  loadMetadata(file, aggregationConfig);
});

el.addEventListener("inspector-close", () => el.removeAttribute("open"));

el.setAttribute("open", ""); // open it
```

## Usage with ZarrPoller

```js
import { ZarrPoller, NcDumpDialogState } from "@freva-org/data-inspector";

el.addEventListener("inspector-submit", async ({ detail: { file, aggregationConfig } }) => {
  el.setAttribute("status", NcDumpDialogState.LOADING);

  try {
    const { html, zarrUrl } = await myBackend.inspect(file, aggregationConfig);

    el.output = html;
    el.setAttribute("zarr-url", zarrUrl);
    el.setAttribute("status", NcDumpDialogState.READY);

    const poller = new ZarrPoller(zarrUrl, {
      onStatus: (code) => el.setAttribute("zarr-status-code", String(code)),
      onError: (err) => console.error(err),
    });
    poller.start();
  } catch (e) {
    el.setAttribute("status", NcDumpDialogState.ERROR);
    el.setAttribute("error", String(e));
  }
});
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

### `<data-inspector>` JS property

| Property | Type             | Description                                               |
| -------- | ---------------- | --------------------------------------------------------- |
| `output` | `string \| null` | HTML string from xarray repr (too large for an attribute) |

### `<data-inspector>` events

| Event              | `detail`                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------- |
| `inspector-close`  | `null`                                                                                      |
| `inspector-submit` | `{ file: string \| string[], aggregationConfig: Partial<AggregationConfigValues> \| null }` |

### `ZarrPoller`

```ts
const poller = new ZarrPoller(zarrUrl, options);
poller.start();
poller.stop();
```

| Option           | Type                           | Default                             |
| ---------------- | ------------------------------ | ----------------------------------- |
| `intervalMs`     | `number`                       | `2000`                              |
| `getAuthHeaders` | `() => Record<string, string>` | reads `freva_auth_token` cookie     |
| `getStatusUrl`   | `(encoded: string) => string`  | Freva `/zarr-utils/status` endpoint |
| `onStatus`       | `(statusCode: number) => void` | -                                   |
| `onError`        | `(error: string) => void`      | -                                   |

**Backend status codes:** `0` ok · `1` failed · `2` not found · `3` waiting · `4` processing · `5` gone

## Development

```bash
npm install
npm run dev
npm test
npm run typecheck
npm run build
```
