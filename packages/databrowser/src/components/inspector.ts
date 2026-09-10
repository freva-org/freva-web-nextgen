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
    /*
     * The Inspector is a modal over the whole application, so it is a real
     * `<dialog>` opened with `showModal()`.
     *
     * That is not decoration. A modal dialog is promoted to the browser's *top
     * layer*, which is laid out against the viewport rather than against any
     * ancestor - so it is not clipped by a host that contains its own layout,
     * and it paints over the portal's header and footer without anybody
     * choosing a z-index. The same call makes everything outside it inert, gives
     * Escape its `cancel` event, and traps Tab, all from the platform instead of
     * from a hand-rolled trap that has to be kept correct.
     *
     * The element inside keeps its own markup, its own focus restoration and its
     * own close event; the dialog is a wrapper around it, not a replacement.
     */
    const modal = document.createElement("dialog");
    /*
     * `freva-db` on the dialog itself, not only on the component root.
     *
     * The dialog may be mounted outside the widget - that is the whole point of
     * the overlay root - and the widget's stylesheet is scoped by that class.
     * Wearing it makes the dialog its own scope root, so the Inspector is themed
     * by the component that opened it wherever it ends up in the tree. The theme
     * attribute travels with it for the same reason.
     */
    modal.className = "freva-db fdb-inspector-dialog";
    const theme = ctx.roots.app.getAttribute("data-theme");
    if (theme) modal.setAttribute("data-theme", theme);
    modal.append(dlg);

    const scope = dis.child();
    let closed = false;
    let generation = 0; // supersede stale loads: only the newest runLoad may commit
    // Whatever had focus when the Inspector opened gets it back when it closes,
    // even if the element inside never reaches its own restoration path.
    const returnFocusTo = document.activeElement as HTMLElement | null;
    scope.add(() => {
      try {
        if (modal.open) modal.close();
        modal.remove();
      } catch {
        /* already gone */
      }
      if (returnFocusTo?.isConnected && typeof returnFocusTo.focus === "function") {
        returnFocusTo.focus();
      }
    });
    const close = (): void => {
      if (closed) return;
      closed = true;
      scope.flush(); // removes the dialog AND detaches this scope from the parent registry
    };
    dlg.addEventListener("inspector-close", close);
    // Escape reaches the dialog as `cancel`, whether or not the element saw it.
    modal.addEventListener("cancel", (event: Event) => {
      event.preventDefault(); // close through one path, so the scope is always flushed
      close();
    });
    modal.addEventListener("close", close);
    /*
     * Click outside to dismiss, which the top layer puts out of the element's
     * reach.
     *
     * The dim is the dialog's `::backdrop`, and a click there is dispatched to
     * the `<dialog>` itself, so the element's own `#nc-backdrop` handler never
     * hears it. This handler covers the dim; the element's still covers the
     * strip inside the dialog but outside the panel, and `close()` is
     * idempotent if both fire.
     *
     * Both ends of the gesture have to be on the backdrop. Otherwise selecting
     * a long path in the input and releasing the mouse past the edge of the
     * panel would close the dialog, which is a genuinely infuriating way to
     * lose what you were reading.
     */
    let pressedBackdrop = false;
    modal.addEventListener("pointerdown", (event: Event) => {
      pressedBackdrop = event.target === modal;
    });
    modal.addEventListener("click", (event: Event) => {
      if (pressedBackdrop && event.target === modal) close();
      pressedBackdrop = false;
    });

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
    /*
     * Appended to the overlay root - the component root unless a host gave us
     * somewhere better. Where the dialog *sits* in the tree and where it is
     * *painted* are different questions once it is modal: the top layer decides
     * the second, so this decides only which part of the document owns it.
     */
    ctx.roots.overlay.appendChild(modal);
    // With a file: drive the initial load ourselves, THEN open (status is 'loading' by the time the
    // `open` attribute lands, so the component's own open->auto-submit is suppressed - no double load).
    // Empty: leave the store URL unset and mark 'ready' so the component shows its "enter a path"
    // empty state (the path bar + Load are always visible) for the user to type any store URL.
    if (file) void runLoad(file);
    else dlg.setAttribute("status", "ready");
    dlg.setAttribute("open", "");
    if (typeof modal.showModal === "function") modal.showModal();
    else modal.setAttribute("open", ""); // a browser without dialog support still sees it
  }

  return { open: (file: string) => open(file), openEmpty: () => open(null) };
}
