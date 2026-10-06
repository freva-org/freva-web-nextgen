// The Inspect tab's content: `<data-inspector>` reading a store's metadata in the browser. The
// inspector module loads on demand; the tab can close at any point of that, and nothing is
// attached or loaded for a closed tab.
//
// Its 3D viewer (GridLook, in a sandboxed frame) is off unless the site opts in; then the
// inspector itself decides per store, and keeps it off for a store that needs a token.
//
// The tab names the store and closes it, so the inspector is `embedded` (no dialog of its own),
// and `view` says which of its views to open on - through its attributes, never its internals.

import { Widget } from "@lumino/widgets";

import type * as DataInspector from "@freva-org/data-inspector";

import type { IFrevaAuth } from "./token.js";

type InspectorModule = typeof DataInspector;

const VIEWER_OFF = "The 3D viewer is not enabled on this site.";

export class InspectorContent extends Widget {
  private element: HTMLElement | null = null;
  private detach: (() => void) | null = null;

  constructor(
    private readonly url: string,
    private readonly auth: IFrevaAuth | null,
    private readonly loadModule: () => Promise<InspectorModule> = () =>
      import("@freva-org/data-inspector"),
    /** Whether the site allows GridLook (`gridlook` in the panel's settings). */
    private readonly viewer = false,
    /** Open on the 3D viewer (View on globe) rather than the metadata. */
    private readonly globe = false,
  ) {
    super();
    this.addClass("jp-FrevaData-inspector");
  }

  async start(onClose: () => void): Promise<void> {
    const module = await this.loadModule();
    // Closed while the module loaded: nothing to attach.
    if (this.isDisposed) return;
    const element = document.createElement("data-inspector");
    this.element = element;
    // The site's policy, which no read changes (the inspector's `viewer-off`).
    if (!this.viewer) element.setAttribute("viewer-off", VIEWER_OFF);
    element.setAttribute("embedded", "");
    element.setAttribute("view", this.globe && this.viewer ? "viewer" : "metadata");
    element.setAttribute("file", this.url);
    this.node.append(element);
    const auth = this.auth;
    const controller = module.attachInspector(element as never, {
      getAuthHeaders:
        auth && auth.host
          ? module.scopedBearerAuth({
              getToken: async () => (auth.signedIn ? auth.accessToken() : null),
              origins: [auth.host],
            })
          : () => ({}),
      ...(auth && auth.host ? { signIn: () => auth.login() } : {}),
    });
    this.detach = () => controller.detach();
    element.addEventListener("inspector-close", onClose);
    // Closing detaches the controller, which cancels this read.
    await controller.load(this.url);
    if (this.isDisposed) return;
    element.setAttribute("open", "");
  }

  /**
   * Shows the 3D viewer (the read done): null when it shows, else why it cannot (the inspector's
   * own reason, e.g. a protected store with no share link).
   */
  showViewer(): string | null {
    const element = this.element as (HTMLElement & { activeView?: string }) | null;
    if (this.isDisposed || !element?.hasAttribute("open")) return "The store is not open.";
    const blocked = element.getAttribute("viewer-off") || element.getAttribute("viewer-disabled");
    if (blocked) return blocked;
    if (element.getAttribute("status") !== "ready") return "The store could not be read.";
    element.setAttribute("view", "viewer");
    return element.activeView === "viewer" ? null : "The 3D viewer cannot show this store.";
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.detach?.();
    this.detach = null;
    super.dispose();
  }
}
