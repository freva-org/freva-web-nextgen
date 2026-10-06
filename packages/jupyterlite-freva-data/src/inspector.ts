// Inspect: `<data-inspector>` in a main-area tab, reading the store's metadata in the browser.
// The 3D viewer tab (GridLook, a third-party viewer) only where the site opts in. A bearer goes
// to the Freva host only, and only when signed in; never to GridLook.

import { MainAreaWidget } from "@jupyterlab/apputils";

import { InspectorContent } from "./inspector-content.js";
import type { IFrevaAuth } from "./token.js";

export { InspectorContent } from "./inspector-content.js";

export function inspectorWidget(
  url: string,
  name: string,
  auth: IFrevaAuth | null,
  viewer = false,
  globe = false,
): MainAreaWidget<InspectorContent> {
  const content = new InspectorContent(url, auth, undefined, viewer, globe);
  const widget = new MainAreaWidget({ content });
  widget.id = `freva-data-inspector-${Math.random().toString(36).slice(2, 10)}`;
  widget.title.label = globe && viewer ? `Globe: ${name}` : `Inspect ${name}`;
  widget.title.caption = url;
  widget.title.closable = true;
  widget.addClass("jp-FrevaData-inspectorPanel");
  return widget;
}
