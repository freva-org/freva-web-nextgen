// map.ts - a sanctioned lazy dependency: Leaflet, loaded ON DEMAND only.
//
// Performance contract: Leaflet and its tiles are NEVER in the main bundle and are NEVER
// fetched on page load. The instant, zero-cost world map is the vector SVG in geo.ts; Leaflet is a
// progressive ENHANCEMENT that is only fetched when the user actually asks to zoom/draw. If the
// load fails (offline, CSP, air-gapped deployment) the SVG simply stays - no error, no broken UI.
//
// The URLs are configurable so an air-gapped deployment can self-host both Leaflet and the tiles.

import type { Disposables } from "./dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type LeafletModule = any;

export interface MapConfig {
  /** Leaflet UMD bundle. */
  js: string;
  /** Leaflet stylesheet (required - Leaflet is unusable without it). */
  css: string;
  /** XYZ tile template, e.g. https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png */
  tileUrl: string;
  attribution: string;
}

export const DEFAULT_MAP_CONFIG: MapConfig = {
  js: "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
  css: "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  tileUrl: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
  attribution: "© OpenStreetMap contributors",
};

/**
 * Leaflet's JS and CSS are a GLOBAL, ONE-TIME installation. They are deliberately tied to NOTHING:
 * not to a caller's Disposables, not to a component's lifetime.
 *
 * Tying the stylesheet to the Disposables of whichever map loads it first breaks every later map:
 * that region is flushed on re-render / file change / close, so the <link> leaves <head> while
 * `window.L` and the cached module promise survive. Any map opened afterwards then gets Leaflet
 * WITHOUT its stylesheet - panes and tiles lose their absolute positioning, the map renders as
 * offset tile blocks, and pointer coordinates no longer line up with what's drawn.
 *
 * Two rules follow, and both matter:
 *   1. Nothing that is global may be owned by a component's lifecycle.
 *   2. A cached module is NOT proof the stylesheet is still there - so every loadLeaflet() call
 *      re-verifies the CSS, even when the JS is already in memory, and restores it if it's gone.
 */
let modPromise: Promise<LeafletModule> | null = null;
let cssPromise: Promise<void> | null = null;
// Leaflet publishes a single `window.L` and its CSS is version-matched, so a page can only
// host ONE Leaflet build. We load it once, process-globally; if a later mount asks for a DIFFERENT
// URL we keep the first (correct, given the shared global) and warn rather than silently diverging.
let loadedJsUrl: string | null = null;
// The CSS pinned to the loaded JS. Once a JS build is chosen, its stylesheet is authoritative: a
// later mount supplying a different CSS URL must NOT have that CSS paired with the pinned JS.
let loadedCssUrl: string | null = null;

const CSS_ID = "freva-leaflet-css";

/** Injectable seams so tests can drive these paths without a network. */
let loader: ((cfg: MapConfig, dis: Disposables) => Promise<LeafletModule>) | null = null;
let cssInjector: ((href: string) => Promise<void>) | null = null;
export function setLeafletLoaderForTests(fn: typeof loader): void {
  loader = fn;
  modPromise = null;
  loadedJsUrl = null;
  loadedCssUrl = null;
}
export function setLeafletCssInjectorForTests(fn: typeof cssInjector): void {
  cssInjector = fn;
  cssPromise = null;
}

/** Is the stylesheet still present AND loaded? (A region flush could have removed it.) */
function cssPresent(): boolean {
  const link = document.getElementById(CSS_ID) as HTMLLinkElement | null;
  return !!link && link.isConnected && link.dataset.loaded === "true";
}

/**
 * Load leaflet.css and WAIT for it. Leaflet positions its tiles and panes exactly once, using
 * absolute positioning that lives in this stylesheet: build a map before it applies (or after it
 * has been removed) and every tile is laid out by normal document flow instead - permanently.
 */
function injectCss(href: string, timeoutMs = 8000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const link = document.createElement("link");
    link.id = CSS_ID;
    link.rel = "stylesheet";
    link.href = href;
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      if (ok) {
        link.dataset.loaded = "true";
        resolve();
      } else {
        link.remove();
        reject(new Error("Leaflet stylesheet failed to load"));
      }
    };
    const timer = window.setTimeout(() => finish(false), timeoutMs);
    link.onload = () => finish(true);
    link.onerror = () => finish(false);
    document.head.appendChild(link); // NOTE: never registered with any Disposables - see above
  });
}

let cssInFlight = false;

/**
 * Ensure the stylesheet is present, re-installing it if something removed it.
 *
 * Note the shape of this: a RESOLVED promise is not evidence that the <link> is still in the
 * document - "cached, therefore fine" is exactly the assumption this module must not make, one
 * level down. So presence is checked against the DOM, and the promise is only reused while an
 * install is genuinely in flight (which also de-duplicates concurrent callers).
 */
function ensureCss(href: string): Promise<void> {
  if (cssPresent()) return Promise.resolve();
  if (cssPromise && cssInFlight) return cssPromise; // someone else is already installing it
  cssInFlight = true;
  cssPromise = (cssInjector ?? injectCss)(href)
    .then(() => {
      cssInFlight = false;
    })
    .catch((err: unknown) => {
      cssInFlight = false;
      cssPromise = null; // retryable
      throw err;
    });
  return cssPromise;
}

function injectScript(src: string, timeoutMs = 8000): Promise<LeafletModule> {
  return new Promise<LeafletModule>((resolve, reject) => {
    const w = window as unknown as { L?: LeafletModule };
    if (w.L) {
      resolve(w.L);
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    let done = false;
    const timer = window.setTimeout(() => {
      if (done) return;
      done = true;
      script.remove();
      reject(new Error("Leaflet load timed out"));
    }, timeoutMs);
    script.onload = () => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      const L = (window as unknown as { L?: LeafletModule }).L;
      if (L) {
        script.remove();
        resolve(L);
      } // window.L is registered; the <script> tag is now just residue
      else {
        script.remove();
        reject(new Error("Leaflet did not register"));
      }
    };
    script.onerror = () => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      script.remove();
      reject(new Error("Leaflet failed to load"));
    };
    document.head.appendChild(script); // global, like the stylesheet - owned by nobody
  });
}

/**
 * Belt and braces: prove leaflet.css is really in effect before we hand back a module. A <link> can
 * report `load` while being blocked by CSP or served with the wrong MIME type - in which case we
 * would rather fall back to the SVG than draw a broken map.
 */
function assertStylesheetApplied(): void {
  if (cssInjector) return; // test seam: no real stylesheet to probe
  const probe = document.createElement("div");
  probe.className = "leaflet-pane";
  probe.style.cssText = "visibility:hidden;pointer-events:none";
  document.body.appendChild(probe);
  const positioned = getComputedStyle(probe).position === "absolute"; // set by leaflet.css
  probe.remove();
  if (!positioned) {
    cssPromise = null;
    throw new Error("Leaflet stylesheet did not apply (blocked by CSP, or the wrong MIME type)");
  }
}

/**
 * Load Leaflet. Safe to call any number of times, from any component, in any order.
 *
 * `dis` is accepted for API compatibility but is NOT used to own the installation - see the note at
 * the top of this file. A component's disposables must never be able to uninstall a global.
 */
export function loadLeaflet(cfg: MapConfig, dis: Disposables): Promise<LeafletModule> {
  void dis;
  // Once a JS build is pinned, its CSS is authoritative - a later mount's CSS URL must never be
  // paired with it. So when JS is already chosen we (re)install the PINNED css, not the caller's.
  // The CSS is re-checked on EVERY call: a cached module is no guarantee the stylesheet still applies.
  const cssUrl = loadedJsUrl ? (loadedCssUrl ?? cfg.css) : cfg.css;
  const css = ensureCss(cssUrl);

  if (!modPromise) {
    loadedJsUrl = cfg.js;
    loadedCssUrl = cfg.css; // tentatively pin the pair; both cleared together if the JS load fails
    const run =
      loader ??
      ((c: MapConfig, d: Disposables): Promise<LeafletModule> => {
        void d;
        return injectScript(c.js);
      });
    modPromise = Promise.resolve(run(cfg, dis)).catch((err: unknown) => {
      modPromise = null; // transient failure must be retryable
      loadedJsUrl = null;
      loadedCssUrl = null;
      throw err;
    });
  } else if (loadedJsUrl && cfg.js !== loadedJsUrl) {
    console.warn(
      `[freva-databrowser] Leaflet already loaded from ${loadedJsUrl}; ignoring a second URL (${cfg.js}). A page can host only one Leaflet build.`,
    );
  }
  const mod = modPromise;

  return Promise.all([css, mod])
    .then(([, L]) => {
      assertStylesheetApplied();
      return L;
    })
    .catch((err: unknown) => {
      // A failed pair must not strand the wrong stylesheet. Remove the failed link and clear the CSS
      // cache so the NEXT call re-attempts - but the JS/CSS pins stay put, so that retry reinstalls the
      // CSS that belongs to the pinned JS (loadedCssUrl), never a different caller's CSS.
      const link = document.getElementById(CSS_ID);
      if (link) link.remove();
      cssPromise = null;
      cssInFlight = false;
      throw err;
    });
}
