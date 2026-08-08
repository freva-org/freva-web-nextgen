// components/inspector.ts - per-file Inspect via @freva-org/data-inspector.
// A sanctioned lazy dependency (alongside Leaflet): its ESM is dynamically imported from a CDN
// URL on first use ONLY, so it never enters the main bundle or node_modules (the same model as
// map.ts loads Leaflet). The URL is config-overridable (cfg.inspectorUrl) for self-hosting.
//
// Two paths, matching what the package can actually do:
//   • ALREADY ZARR (no auth): detectZarrStore() probes the file URL for a zarr store; if it is one,
//     loadZarrMetadataHtml() renders the xarray repr CLIENT-SIDE with no token. This needs only
//     features.inspect - no sign-in, no data-portal.
//   • NOT ZARR (needs conversion): that requires the server data-portal, so it stays gated behind
//     authEnabled + enableHeavyOps and shows an honest reason when the gate is closed.

import type { AppContext } from "../context.js";

/** Pinned CDN ESM for the inspector. esm.sh serves the package's self-contained module (the package
 *  has no runtime dependencies), so a bare dynamic import resolves with nothing else to fetch. */
export const DEFAULT_INSPECTOR_URL = "https://esm.sh/@freva-org/data-inspector@2608.0.0";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type InspectorModule = any;
let modPromise: Promise<InspectorModule> | null = null;
// `customElements.define('data-inspector', …)` can only run ONCE per page, so the inspector
// is necessarily process-global: the first configured URL wins. A later mount with a different URL
// keeps the first and warns, rather than silently registering nothing.
let loadedUrl: string | null = null;

// The dynamic import is behind an injectable seam so a test can drive the load + both file paths
// without a real chunk or network. Production imports the configured URL.
const realImport = (url: string): Promise<InspectorModule> => import(/* @vite-ignore */ url);
let importModule: (url: string) => Promise<InspectorModule> = realImport;
export function setInspectorImporterForTests(
  fn: ((url: string) => Promise<InspectorModule>) | null,
): void {
  importModule = fn ?? realImport;
  modPromise = null;
  loadedUrl = null;
}

export async function loadInspector(url: string): Promise<InspectorModule> {
  if (modPromise && loadedUrl && url !== loadedUrl) {
    console.warn(
      `[freva-databrowser] data-inspector already loaded from ${loadedUrl}; ignoring a second URL (${url}). The custom element can only be registered once per page.`,
    );
  }
  if (!modPromise) {
    loadedUrl = url;
    modPromise = importModule(url)
      .then((m: InspectorModule) => {
        if (m?.DataInspectorElement && !customElements.get("data-inspector")) {
          customElements.define("data-inspector", m.DataInspectorElement);
        }
        return m;
      })
      .catch((err: unknown) => {
        modPromise = null; // a transient load failure shouldn't poison every future Inspect
        loadedUrl = null;
        throw err;
      });
  }
  return modPromise;
}

/** Inspect is offered whenever the deployment enables the feature. The ZARR path needs nothing more;
 *  the non-zarr (server-conversion) path additionally needs auth + the data-portal, enforced at
 *  click time so a zarr file is never blocked by a missing token. */
export function inspectEnabled(ctx: AppContext): boolean {
  return ctx.cfg.features.inspect;
}

export function inspectDisabledReason(ctx: AppContext): string {
  return ctx.cfg.features.inspect ? "" : "Inspect is disabled for this deployment";
}

/** True when the server-backed (non-zarr) inspection path is usable. */
function serverPathOpen(ctx: AppContext): boolean {
  return ctx.cfg.authEnabled && ctx.cfg.enableHeavyOps;
}
function serverPathReason(ctx: AppContext): string {
  return !ctx.cfg.authEnabled
    ? "This file isn\u2019t a zarr store - inspecting it needs sign-in"
    : "This file isn\u2019t a zarr store - inspecting it needs the data-portal";
}

export interface InspectorController {
  open(file: string): Promise<void>;
  /** Open the inspector with no file - the empty state prompts the user to enter a store URL. */
  openEmpty(): Promise<void>;
}

export function createInspector(ctx: AppContext): InspectorController {
  const dis = ctx.dis;

  async function open(file: string | null): Promise<void> {
    if (!inspectEnabled(ctx)) {
      ctx.toast("warn", inspectDisabledReason(ctx));
      return;
    }
    ctx.log(
      "info",
      file ? `Inspecting ${file.split("/").pop() ?? file}\u2026` : "Opening the inspector\u2026",
    );
    let mod: InspectorModule;
    try {
      mod = await loadInspector(ctx.cfg.inspectorUrl);
    } catch {
      ctx.toast(
        "error",
        "Inspector unavailable \u2014 the data-inspector module could not be loaded.",
      );
      return;
    }
    // The widget may have been destroyed WHILE the module import was in flight. Adding to a
    // disposed registry flushes synchronously, so continuing would build a dialog into a detached
    // root and wire listeners that never clean up. Bail instead.
    if (dis.isDisposed) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dlg = document.createElement("data-inspector") as any;
    const scope = dis.child();
    let closed = false;
    let generation = 0; // supersede stale loads: only the newest runLoad may commit
    scope.add(() => {
      try {
        dlg.remove();
      } catch {
        /* already gone */
      }
    });
    const close = (): void => {
      if (closed) return;
      closed = true;
      scope.flush(); // removes the dialog AND detaches this scope from the parent registry
    };
    dlg.addEventListener("inspector-close", close);

    // Load metadata for `target` and drive the component's state.
    //
    // THE CRITICAL BIT: the component only reveals its tabs/metadata/error region when `zarr-url` is
    // set (#nc-tabs-wrap is gated on it). Setting `output` alone leaves the dialog stuck on the path
    // bar. For an already-zarr file the store URL IS the file URL.
    //
    // We read the store CLIENT-SIDE with no token (getAuthHeaders -> {}); loadZarrMetadataHtml probes
    // the store itself and throws if it isn't one, so no separate detect step is needed. dlg.output
    // is a trusted-HTML sink fed ONLY by the package's own parse of a same-origin zarr store.
    const noAuth = { getAuthHeaders: (): Record<string, string> => ({}) };
    const runLoad = async (target: string): Promise<void> => {
      const mine = ++generation;
      dlg.setAttribute("zarr-url", target); // reveal the tabs/metadata region (and any error inside it)
      dlg.setAttribute("status", "loading");
      dlg.error = null;
      try {
        if (typeof mod.loadZarrMetadataHtml !== "function")
          throw new Error("inspector build lacks loadZarrMetadataHtml");
        const html = await mod.loadZarrMetadataHtml(target, noAuth);
        if (closed || mine !== generation) return; // superseded by a newer load, or the dialog closed
        dlg.output = typeof html === "string" ? html : (html?.html ?? "");
        dlg.setAttribute("status", "ready");
      } catch (err) {
        if (closed || mine !== generation) return;
        const detail = err instanceof Error ? err.message : String(err);
        dlg.error = serverPathOpen(ctx)
          ? `Could not read this as a zarr store (${detail}). Server-side inspection isn\u2019t wired in this build.`
          : serverPathReason(ctx);
        dlg.setAttribute("status", "error");
      }
    };
    // The Load button (and an edited path) re-drive the same loader via inspector-submit.
    dlg.addEventListener("inspector-submit", (e: Event) => {
      const detail = (e as CustomEvent<{ file?: string }>).detail;
      const target = detail?.file ?? file;
      if (target) void runLoad(target);
    });

    if (file) dlg.file = file;
    ctx.roots.app.appendChild(dlg);
    // With a file: drive the initial load ourselves, THEN open (status is 'loading' by the time the
    // `open` attribute lands, so the component's own open->auto-submit is suppressed - no double load).
    // Empty: leave the store URL unset and mark 'ready' so the component shows its "enter a path"
    // empty state (the path bar + Load are always visible) for the user to type any store URL.
    if (file) void runLoad(file);
    else dlg.setAttribute("status", "ready");
    dlg.setAttribute("open", "");
  }

  return { open: (file: string) => open(file), openEmpty: () => open(null) };
}
