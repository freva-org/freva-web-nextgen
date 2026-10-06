// @vitest-environment jsdom
// The panel's card: the selected node and its actions, the primary one labelled and first. Clicks
// on a row only select it - however many, however slow; the primary action runs from its button
// or Ctrl/Cmd+Enter.
import { describe, expect, it, vi } from "vitest";

// jsdom has no DragEvent, which Lumino's widgets refer to when they load.
(globalThis as { DragEvent?: unknown }).DragEvent ??= class extends MouseEvent {};
// Nor matchMedia, which JupyterLab's UI components read when they load.
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  addListener: () => undefined,
  removeListener: () => undefined,
})) as never;
const { CommandRegistry } = await import("@lumino/commands");
const { Widget } = await import("@lumino/widgets");
const { DataPanel } = await import("../src/panel.js");
const { accentOf, askIcon, borrowedIcon, launcherIcons, openIcon, linkIcon } =
  await import("../src/icons.js");

const OPEN = "freva-data:open-in-notebook";
const INSPECT = "freva-data:inspect";
const COPY = "freva-data:copy-url";

function setup() {
  const commands = new CommandRegistry();
  const ran: Array<[string, unknown]> = [];
  const panel = new DataPanel({
    commands,
    actions: [INSPECT, OPEN, COPY],
    defaultAction: OPEN,
    looks: { [COPY]: { short: "Copy", done: "Copied" }, [INSPECT]: { short: "Inspect" } },
  });
  // Added after the panel, as the extension does.
  const add = (id: string, label: string, icon?: typeof openIcon) =>
    commands.addCommand(id, {
      label,
      caption: `${label}, explained`,
      ...(icon ? { icon } : {}),
      isEnabled: (args) => panel.target(args)?.kind === "dataset",
      execute: (args) => void ran.push([id, panel.target(args)?.id]),
    });
  add(OPEN, "Open notebook", openIcon);
  add(INSPECT, "Inspect");
  add(COPY, "Copy URL", linkIcon);
  // As the extension does: a new selection updates the commands.
  panel.selectionChanged.connect(() =>
    [OPEN, INSPECT, COPY].forEach((id) => commands.notifyCommandChanged(id)),
  );
  Widget.attach(panel, document.body);
  const tree = panel.node.querySelector<HTMLElement>(".jp-FrevaData-tree")!;
  const row = (id: string, kind: "dataset" | "directory", name: string) => {
    panel.nodes.set(id, { id, kind, name, path: id } as never);
    const element = document.createElement("div");
    element.setAttribute("data-dt-row", id);
    element.tabIndex = 0;
    tree.append(element);
    return element;
  };
  const button = (id: string) =>
    panel.node.querySelector<HTMLButtonElement>(`.jp-FrevaData-action[data-command="${id}"]`)!;
  return { panel, commands, ran, row, button };
}

const click = (element: HTMLElement, timeStamp: number) => {
  const event = new MouseEvent("click", { bubbles: true });
  Object.defineProperty(event, "timeStamp", { value: timeStamp });
  element.dispatchEvent(event);
};

describe("the data panel's card", () => {
  it("before a selection: how to start, and no actions", () => {
    const { panel } = setup();
    const card = panel.node.querySelector(".jp-FrevaData-selection")!;
    expect(card.classList.contains("jp-mod-empty")).toBe(true);
    expect(card.textContent).toMatch(/Select a dataset/);
    const actions = panel.node.querySelector(".jp-FrevaData-actions")!;
    expect(actions.classList.contains("lm-mod-hidden")).toBe(true);
    panel.dispose();
  });

  it("names the selected dataset, its kind and path; the primary action leads, every action labelled", () => {
    const { panel, row, button } = setup();
    click(row("s3://data/wind.zarr/", "dataset", "wind.zarr"), 1);
    const card = panel.node.querySelector(".jp-FrevaData-selection")!;
    expect(card.classList.contains("jp-mod-empty")).toBe(false);
    expect(card.querySelector(".jp-FrevaData-actions")!.classList.contains("lm-mod-hidden")).toBe(
      false,
    );
    expect(card.querySelector(".jp-FrevaData-selectedName")!.textContent).toBe("wind.zarr");
    expect(card.querySelector(".jp-FrevaData-kind")!.textContent).toBe("Dataset");
    expect(card.querySelector(".jp-FrevaData-selectedPath")!.textContent).toBe(
      "s3://data/wind.zarr/",
    );
    const order = [...card.querySelectorAll<HTMLElement>(".jp-FrevaData-action[data-command]")].map(
      (b) => b.dataset.command,
    );
    expect(order).toEqual([OPEN, INSPECT, COPY]);
    const open = button(OPEN);
    expect(open.classList.contains("jp-mod-primary")).toBe(true);
    expect(open.getAttribute("aria-disabled")).toBe("false");
    expect(open.textContent).toBe("Open notebook");
    expect(open.title).toMatch(/^Open notebook: Open notebook, explained \(/);
    expect(open.querySelector(".jp-FrevaData-actionIcon svg")).not.toBeNull();
    // The others are tiles: an icon and a short label under it, the full name for assistive
    // technology and in the tooltip.
    expect(button(COPY).classList.contains("jp-mod-tile")).toBe(true);
    expect(button(COPY).textContent).toBe("Copy");
    expect(button(COPY).getAttribute("aria-label")).toBe("Copy URL");
    expect(button(COPY).querySelector("svg")).not.toBeNull();
    expect(button(INSPECT).textContent).toBe("Inspect");
    panel.dispose();
  });

  it("a folder: what to do inside it, its data actions disabled", () => {
    const { panel, row, button, ran } = setup();
    click(row("s3://data/", "directory", "data"), 1);
    expect(panel.node.querySelector(".jp-FrevaData-kind")!.textContent).toBe("Folder");
    expect(
      panel.node.querySelector(".jp-FrevaData-selected .jp-FrevaData-hint")!.textContent,
    ).toMatch(/Pick a dataset inside/);
    // Disabled, but still hoverable: its tooltip says why; a click does nothing.
    expect(button(OPEN).getAttribute("aria-disabled")).toBe("true");
    expect(button(OPEN).disabled).toBe(false);
    button(OPEN).click();
    expect(ran).toEqual([]);
    panel.dispose();
  });

  it("an action that ran says so for a moment", async () => {
    vi.useFakeTimers();
    const { panel, row, button } = setup();
    click(row("s3://data/wind.zarr/", "dataset", "wind.zarr"), 1);
    button(COPY).click();
    await vi.advanceTimersByTimeAsync(0);
    expect(button(COPY).textContent).toBe("Copied");
    expect(button(COPY).classList.contains("jp-mod-done")).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(button(COPY).textContent).toBe("Copy");
    vi.useRealTimers();
    panel.dispose();
  });

  it("a narrow panel's More actions: a menu of every action but the primary", () => {
    const { panel, row } = setup();
    click(row("s3://data/wind.zarr/", "dataset", "wind.zarr"), 1);
    const more = panel.node.querySelector<HTMLButtonElement>(".jp-FrevaData-action.jp-mod-more")!;
    expect(more.getAttribute("aria-label")).toBe("More actions");
    more.click();
    const items = [...document.querySelectorAll(".jp-FrevaData-moreMenu .lm-Menu-itemLabel")].map(
      (item) => item.textContent,
    );
    expect(items).toEqual(["Inspect", "Copy URL"]);
    document.querySelectorAll(".jp-FrevaData-moreMenu").forEach((menu) => menu.remove());
    panel.dispose();
  });

  it("tells where else the actions are, until a row's context menu was used", () => {
    window.localStorage.clear();
    const { panel, row } = setup();
    const tip = panel.node.querySelector(".jp-FrevaData-tip")!;
    expect(tip.textContent).toMatch(/Right-click a dataset/);
    expect(tip.classList.contains("lm-mod-hidden")).toBe(false);
    row("s3://data/wind.zarr/", "dataset", "wind.zarr").dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true }),
    );
    expect(tip.classList.contains("lm-mod-hidden")).toBe(true);
    panel.dispose();
    // Remembered in this browser.
    const again = setup();
    expect(
      again.panel.node.querySelector(".jp-FrevaData-tip")!.classList.contains("lm-mod-hidden"),
    ).toBe(true);
    again.panel.dispose();
    window.localStorage.clear();
  });

  it("acts on the row selected now, never on one right-clicked before", () => {
    const { panel, ran, row, button } = setup();
    const store = row("s3://data/wind.zarr/", "dataset", "wind.zarr");
    const folder = row("s3://data/EERIE/", "directory", "EERIE");
    store.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    expect(panel.target({})?.id).toBe("s3://data/wind.zarr/");
    expect(button(OPEN).getAttribute("aria-disabled")).toBe("false");
    click(folder, 10);
    expect(panel.target({})?.id).toBe("s3://data/EERIE/");
    expect(button(OPEN).getAttribute("aria-disabled")).toBe("true");
    expect(button(INSPECT).getAttribute("aria-disabled")).toBe("true");
    button(OPEN).click();
    expect(ran).toEqual([]);
    // A named node still wins (the row's own Ctrl/Cmd+Enter, a menu given its row).
    expect(panel.target({ nodeId: "s3://data/wind.zarr/" })?.id).toBe("s3://data/wind.zarr/");
    panel.dispose();
  });

  it("clicks on a row only select it, fast or slow: nothing opens", () => {
    const { panel, ran, row } = setup();
    const store = row("s3://data/wind.zarr/", "dataset", "wind.zarr");
    for (const at of [10, 120, 400, 700, 1_100, 1_150]) click(store, at);
    store.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(panel.selected?.id).toBe("s3://data/wind.zarr/");
    expect(ran).toEqual([]);
    panel.dispose();
  });

  it("the primary action runs from its button, or Ctrl/Cmd+Enter on a row", () => {
    const { panel, ran, row, button } = setup();
    const store = row("s3://data/wind.zarr/", "dataset", "wind.zarr");
    click(store, 1);
    button(OPEN).click();
    store.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }),
    );
    store.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }),
    );
    store.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(ran.map(([id]) => id)).toEqual([OPEN, OPEN, OPEN]);
    expect(ran[1]![1]).toBe("s3://data/wind.zarr/");
    panel.dispose();
  });
});

describe("the launcher's logos", () => {
  it("take the site icon's colour; a grey icon leaves the theme's", () => {
    expect(accentOf('<svg fill="#26a69a"><rect/></svg>')).toBe("#26a69a");
    expect(accentOf('<svg><path style="stroke: #F80"/></svg>')).toBe("#ff8800");
    expect(accentOf('<svg><g fill="#616161"><path/></g><path fill="#fff"/></svg>')).toBeNull();
    expect(accentOf("")).toBeNull();
    const teal = launcherIcons('<svg fill="#26a69a"/>');
    expect(teal.newNotebook.svgstr).toContain("fill:#26a69a");
    expect(teal.examples.svgstr).toContain("fill:#26a69a");
    expect(launcherIcons("").ask.svgstr).toContain("fill:var(--jp-brand-color1)");
    // One logo per card.
    expect(new Set([teal.newNotebook.svgstr, teal.examples.svgstr, teal.ask.svgstr]).size).toBe(3);
  });
});

describe("Ask ClimateClaw's icon", () => {
  it("is ClimateClaw's own logo once its command has one, until then the panel's", () => {
    const commands = new CommandRegistry();
    const icon = borrowedIcon(commands, "climateclaw:ask", askIcon);
    expect(icon()).toBe(askIcon);
    commands.addCommand("climateclaw:ask", { execute: () => undefined });
    expect(icon()).toBe(askIcon);
    const registry = new CommandRegistry();
    registry.addCommand("climateclaw:ask", { execute: () => undefined, icon: openIcon });
    expect(borrowedIcon(registry, "climateclaw:ask", askIcon)()).toBe(openIcon);
  });
});

describe("dataset code in a notebook", () => {
  it("a closing print(ds) shows the dataset's rich view instead; the example is kept as written", async () => {
    const { codeCells, notebookCode } = await import("../src/actions.js");
    const code =
      'import xarray as xr\n\nds = xr.open_dataset(\n    "https://x/t.zarr",\n    engine="zarr",\n)\nprint(ds)\n';
    expect(notebookCode(code)).toBe(
      'import xarray as xr\n\nds = xr.open_dataset(\n    "https://x/t.zarr",\n    engine="zarr",\n)\nds',
    );
    // Only a closing, top-level print of a name.
    expect(notebookCode("print(ds)\nx = 1")).toBe("print(ds)\nx = 1");
    expect(notebookCode("if True:\n    print(ds)")).toBe("if True:\n    print(ds)");
    expect(notebookCode('print("hello")')).toBe('print("hello")');
    const snippet = { label: "xarray", code };
    expect(codeCells([snippet] as never, { id: "n" } as never)[0]!.source).toMatch(/\nds$/);
    expect(snippet.code).toMatch(/print\(ds\)\n$/);
  });
});
