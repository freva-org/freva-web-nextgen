/**
 * STAC Browser island.
 *
 * Everything specific to this site lives in the generated adapter module, which the build produced
 * from validated YAML and the bundler content-hashed. There is no `runtime-config.js` to replace
 * at deploy time and no upstream option name anywhere near a consumer.
 *
 * The readiness signal is published AFTER the upstream application has imported and rendered.
 * `window.STAC_BROWSER_CONFIG` is set before the dynamic import, so a check that waited for it
 * would be satisfied by a configuration object and an empty mount element - which is also what a
 * failed import leaves behind.
 */

import { mountStacBrowser } from "virtual:portal-stac-adapter";
import type { StacRuntime } from "../runtime.js";

/** How long the upstream application may take to put something in the host. */
const RENDER_TIMEOUT_MS = 20_000;

/** Wait until the host has real content, or say that it never did. */
function waitForContent(host: HTMLElement, timeoutMs: number): Promise<boolean> {
  if (host.childElementCount > 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (host.childElementCount === 0) return;
      observer.disconnect();
      clearTimeout(timer);
      resolve(true);
    });
    const timer = setTimeout(() => {
      observer.disconnect();
      resolve(false);
    }, timeoutMs);
    observer.observe(host, { childList: true });
  });
}

export async function mountStacIsland(runtime: StacRuntime): Promise<void> {
  const host = document.getElementById(runtime.mountId);
  if (!host) return;
  const status = host.querySelector("[data-portal-boundary]");
  if (status) status.remove();

  // What the document looked like before a third-party application touched it. The drawer adds a
  // class to <body> to lock scrolling, and leaving the route with that class still set leaves the
  // PORTAL unable to scroll, so the classes are snapshotted and anything added since is removed on
  // the way out.
  //
  // One restorer per document, not one per mount: the island can be entered more than once,
  // because the prepared build exposes an init hook so a second visit re-mounts rather than
  // importing the bundle twice. Registering a `pagehide` listener per entry accumulates listeners,
  // and a LATER snapshot is taken while the drawer's class may already be set and would treat it
  // as original. So the FIRST snapshot is kept and the previous listener released.
  interface IslandLifecycle {
    restoreBody: () => void;
    bodyClasses: string[];
  }
  const scope = window as unknown as { __portalStacIsland?: IslandLifecycle };
  if (scope.__portalStacIsland) {
    window.removeEventListener("pagehide", scope.__portalStacIsland.restoreBody);
  }
  const bodyClassesBefore = scope.__portalStacIsland?.bodyClasses ?? [...document.body.classList];
  const restoreBody = (): void => {
    for (const name of [...document.body.classList]) {
      if (!bodyClassesBefore.includes(name)) document.body.classList.remove(name);
    }
  };
  window.addEventListener("pagehide", restoreBody);
  scope.__portalStacIsland = { restoreBody, bodyClasses: bodyClassesBefore };

  host.dataset.portalStacState = "loading";
  try {
    await mountStacBrowser();
  } catch (error) {
    host.dataset.portalStacState = "failed";
    host.dataset.portalStacError = error instanceof Error ? error.message : String(error);
    throw error;
  }

  const rendered = await waitForContent(host, RENDER_TIMEOUT_MS);
  if (!rendered) {
    host.dataset.portalStacState = "failed";
    host.dataset.portalStacError = `the catalog browser did not render within ${RENDER_TIMEOUT_MS}ms`;
    return;
  }
  host.dataset.portalStacState = "ready";
}
