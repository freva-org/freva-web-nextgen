import { footerInset, headerInset, pageTheme, syncTheme } from "./notebook-embed.js";
import { mountLayer } from "../layers.js";
import { jupyterLogo } from "./jupyter-logo.js";
import { notebookUrl } from "./notebook-url.js";

export interface NotebookTarget {
  href: string;
  frame: boolean;
  datasets?: boolean;
  panel?: boolean;
}

export const OPEN_DATASET_MESSAGE = "freva-data:open-dataset";
export const SHOW_PANEL_MESSAGE = "freva-data:show-panel";
export const FRAME_ESCAPE_MESSAGE = "freva-lab-escape";
const SANDBOX =
  "allow-scripts allow-same-origin allow-downloads allow-popups allow-popups-to-escape-sandbox";

interface Sheet {
  href: string;
  root: HTMLElement;
  frame: HTMLIFrameElement;
  ready: boolean;
  pending: object[];
  show(): void;
  point(target: NotebookTarget, dataset?: string): void;
}

const sheets = new WeakMap<Document, Sheet>();

const SVG_NS = "http://www.w3.org/2000/svg";

function icon(doc: Document, path: string): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg");
  for (const [name, value] of Object.entries({
    class: "portal-notebook-icon",
    viewBox: "0 0 24 24",
    width: "15",
    height: "15",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  })) {
    svg.setAttribute(name, value);
  }
  const line = doc.createElementNS(SVG_NS, "path");
  line.setAttribute("d", path);
  svg.append(line);
  return svg;
}

function action(doc: Document, tag: "a" | "button", text: string, path: string): HTMLElement {
  const element = doc.createElement(tag);
  element.className = "portal-notebook-action";
  const label = doc.createElement("span");
  label.className = "portal-notebook-action-text";
  label.textContent = text;
  element.append(icon(doc, path), label);
  element.setAttribute("aria-label", text);
  return element;
}

function createSheet(doc: Document, target: NotebookTarget, dataset?: string): Sheet {
  const win = doc.defaultView!;
  const root = doc.createElement("div");
  root.className = "portal-notebook-sheet";
  root.dataset.portalNotebookSheet = "";
  root.dataset.closed = "";
  root.inert = true;
  const backdrop = doc.createElement("div");
  backdrop.className = "portal-notebook-backdrop";
  const frameWindow = doc.createElement("div");
  frameWindow.className = "portal-notebook-window";
  frameWindow.setAttribute("role", "dialog");
  frameWindow.setAttribute("aria-modal", "true");
  frameWindow.setAttribute("aria-label", "Notebook");
  const bar = doc.createElement("div");
  bar.className = "portal-notebook-bar";
  const title = doc.createElement("span");
  title.className = "portal-notebook-title";
  const name = doc.createElement("span");
  name.className = "portal-notebook-name";
  name.textContent = "Notebook";
  const note = doc.createElement("span");
  note.className = "portal-notebook-note";
  note.textContent = "JupyterLab, in your browser";
  title.append(...jupyterLogo(doc), name, note);
  const actions = doc.createElement("span");
  actions.className = "portal-notebook-actions";
  const open = action(
    doc,
    "a",
    "Open in a new tab",
    "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  ) as HTMLAnchorElement;
  open.dataset.portalNotebookOpen = "";
  const point = (next: NotebookTarget, nextDataset?: string): void => {
    open.href = notebookUrl(next.href, doc.baseURI, {
      theme: pageTheme(doc),
      dataset: nextDataset,
      ...(next.panel ? { panel: "data" as const } : {}),
    });
  };
  point(target, dataset);
  open.target = "_blank";
  open.rel = "noopener noreferrer";
  const close = action(doc, "button", "Close", "M6 6l12 12M18 6L6 18") as HTMLButtonElement;
  close.type = "button";
  close.dataset.portalNotebookClose = "";
  actions.append(open, close);
  bar.append(title, actions);
  const frame = doc.createElement("iframe");
  frame.className = "portal-notebook-frame";
  frame.title = "Notebook: JupyterLab in your browser";
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.setAttribute("sandbox", SANDBOX);
  frame.setAttribute("allow", "clipboard-read; clipboard-write; microphone");
  frame.src = notebookUrl(target.href, doc.baseURI, {
    dataset,
    ...(target.panel ? { panel: "data" as const } : {}),
  });
  frameWindow.append(bar, frame);
  root.append(backdrop, frameWindow);
  const layer = mountLayer(root, "sheet");

  let restoreFocus: HTMLElement | null = null;
  let madeInert: HTMLElement[] = [];
  const containFocus = (): void => {
    const layers = [
      ...doc.querySelectorAll<HTMLElement>("#portal-overlay-root, #portal-overlay-root-top"),
    ];
    const keep = [root, ...layers];
    const around = (parent: Element): void => {
      for (const child of [...parent.children]) {
        if (!(child instanceof HTMLElement) || keep.includes(child)) continue;
        if (keep.some((kept) => child.contains(kept))) {
          around(child);
        } else if (!child.inert) {
          child.inert = true;
          madeInert.push(child);
        }
      }
    };
    around(doc.body);
    const level = Number.parseInt(root.style.zIndex, 10) || 0;
    for (const host of layers) {
      for (const child of [...host.children]) {
        if (!(child instanceof HTMLElement) || child === root || child.inert) continue;
        if ((Number.parseInt(win.getComputedStyle(child).zIndex, 10) || 0) >= level) continue;
        child.inert = true;
        madeInert.push(child);
      }
    }
  };
  const releaseFocus = (): void => {
    for (const child of madeInert) child.inert = false;
    madeInert = [];
  };
  const fit = (): void => {
    frameWindow.style.setProperty("--portal-notebook-top", `${headerInset(doc)}px`);
    frameWindow.style.setProperty(
      "--portal-notebook-bottom",
      `${footerInset(doc, win.innerHeight)}px`,
    );
  };
  const hide = (): void => {
    if (root.dataset.closed !== undefined) return;
    root.dataset.closed = "";
    root.inert = true;
    releaseFocus();
    doc.documentElement.removeAttribute("data-notebook-expanded");
    win.removeEventListener("resize", fit);
    restoreFocus?.focus({ preventScroll: true });
    restoreFocus = null;
  };
  const sheet: Sheet = {
    href: target.href,
    root,
    frame,
    ready: false,
    pending: [],
    show() {
      if (root.dataset.closed === undefined) return;
      const focused = doc.activeElement;
      restoreFocus = focused instanceof HTMLElement && focused !== doc.body ? focused : null;
      delete root.dataset.closed;
      root.inert = false;
      layer.raise();
      containFocus();
      doc.documentElement.dataset.notebookExpanded = "true";
      fit();
      win.addEventListener("resize", fit);
      close.focus({ preventScroll: true });
      win.requestAnimationFrame(() => frame.contentWindow?.dispatchEvent(new Event("resize")));
    },
    point,
  };
  close.addEventListener("click", hide);
  backdrop.addEventListener("click", hide);
  doc.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape" || root.dataset.closed !== undefined) return;
      const from = event.target;
      if (from instanceof Node && from !== doc.body && !root.contains(from)) return;
      event.stopPropagation();
      hide();
    },
    true,
  );
  win.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== frame.contentWindow || event.origin !== win.location.origin) return;
    const data = event.data as { type?: unknown } | null;
    if (data?.type === FRAME_ESCAPE_MESSAGE) {
      hide();
      return;
    }
    if (data?.type !== "freva-data-ready") return;
    sheet.ready = true;
    for (const message of sheet.pending.splice(0)) send(sheet, message, win.location.origin);
  });
  syncTheme(root);
  return sheet;
}

function send(sheet: Sheet, message: object, origin: string): void {
  sheet.frame.contentWindow?.postMessage(message, origin);
}

export function openNotebook(
  target: NotebookTarget,
  dataset?: string,
  doc: Document = document,
): void {
  const win = doc.defaultView;
  if (!win) return;
  const framed = target.frame && new URL(target.href, doc.baseURI).origin === win.location.origin;
  if (!framed) {
    win.open(
      notebookUrl(target.href, doc.baseURI, {
        theme: pageTheme(doc),
        dataset,
        ...(target.panel ? { panel: "data" as const } : {}),
      }),
      "_blank",
      "noopener",
    );
    return;
  }
  const existing = sheets.get(doc);
  if (existing && existing.href === target.href) {
    const message = dataset
      ? { type: OPEN_DATASET_MESSAGE, dataset }
      : target.panel
        ? { type: SHOW_PANEL_MESSAGE }
        : null;
    if (message && existing.ready) send(existing, message, win.location.origin);
    else if (message) existing.pending.push(message);
    existing.point(target, dataset);
    existing.show();
    return;
  }
  const sheet = createSheet(doc, target, dataset);
  sheets.set(doc, sheet);
  sheet.show();
}
