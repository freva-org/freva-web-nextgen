/**
 * Data Browser island.
 *
 * The component itself is `@freva-org/databrowser`, unchanged: its search, facets, selection and
 * export behaviour are that package's. What the portal supplies is configuration and the mount
 * lifecycle, and four options are the whole difference between a widget that reads as part of the
 * portal and a second application pasted inside one:
 *
 *   * `features.brand/footer/themeToggle: false` - the shell already provides the product
 *     identity, the compact footer and the theme control, so leaving them on gives the visitor
 *     two Frevas, two footers and two moons.
 *   * `metadataScriptUrl: null` - the package otherwise injects a script tag for
 *     `/static/js/metadata.js`, a path from a different Freva deployment layout that 404s here.
 *   * `theme.mode` - the portal's resolved theme at mount, kept in step afterwards through the
 *     shell's `portal:theme` event, so the widget never starts dark inside a light page.
 *   * `syncUrl: true` - the active facets belong in the address bar, so a search is a link and
 *     the back button works.
 *
 * `mountDataBrowserFromIntent` takes the landing handoff as a versioned URL value rather than
 * through a DOM selector or a global, so a reload, a bookmark and a shared link reproduce the
 * same search.
 */

import { mountDataBrowserFromIntent } from "@freva-org/databrowser";
import type { AuthBridge, DatabrowserRuntime } from "../runtime.js";

export interface DatabrowserDeps {
  auth?: AuthBridge;
}

/** The portal's theme, in the vocabulary the component uses. */
function widgetMode(): "day" | "night" {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "night" : "day";
}

export function mountDatabrowserIsland(
  runtime: DatabrowserRuntime,
  deps: DatabrowserDeps = {},
): void {
  const host = document.getElementById(runtime.mountId);
  if (!host) return;
  const status = host.querySelector("[data-portal-boundary]");
  if (status) status.remove();

  // The component fills its target, so the target needs a definite height. The application view
  // gives the region one; this is the belt to that brace.
  host.classList.add("portal-feature-fill");

  // The portal's overlay layer, handed to the widget for its two global surfaces: the File
  // Inspector and the terminal window. Everything else it draws - tooltips, popovers, the facet
  // dropdown - stays inside the widget. `?? undefined` rather than a throw, because a widget that
  // cannot find the layer mounts those two on its own root, as it does on a standalone page.
  const overlayRoot = document.getElementById("portal-overlay-root") ?? undefined;

  const handle = mountDataBrowserFromIntent(host as HTMLElement, {
    apiBase: runtime.apiBase,
    ...(overlayRoot ? { overlayRoot } : {}),
    flavour: runtime.flavour,
    baseFilters: runtime.fixedFacets,
    // The deployment's shaping options, forwarded verbatim, so a portal can choose its own
    // landing view and compose its own overview from `portal.yaml`. CONDITIONALLY rather than
    // always: the widget's defaults and the portal's resolved defaults are the same values, so
    // sending them unconditionally puts an explicit `defaultLayout: "browse"` in every bundle.
    ...(runtime.defaultLayout !== "browse" ? { defaultLayout: runtime.defaultLayout } : {}),
    ...(runtime.overview.order.length || runtime.overview.mainFacets
      ? {
          overview: {
            ...(runtime.overview.order.length ? { order: runtime.overview.order } : {}),
            ...(runtime.overview.mainFacets ? { mainFacets: runtime.overview.mainFacets } : {}),
          },
        }
      : {}),
    ...(runtime.scopeRemovable ? { scopeRemovable: true } : {}),
    authEnabled: runtime.authentication !== "none" && Boolean(deps.auth),
    syncUrl: true,
    metadataScriptUrl: null,
    features: { brand: false, footer: false, themeToggle: false },
    theme: { mode: widgetMode() },
    ...(deps.auth ? { getAuthToken: () => deps.auth!.token() } : {}),
  });

  // One theme, one switch. The shell owns the control and announces the change; the widget
  // follows rather than keeping a second opinion.
  window.addEventListener("portal:theme", () => {
    handle.setTheme(widgetMode());
  });
}
