// components/inspector.ts - Inspect and Aggregate via @freva-org/data-inspector.
// A normal dependency, imported lazily on first use ONLY, so it never enters the main bundle.
// `cfg.inspectorUrl` overrides that with an explicit ESM URL, for a host serving its own copy.
//
// The read itself is the package's `attachInspector`. This module adds the Data Browser's side:
//   • the modal <dialog> the element lives in, its placement and dismissal;
//   • the bearer only on freva-rest's origins (Api.authHeadersFor, which also updates the
//     signed-in state), and the host's `signIn` for the "Sign in" button;
//   • conversion only when enabled (`enableHeavyOps` + `dataPortalBase`);
//   • the Aggregate gate shared by the pickbar and the details panel.

import type { AppContext } from "../context.js";
import { MAX_AGGREGATE_FILES } from "../types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type InspectorModule = any;
let modPromise: Promise<InspectorModule> | null = null;
// `customElements.define('data-inspector', …)` can only run ONCE per page, so the inspector
// is necessarily process-global: the first configured source wins. A later mount with a different
// one keeps the first and warns, rather than silently registering nothing.
let loadedUrl: string | null = null;

// The dynamic import is behind an injectable seam so a test can drive the load + both file paths
// without a real chunk or network. No url imports the packaged dependency; a url imports that copy.
const realImport = (url?: string): Promise<InspectorModule> =>
  url ? import(/* @vite-ignore */ url) : import("@freva-org/data-inspector");
let importModule: (url?: string) => Promise<InspectorModule> = realImport;
export function setInspectorImporterForTests(
  fn: ((url?: string) => Promise<InspectorModule>) | null,
): void {
  importModule = fn ?? realImport;
  modPromise = null;
  loadedUrl = null;
}

export async function loadInspector(url?: string): Promise<InspectorModule> {
  const source = url || null;
  if (modPromise && source !== loadedUrl) {
    console.warn(
      `[freva-databrowser] data-inspector already loaded from ${loadedUrl ?? "the packaged dependency"}; ignoring a second source (${source ?? "the packaged dependency"}). The custom element can only be registered once per page.`,
    );
  }
  if (!modPromise) {
    loadedUrl = source;
    modPromise = importModule(source ?? undefined)
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

/** Whether Aggregate can be pressed for `n` selected files, and what to say when it cannot. */
export interface AggregateGate {
  disabled: boolean;
  /** Tooltip. */
  why: string;
  /** A one-line note under a disabled button (null when enabled). */
  note: string | null;
}

/**
 * Aggregate converts server-side, so it needs the data-portal and a signed-in user; with a host
 * `signIn` the dialog still opens and offers "Sign in". Shared by the pickbar and details panel.
 */
export function aggregateGate(ctx: AppContext, n: number): AggregateGate {
  // Aggregate opens the inspector dialog, so it is gated exactly like Inspect.
  if (!inspectEnabled(ctx)) {
    return {
      disabled: true,
      why: `Aggregate - ${inspectDisabledReason(ctx).toLowerCase()}`,
      note: "Aggregate is disabled",
    };
  }
  if (n > MAX_AGGREGATE_FILES) {
    return {
      disabled: true,
      why: `Aggregation handles up to ${MAX_AGGREGATE_FILES} files - deselect ${n - MAX_AGGREGATE_FILES} to enable it`,
      note: `Aggregate: max ${MAX_AGGREGATE_FILES} files`,
    };
  }
  const signedIn = ctx.isSignedIn();
  if (!signedIn && !ctx.cfg.signIn) {
    return { disabled: true, why: "Aggregate - needs sign-in", note: "Aggregate needs sign-in" };
  }
  if (!ctx.cfg.enableHeavyOps) {
    return {
      disabled: true,
      why: "Aggregate - data-portal not enabled",
      note: "Aggregate needs the data-portal",
    };
  }
  return {
    disabled: false,
    why: signedIn
      ? "Combine the selected files into one dataset"
      : "Combine the selected files into one dataset (you will be asked to sign in)",
    note: null,
  };
}

export interface InspectorController {
  open(file: string): Promise<void>;
  /** Open the inspector with no file - the empty state prompts the user to enter a store URL. */
  openEmpty(): Promise<void>;
  /** Open the aggregation dialog for several files: the user configures, then aggregates. */
  openAggregate(files: string[]): Promise<void>;
}

export function createInspector(ctx: AppContext): InspectorController {
  const dis = ctx.dis;

  async function open(target: string | string[] | null): Promise<void> {
    if (!inspectEnabled(ctx)) {
      ctx.toast("warn", inspectDisabledReason(ctx));
      return;
    }
    const files = Array.isArray(target) ? target : null;
    const file = typeof target === "string" ? target : null;
    ctx.log(
      "info",
      files
        ? `Aggregating ${files.length} files…`
        : file
          ? `Inspecting ${file.split("/").pop() ?? file}…`
          : "Opening the inspector…",
    );
    let mod: InspectorModule;
    try {
      mod = await loadInspector(ctx.cfg.inspectorUrl);
    } catch {
      ctx.toast("error", "Inspector unavailable — the data-inspector module could not be loaded.");
      return;
    }

    // An `inspectorUrl` pointing at a copy that predates the pipeline cannot drive a read.
    if (typeof mod.attachInspector !== "function") {
      ctx.toast("error", "Inspector unavailable \u2014 this data-inspector build is too old.");
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

    // Listens to the element's Load / Retry / Aggregate / "Sign in" events; closing the dialog
    // detaches it, cancelling whatever is in flight.
    const inspector = mod.attachInspector(dlg, {
      // Share links always go through the data-portal; files are converted only with heavy ops.
      dataPortalBase: ctx.cfg.dataPortalBase,
      dataLoader: ctx.cfg.enableHeavyOps,
      getAuthHeaders: (url: string) => ctx.api.authHeadersFor(url),
      signIn: ctx.cfg.signIn,
    });
    scope.add(() => inspector.detach());

    if (files) {
      dlg.setAttribute("is-aggregation", "");
      dlg.setAttribute("file", JSON.stringify(files));
    } else if (file) dlg.file = file;
    /*
     * Appended to the overlay root - the component root unless a host gave us
     * somewhere better. Where the dialog *sits* in the tree and where it is
     * *painted* are different questions once it is modal: the top layer decides
     * the second, so this decides only which part of the document owns it.
     */
    ctx.roots.overlay.appendChild(modal);
    // With a file: load, THEN open - status is already 'loading', so the element's own
    // open->auto-submit does not start a second read. Otherwise 'ready': the path prompt or the
    // aggregation form waits for the user.
    if (file) void inspector.load(file);
    else dlg.setAttribute("status", "ready");
    dlg.setAttribute("open", "");
    if (typeof modal.showModal === "function") modal.showModal();
    else modal.setAttribute("open", ""); // a browser without dialog support still sees it
  }

  return {
    open: (file: string) => open(file),
    openEmpty: () => open(null),
    openAggregate: (files: string[]) => open([...files]),
  };
}
