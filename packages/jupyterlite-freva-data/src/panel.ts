// The left panel: `@freva-org/dataset-tree` mounted with the site's own source configuration, a
// card for the selected node with its actions (the primary one also on Ctrl/Cmd+Enter) and a tip
// on the other ways to them (the context menu, dragging), and drag-and-drop of a node's
// registered snippets onto a notebook.

import {
  mountDatasetTree,
  type DatasetTreeHandle,
  type DatasetTreeNode,
  type DatasetTreeSource,
} from "@freva-org/dataset-tree";
import type { CommandRegistry } from "@lumino/commands";
import { MimeData } from "@lumino/coreutils";
import { Drag } from "@lumino/dragdrop";
import { Signal } from "@lumino/signaling";
import { Menu, Panel, Widget } from "@lumino/widgets";

import { codeCells, displayName, type ExampleIndex, type Snippet } from "./actions.js";
import type { PanelData } from "./panel-data.js";

export const JUPYTER_CELL_MIME = "application/vnd.jupyter.cells";
const DRAG_THRESHOLD = 5;

/** Remembers every node the tree was given, so a row's id leads back to its node. */
export function recordingSource(source: DatasetTreeSource, nodes: Map<string, DatasetTreeNode>) {
  const keep = (list: readonly DatasetTreeNode[]) => {
    for (const node of list) nodes.set(node.id, node);
    return list;
  };
  const wrapped: DatasetTreeSource = {
    loadRoots: async (context) => keep(await source.loadRoots(context)),
    loadChildren: async (node, context) => keep(await source.loadChildren(node, context)),
  };
  if (source.probeAvailability) {
    wrapped.probeAvailability = (node, context) => source.probeAvailability!(node, context);
  }
  if (source.complete !== undefined) (wrapped as { complete?: boolean }).complete = source.complete;
  return wrapped;
}

async function makeSource(data: PanelData): Promise<DatasetTreeSource> {
  if (data.mode === "snapshot") {
    const { createSnapshotSource, parseDatasetTreeCatalogV1 } =
      await import("@freva-org/dataset-tree/snapshot");
    return createSnapshotSource(parseDatasetTreeCatalogV1(data.catalog));
  }
  const { createS3Source } = await import("@freva-org/dataset-tree/s3");
  const s3 = data.s3!;
  return createS3Source({
    endpoint: s3.endpoint,
    roots: s3.roots,
    style: s3.style,
    ...(s3.maxKeys !== undefined ? { maxKeys: s3.maxKeys } : {}),
    ...(s3.maxPages !== undefined ? { maxPages: s3.maxPages } : {}),
    ...(s3.requestTimeoutMs !== undefined ? { requestTimeoutMs: s3.requestTimeoutMs } : {}),
    ...(s3.retries !== undefined ? { retries: s3.retries } : {}),
    ...(s3.datasetSuffixes ? { datasetSuffixes: s3.datasetSuffixes } : {}),
  });
}

/** How a card action is drawn: a short label under its icon, and what it says once done. */
export interface ActionLook {
  /** Under the icon (the command's full label is its tooltip and accessible name). */
  short?: string;
  /** Shown in place of the label for a moment after it ran (e.g. "Copied"). */
  done?: string;
}

const DONE_MS = 1_600;

/**
 * The actions for the selected node: the primary action as a wide labelled button, the others as
 * tiles (an icon over a short label). Each is a command: shown, enabled and labelled as the command
 * says; one that ran says so for a moment ("Copied", "Opened"). In a narrow panel the tiles give
 * way to a "More actions" menu of the same commands.
 */
export class ActionBar extends Widget {
  private readonly buttons = new Map<string, HTMLButtonElement>();
  private readonly icons = new Map<string, unknown>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** The menu of the other actions, for a narrow panel. */
  readonly more: HTMLButtonElement;

  constructor(
    private readonly commands: CommandRegistry,
    ids: readonly string[],
    private readonly primary: string,
    private readonly looks: Record<string, ActionLook> = {},
  ) {
    super();
    this.addClass("jp-FrevaData-actions");
    this.node.setAttribute("role", "toolbar");
    this.node.setAttribute("aria-label", "Dataset actions");
    const order = [primary, ...ids.filter((id) => id !== primary)];
    for (const id of order) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "jp-FrevaData-action";
      button.classList.add(id === primary ? "jp-mod-primary" : "jp-mod-tile");
      button.dataset.command = id;
      const icon = document.createElement("span");
      icon.className = "jp-FrevaData-actionIcon";
      icon.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      label.className = "jp-FrevaData-actionLabel";
      button.append(icon, label);
      button.addEventListener("click", () => void this.run(id, button));
      this.buttons.set(id, button);
      this.node.append(button);
    }
    // Shown instead of the tiles when the panel is narrow (CSS).
    const more = document.createElement("button");
    more.type = "button";
    more.className = "jp-FrevaData-action jp-mod-more";
    more.title = "More actions";
    more.setAttribute("aria-label", "More actions");
    more.setAttribute("aria-haspopup", "menu");
    more.innerHTML =
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';
    more.addEventListener("click", () => {
      const menu = new Menu({ commands });
      menu.addClass("jp-FrevaData-moreMenu");
      for (const id of order.slice(1)) if (commands.hasCommand(id)) menu.addItem({ command: id });
      const box = more.getBoundingClientRect();
      menu.open(box.left, box.bottom + 2);
    });
    this.more = more;
    this.node.append(more);
    commands.commandChanged.connect(this.update, this);
    this.update();
  }

  private async run(id: string, button: HTMLButtonElement): Promise<void> {
    if (button.getAttribute("aria-disabled") === "true") return;
    await this.commands.execute(id);
    const done = this.looks[id]?.done;
    if (!done || this.isDisposed) return;
    button.classList.add("jp-mod-done");
    button.querySelector(".jp-FrevaData-actionLabel")!.textContent = done;
    clearTimeout(this.timers.get(id));
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        button.classList.remove("jp-mod-done");
        this.update();
      }, DONE_MS),
    );
  }

  update(): void {
    for (const [id, button] of this.buttons) {
      if (!this.commands.hasCommand(id)) {
        button.hidden = true;
        continue;
      }
      const label = this.commands.label(id);
      const caption = this.commands.caption(id);
      const keys = id === this.primary ? ` (${PRIMARY_KEYS})` : "";
      if (!this.timers.has(id)) {
        button.querySelector(".jp-FrevaData-actionLabel")!.textContent =
          id === this.primary ? label : (this.looks[id]?.short ?? label);
      }
      button.title =
        caption && caption !== label ? `${label}: ${caption}${keys}` : `${label}${keys}`;
      button.setAttribute("aria-label", label);
      button.hidden = !this.commands.isVisible(id);
      // Disabled but focusable and hoverable, so its tooltip (the caption) can say why.
      button.setAttribute("aria-disabled", String(!this.commands.isEnabled(id)));
      const icon = this.commands.icon(id);
      if (icon !== this.icons.get(id)) {
        this.icons.set(id, icon);
        const host = button.querySelector<HTMLElement>(".jp-FrevaData-actionIcon")!;
        host.replaceChildren();
        if (icon && "render" in icon) icon.render(host);
      }
    }
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.commands.commandChanged.disconnect(this.update, this);
    super.dispose();
  }
}

const PRIMARY_KEYS = /Mac/.test(globalThis.navigator?.platform ?? "") ? "⌘ Enter" : "Ctrl+Enter";

/** Records (per browser) that a row's context menu was used: the tip is not shown again. */
const TIP_KEY = "freva-data:context-menu-used";
function tipSeen(): boolean {
  try {
    return window.localStorage.getItem(TIP_KEY) === "1";
  } catch {
    return false;
  }
}
function markTipSeen(): void {
  try {
    window.localStorage.setItem(TIP_KEY, "1");
  } catch {
    // Storage unavailable: the tip stays.
  }
}

const KIND_LABEL: Record<string, string> = {
  collection: "Collection",
  directory: "Folder",
  dataset: "Dataset",
  file: "File",
};

export interface DataPanelOptions {
  commands: CommandRegistry;
  /** Command ids shown in the action bar, in order. */
  actions: string[];
  /** Their short labels and what they say once done (see `ActionLook`). */
  looks?: Record<string, ActionLook>;
  /** The primary action: the bar's labelled button, and Ctrl/Cmd+Enter on a row. */
  defaultAction: string;
}

export class DataPanel extends Panel {
  readonly nodes = new Map<string, DatasetTreeNode>();
  readonly selectionChanged = new Signal<DataPanel, DatasetTreeNode | null>(this);
  private selectedNode: DatasetTreeNode | null = null;
  private handle: DatasetTreeHandle | null = null;
  private readonly treeHost: HTMLElement;
  private readonly status: HTMLElement;
  private readonly actions: ActionBar;
  private readonly card: Panel;
  private readonly tip: Widget;
  private readonly eligible = new Map<string, Snippet[]>();
  private index: ExampleIndex | null = null;
  private ready: Promise<void> = Promise.resolve();

  constructor(private readonly options: DataPanelOptions) {
    super();
    this.addClass("jp-FrevaData");
    // The selected node and what can be done with it, above the tree.
    const card = new Panel();
    card.addClass("jp-FrevaData-selection");
    const status = new Widget();
    status.addClass("jp-FrevaData-selected");
    status.node.setAttribute("aria-live", "polite");
    this.status = status.node;
    this.actions = new ActionBar(
      options.commands,
      options.actions,
      options.defaultAction,
      options.looks,
    );
    const tip = new Widget();
    tip.addClass("jp-FrevaData-tip");
    tip.node.textContent =
      "Right-click a dataset for these actions, or drag it onto a notebook to insert it.";
    this.tip = tip;
    card.addWidget(status);
    card.addWidget(this.actions);
    card.addWidget(tip);
    this.card = card;
    this.showSelection(null);
    const tree = new Widget();
    tree.addClass("jp-FrevaData-tree");
    this.treeHost = tree.node;
    this.addWidget(card);
    this.addWidget(tree);
    this.wireEvents();
  }

  /** The card's text: the node's name, kind and path, or how to start. */
  private showSelection(node: DatasetTreeNode | null): void {
    this.card.toggleClass("jp-mod-empty", !node);
    this.actions.setHidden(!node);
    // Shown until the visitor has used a row's context menu once (in this browser).
    this.tip.setHidden(tipSeen());
    if (!node) {
      const hint = document.createElement("div");
      hint.className = "jp-FrevaData-hint";
      hint.textContent = "Select a dataset to open it in a notebook, inspect it or ask about it.";
      this.status.replaceChildren(hint);
      return;
    }
    const head = document.createElement("div");
    head.className = "jp-FrevaData-selectedHead";
    const name = document.createElement("span");
    name.className = "jp-FrevaData-selectedName";
    name.textContent = displayName(node);
    name.title = displayName(node);
    const kind = document.createElement("span");
    kind.className = `jp-FrevaData-kind jp-mod-${node.kind}`;
    kind.textContent = KIND_LABEL[node.kind] ?? node.kind;
    head.append(name, kind);
    const where = document.createElement("div");
    const data = node.kind === "dataset" || node.kind === "file";
    where.className = data ? "jp-FrevaData-selectedPath" : "jp-FrevaData-hint";
    where.textContent = data
      ? (node.path ?? node.id)
      : "Pick a dataset inside to open or inspect it.";
    if (data) where.title = node.path ?? node.id;
    this.status.replaceChildren(head, where);
  }
  get selected(): DatasetTreeNode | null {
    return this.selectedNode;
  }

  /**
   * What an action acts on: the node it names, else the selection. A right-click selects its row
   * first, so the context menu acts on it too; nothing is remembered from an earlier menu.
   */
  target(args: { nodeId?: unknown }): DatasetTreeNode | null {
    if (typeof args.nodeId === "string") return this.nodes.get(args.nodeId) ?? null;
    return this.selectedNode;
  }

  /** The verified snippets for a node, computed once. */
  async snippets(node: DatasetTreeNode): Promise<Snippet[]> {
    const cached = this.eligible.get(node.id);
    if (cached) return cached;
    const list = this.index ? await this.index.eligibleSnippets(node) : [];
    this.eligible.set(node.id, list);
    return list;
  }

  load(
    data: PanelData,
    index: ExampleIndex,
    searchIndexUrl: string | null,
    loadSearchIndex: (url: string) => Promise<unknown>,
  ): Promise<void> {
    this.index = index;
    this.ready = (async () => {
      const source = recordingSource(await makeSource(data), this.nodes);
      this.handle = mountDatasetTree(this.treeHost, {
        source,
        initialExpandedIds: data.expand,
        accessExamples: (node) => index.accessExamples(node),
        labels: { emptyBadge: "no data yet" },
        status: { tone: data.mode === "s3" ? "live" : "snapshot", label: data.statusLabel },
        ...(data.searchResultLimit ? { searchResultLimit: data.searchResultLimit } : {}),
      });
      if (searchIndexUrl) {
        loadSearchIndex(searchIndexUrl).then(
          (parsed) => {
            // A result that was never browsed to is still a node the actions can work on.
            const entries = (parsed as { entries?: readonly DatasetTreeNode[] }).entries ?? [];
            for (const entry of entries) {
              if (!this.nodes.has(entry.id)) this.nodes.set(entry.id, entry);
            }
            this.handle?.setSearchIndex(parsed as never);
          },
          (error: unknown) =>
            console.warn("Data panel: the search index could not be used.", error),
        );
      }
    })();
    return this.ready.catch((error: unknown) => this.fail(error));
  }

  fail(error: unknown): void {
    const note = document.createElement("p");
    note.className = "jp-FrevaData-error";
    note.textContent = `The data panel could not start: ${error instanceof Error ? error.message : String(error)}`;
    this.treeHost.replaceChildren(note);
  }

  select(node: DatasetTreeNode | null): void {
    if (this.selectedNode?.id === node?.id) return;
    this.selectedNode = node;
    this.showSelection(node);
    if (node) void this.snippets(node).then(() => this.selectionChanged.emit(node));
    this.selectionChanged.emit(node);
  }

  private rowNode(target: EventTarget | null): DatasetTreeNode | null {
    const row = (target as HTMLElement | null)?.closest?.("[data-dt-row]") as HTMLElement | null;
    const id = row?.getAttribute("data-dt-row");
    return id ? (this.nodes.get(id) ?? null) : null;
  }

  private wireEvents(): void {
    const host = this.treeHost;
    const pick = (event: Event) => {
      const node = this.rowNode(event.target);
      if (node) this.select(node);
    };
    host.addEventListener("click", pick);
    host.addEventListener("focusin", pick);
    host.addEventListener("contextmenu", pick, true);
    host.addEventListener("contextmenu", () => {
      markTipSeen();
      this.tip.hide();
    });
    // The primary action runs on a deliberate request only - its button, or Ctrl/Cmd+Enter - never
    // on clicks: two slow clicks on a row (to open and close it) must not create a notebook.
    const runDefault = (node: DatasetTreeNode) => {
      this.select(node);
      void this.options.commands.execute(this.options.defaultAction, { nodeId: node.id });
    };
    host.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
      const node = this.rowNode(event.target);
      if (node) runDefault(node);
    });

    let press: { x: number; y: number; node: DatasetTreeNode } | null = null;
    host.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const node = this.rowNode(event.target);
      if (!node) return;
      press = { x: event.clientX, y: event.clientY, node };
      void this.snippets(node);
    });
    host.addEventListener("pointermove", (event) => {
      if (!press) return;
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) < DRAG_THRESHOLD) return;
      const node = press.node;
      press = null;
      const snippets = this.eligible.get(node.id);
      if (!snippets || snippets.length === 0) return;
      event.preventDefault();
      this.startDrag(node, snippets, event.clientX, event.clientY);
    });
    const release = () => {
      press = null;
    };
    host.addEventListener("pointerup", release);
    host.addEventListener("pointercancel", release);
  }

  /** Drag the node's snippets as notebook cells; a notebook inserts them where they are dropped. */
  private startDrag(node: DatasetTreeNode, snippets: Snippet[], x: number, y: number): void {
    const mimeData = new MimeData();
    mimeData.setData(JUPYTER_CELL_MIME, codeCells(snippets, node));
    const image = document.createElement("div");
    image.className = "jp-FrevaData-dragImage";
    image.textContent = `${displayName(node)} - ${snippets.length} cell${snippets.length === 1 ? "" : "s"}`;
    const drag = new Drag({
      mimeData,
      dragImage: image,
      proposedAction: "copy",
      supportedActions: "copy",
      source: this,
    });
    void drag.start(x, y);
  }

  dispose(): void {
    this.handle?.destroy();
    this.handle = null;
    super.dispose();
  }
}
