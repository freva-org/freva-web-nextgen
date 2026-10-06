/**
 * Opening a store in the portal's own inspector.
 *
 * NO URL FALLBACK: either the inspector is present and the control opens it, or the control is
 * not drawn, which the component arranges by drawing `Inspect` only when a consumer supplied a
 * handler. Opening the store's raw HTTPS URL instead hands a reader an XML listing document for a
 * `.zarr/` prefix - worse than no button, because it looks like the feature working.
 *
 * THE PACKAGE IS LOADED ON THE FIRST PRESS, through this module's own dynamic import: a portal
 * whose visitors never press Inspect should not pay for a Zarr metadata reader, and this is the
 * only module naming the specifier.
 *
 * THE HOST OWNS DISMISSAL. `<data-inspector>`'s close button, backdrop click and Escape key only
 * EMIT `inspector-close` and wait for whoever mounted it to act, so a host that does not listen
 * leaves a modal the reader cannot dismiss by any means.
 *
 * THE PACKAGE DRIVES THE READ: the element is a VIEW, and `attachInspector` from the same package
 * is the pipeline - the one the Data Browser and a standalone page use - so `Load`, an edited path
 * and Enter re-read the field, the newest read wins, and every exit settles `status`. The host sets
 * `file` BEFORE the first read, because a change of `file` clears `zarr-url` and its output.
 *
 * NO CREDENTIALS, EVER: `getAuthHeaders` returns `{}` and there is no data-portal. The tree's
 * stores are public zarr on object storage, and this static artifact has no server for a file
 * that is not a store, so a failure says so instead of blaming the reader's sign-in.
 */

import { mountLayer, type Layer } from "../layers.js";

/**
 * What the inspector needs to open a store: its address, and nothing else. Not its name - the
 * element's `file` is an editable path field whose `Load` button re-reads whatever it contains, so
 * a bare `level_2.zarr` there is a path that resolves to nothing.
 */
export interface InspectTarget {
  /** Absolute HTTPS URL of the store, derived from the configured endpoint. */
  url: string;
  /** GridLook's globe may show: the portal frames it. Otherwise the 3D tab says why it cannot. */
  gridlook?: boolean;
}

/** The 3D tab's reason when the portal does not frame GridLook (its policy would block it). */
export const VIEWER_OFF = "The 3D viewer is not enabled on this site.";

/**
 * The portal's theme, applied to a component that ships its own.
 *
 * `<data-inspector>` assumes it is the page: light defaults with a `prefers-color-scheme` block
 * supplying dark ones, which in a portal whose theme the visitor switches independently of their
 * system setting opens a white modal over a dark page. The element publishes `--di-*` as its
 * public knobs and lets the media query supply only the FALLBACK, so a value set here wins in
 * both schemes and mapping them onto the portal's tokens is the whole theming job.
 *
 * The rest matches the Data Browser's inspector rule for rule, because it is the same component
 * opened from the same portal: a SOLID ACCENT HEADER, because the modal is a piece of this
 * portal's chrome and wears the same colour as the header bar it opens under; the LOAD BUTTON
 * INVERTED, so a primary button does not disappear into a header of its own colour; the XARRAY
 * REPR mapped onto the portal's tokens, since its `--jp-*` defaults are a fixed light palette
 * that would be a white sheet inside a dark modal; and the repr's OWN 700px CAP lifted, so
 * metadata fills a modal up to 1100px wide.
 *
 * ON THE CHROME'S TOKENS, NOT ON `--accent-ink`. A bar's colour is `--chrome-bg` and what reads
 * on it is `--chrome-ink`, both derived by `themes/registry.ts` for every bar this portal draws,
 * with the ink fixed to white rather than measured. `--accent-ink` is the measured ink for an
 * accent-coloured CONTROL: whichever of the theme's two inks contrasts better against the accent,
 * the same in both themes, which against Waterpark's teal `#009688` (3.39:1 light, 5.15:1 dark)
 * is the DARK one - a near-black title under a white header bar, and an inverted button filling
 * with that ink as `#0b1117` on `#009688`.
 *
 * AND THE BUTTON IS A CHIP, not a white pill. The Data Browser inverts to `#fff` with the accent
 * as the label, legible on its blue; on this teal that is 3.39:1 for a 13px label, and
 * `--accent-text` cannot stand in because it is derived against the PAGE and lightens in the dark
 * theme. A control on a chrome bar is a `--chrome-chip` fill with a `--chrome-line-hi` edge and
 * white on it - what the header bar's active nav item and theme toggle are - here 6.1:1 in both
 * themes.
 *
 * The header and repr rules target the element's internal classes and are coupled to its version.
 * They degrade to the component's own defaults if a class is renamed, which is why they are worth
 * having and why nothing depends on them being applied.
 */
const CSS = `
.portal-inspector-host data-inspector {
  --di-bg: var(--surface, #ffffff);
  --di-fg: var(--ink, #172322);
  --di-muted: var(--muted, #526765);
  --di-border: var(--line-2, var(--line, #c6d0d0));
  --di-surface: var(--surface-2, #f4f6f7);
  --di-accent: var(--accent, #009688);
  --xr-font-color0: var(--ink, #172322);
  --xr-font-color2: var(--muted, #526765);
  --xr-font-color3: var(--muted, #526765);
  --xr-border-color: var(--line-2, var(--line, #c6d0d0));
  --xr-disabled-color: var(--muted, #526765);
  --xr-background-color: var(--surface, #ffffff);
  --xr-background-color-row-even: var(--surface, #ffffff);
  --xr-background-color-row-odd: var(--surface-2, #f4f6f7);
  --xr-chunk-face: var(--accent, #009688);
  --xr-chunk-top: color-mix(in srgb, var(--accent, #009688) 68%, #fff);
  --xr-chunk-side: color-mix(in srgb, var(--accent, #009688) 80%, #000);
  --xr-chunk-edge: color-mix(in srgb, var(--accent, #009688) 38%, #fff);
}
/*
 * The "Zarr:" row, suppressed - the same call the Data Browser makes. That row exists where the
 * path a reader typed and the store URL a server produced from it are different strings. Here the
 * path field holds the store's own URL, so the row under it is that URL printed twice.
 */
.portal-inspector-host data-inspector .di-zarr-row {
  display: none;
}
.portal-inspector-host data-inspector .di-header {
  background: var(--chrome-bg, var(--accent, #009688));
  border-bottom: none;
}
.portal-inspector-host data-inspector .di-header .di-title,
.portal-inspector-host data-inspector .di-header .di-title-ico,
.portal-inspector-host data-inspector .di-header .di-pathbar-label,
.portal-inspector-host data-inspector .di-header .di-muted,
.portal-inspector-host data-inspector .di-header .di-close {
  color: var(--chrome-ink, #ffffff);
}
.portal-inspector-host data-inspector .di-header .di-close:hover {
  background: var(--chrome-chip, color-mix(in srgb, #000 14%, var(--accent, #009688)));
  color: var(--chrome-ink, #ffffff);
}
.portal-inspector-host data-inspector .di-header .di-btn-primary {
  background: var(--chrome-chip, color-mix(in srgb, #000 14%, var(--accent, #009688)));
  border-color: var(--chrome-line-hi, color-mix(in srgb, #fff 38%, var(--accent, #009688)));
  color: var(--chrome-ink, #ffffff);
}
.portal-inspector-host data-inspector .di-header .di-btn-primary:hover:not(:disabled) {
  filter: none;
  background: var(--chrome-chip-hi, color-mix(in srgb, #000 26%, var(--accent, #009688)));
}
.portal-inspector-host data-inspector .di-header .di-btn-split {
  border-left-color: var(--chrome-line-hi, color-mix(in srgb, #fff 38%, var(--accent, #009688)));
}
.portal-inspector-host data-inspector .xr-wrap {
  max-width: none;
}
`;

let adopted = false;

/**
 * Put the stylesheet where the page can use it, preferring the route a policy does not block.
 * Adopted sheets are applied after every author stylesheet, which puts these rules after the
 * element's own chrome CSS - it injects that into `<head>` on first construction, and order, not
 * specificity, decides which of two single-class rules wins.
 */
function adoptStyles(doc: Document): void {
  if (adopted) return;
  adopted = true;
  try {
    if (typeof CSSStyleSheet === "function" && Array.isArray(doc.adoptedStyleSheets)) {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
      return;
    }
  } catch {
    // an engine that has the API and refuses the sheet falls through to the element
  }
  const style = doc.createElement("style");
  style.textContent = CSS;
  doc.head.append(style);
}

/** The parts of `<data-inspector>` a host drives. Everything else about it is its own business. */
interface InspectorElement extends HTMLElement {
  file?: string | null;
  /** Trusted HTML: the package's own render of a store it parsed. Too large for an attribute. */
  output?: string | null;
  error?: string | null;
}

/** The part of `@freva-org/data-inspector` this module uses. */
interface InspectorModule {
  attachInspector: (
    el: HTMLElement,
    options: {
      getAuthHeaders: () => Record<string, string>;
      isStore: (target: string) => boolean;
    },
  ) => { load(target: string): Promise<void>; detach(): void };
}

let layer: Layer | null = null;
let element: InspectorElement | null = null;
let loading: Promise<InspectorModule> | null = null;
/** The pipeline driving `element`; detached with it, which cancels a read still in flight. */
let reader: ReturnType<InspectorModule["attachInspector"]> | null = null;

/**
 * Take the open inspector off the page. The layer is released rather than hidden, so a dismissed
 * inspector is not an invisible element over the overlay root collecting clicks. The MODULE promise
 * is kept: the chunk has been fetched, and a second store should not wait for it twice.
 */
function dismiss(): void {
  // Nothing in flight may write to an element that is on its way off the page.
  reader?.detach();
  reader = null;
  element?.removeAttribute("open");
  layer?.release();
  layer = null;
  element = null;
}

/**
 * Show the inspector for one store.
 *
 * One inspector per page, reused: pressing Inspect on a second store retargets the one already open
 * rather than stacking a second panel over it.
 *
 * NOTHING IS FETCHED BY THIS MODULE. The inspector reads the store's own metadata documents, and
 * the tree issues no request for the store's contents - which is what keeps `Inspect` from
 * descending into a chunk hierarchy the tree deliberately stops at.
 */
export async function openInspector(target: InspectTarget): Promise<void> {
  adoptStyles(document);
  // One import, remembered, so a double press does not fetch the chunk twice.
  loading ??= import("@freva-org/data-inspector").then(
    (module) => module as unknown as InspectorModule,
  );
  const module = await loading;

  if (!element) {
    const host = document.createElement("div");
    host.className = "portal-inspector-host";
    element = document.createElement("data-inspector") as InspectorElement;
    // EVERY way out of the element arrives here: its close button, a click on its own backdrop and
    // Escape all emit this and change nothing themselves. Reporting a dismissal instead of
    // performing one is how a host keeps focus restoration and layer bookkeeping, and it only works
    // if the host listens.
    element.addEventListener("inspector-close", () => dismiss());
    // `Load`, an edited path and Enter in the field are the pipeline's own business: a reader who
    // pastes another store's URL is asking for that store, so the field is what is read. Every
    // input is treated as a store (there is no second route here), read with no credentials.
    reader = module.attachInspector(element, {
      getAuthHeaders: () => ({}),
      isStore: () => true,
    });
    host.append(element);
    layer = mountLayer(host, "dialog");
  }
  layer?.raise();
  // The STORE'S URL is the path, as it is in the Data Browser, and it is set FIRST: the element
  // clears `zarr-url` and the output derived from it whenever `file` changes, so the other order
  // throws away the load that was just started. It is also the value a reader needs, because the
  // field is editable and its content is what `Load` re-reads.
  element.file = target.url;
  // The host's policy, which no read, Retry or new file changes (unlike `viewer-disabled`).
  if (target.gridlook) element.removeAttribute("viewer-off");
  else element.setAttribute("viewer-off", VIEWER_OFF);
  void reader?.load(target.url);
  element.setAttribute("open", "");
}

/** Take the inspector off the page. Called when the last tree on it is destroyed. */
export function destroyInspector(): void {
  dismiss();
  loading = null;
}
