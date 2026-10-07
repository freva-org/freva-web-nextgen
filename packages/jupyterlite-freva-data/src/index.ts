// The site data panel: the portal's dataset tree in JupyterLite (or JupyterLab), with every
// action a command - open in a new notebook, insert into the current one (also by drag-and-drop),
// inspect, ask ClimateClaw (when installed), copy URL or code - and launcher cards for the site.

import type { JupyterFrontEnd, JupyterFrontEndPlugin } from "@jupyterlab/application";
import { ILayoutRestorer } from "@jupyterlab/application";
import { Clipboard, Dialog, ICommandPalette, Notification } from "@jupyterlab/apputils";
import { PageConfig, URLExt } from "@jupyterlab/coreutils";
import { ILauncher } from "@jupyterlab/launcher";
import { INotebookTracker } from "@jupyterlab/notebook";
import { ISettingRegistry } from "@jupyterlab/settingregistry";
import { LabIcon } from "@jupyterlab/ui-components";
import type { DatasetTreeNode } from "@freva-org/dataset-tree";

import {
  ExampleIndex,
  askFor,
  codeCells,
  displayName,
  notebookBaseName,
  notebookFor,
  sha256Hex,
} from "./actions.js";
import {
  askIcon,
  borrowedIcon,
  codeIcon,
  globeIcon,
  insertIcon,
  inspectIcon,
  launcherIcons,
  linkIcon,
  openIcon,
} from "./icons.js";
import { inspectorWidget } from "./inspector.js";
import { FileCreator, isNotFound } from "./new-file.js";
import { ExampleGallery, type NotebookSummary } from "./gallery.js";
import {
  findCopy as findCopyOf,
  localCopyMemory,
  scanCopies,
  openOwnCopy,
  openStartNotebook,
  type CopyStore,
  type ListedFile,
  type OwnCopyHost,
} from "./start-notebook.js";
import { DataPanel } from "./panel.js";
import { parsePanelData } from "./panel-data.js";
import { IFrevaAuth } from "./token.js";

export { IFrevaAuth } from "./token.js";
export { DataPanel } from "./panel.js";

const PACKAGE = "@freva-org/jupyterlite-freva-data";
const PLUGIN_ID = `${PACKAGE}:plugin`;

export const CommandIds = {
  openInNotebook: "freva-data:open-in-notebook",
  insert: "freva-data:insert",
  inspect: "freva-data:inspect",
  ask: "freva-data:ask-climateclaw",
  copyUrl: "freva-data:copy-url",
  copyCode: "freva-data:copy-code",
  globe: "freva-data:view-on-globe",
  browse: "freva-data:browse",
  newNotebook: "freva-data:new-notebook",
  examples: "freva-data:example-notebooks",
  openExample: "freva-data:open-example",
  launchAsk: "freva-data:launch-climateclaw",
} as const;

/** Every action on a node (the context menu has them all). */
const ACTIONS = [
  CommandIds.openInNotebook,
  CommandIds.insert,
  CommandIds.inspect,
  CommandIds.ask,
  CommandIds.copyUrl,
  CommandIds.copyCode,
  CommandIds.globe,
];

/** The card's actions: all but Copy code, which stays in the context menu. */
const CARD_ACTIONS = [
  CommandIds.openInNotebook,
  CommandIds.insert,
  CommandIds.inspect,
  CommandIds.globe,
  CommandIds.ask,
  CommandIds.copyUrl,
];

/** The card's tiles: a short label each, and what they say once done. */
const LOOKS = {
  [CommandIds.openInNotebook]: { done: "Opened" },
  [CommandIds.insert]: { short: "Insert", done: "Inserted" },
  [CommandIds.inspect]: { short: "Inspect", done: "Opened" },
  [CommandIds.globe]: { short: "Globe", done: "Opened" },
  [CommandIds.ask]: { short: "Ask", done: "Opened" },
  [CommandIds.copyUrl]: { short: "Copy URL", done: "Copied" },
};

const DEFAULT_ACTIONS: Record<string, string> = {
  "open-in-notebook": CommandIds.openInNotebook,
  insert: CommandIds.insert,
  inspect: CommandIds.inspect,
  "ask-climateclaw": CommandIds.ask,
  "copy-url": CommandIds.copyUrl,
  "copy-code": CommandIds.copyCode,
};

const CLIMATECLAW_ASK = "climateclaw:ask";

const DATA_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g class="jp-icon3" fill="#616161"><path d="M12 3C7.6 3 4 4.3 4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6c0-1.7-3.6-3-8-3zm0 2c3.9 0 6 1.1 6 1s-2.1 1-6 1-6-1-6-1 2.1-1 6-1zm6 13c0 .1-2.1 1-6 1s-6-.9-6-1v-2.3c1.5.8 3.7 1.3 6 1.3s4.5-.5 6-1.3V18zm0-4.5c0 .1-2.1 1-6 1s-6-.9-6-1v-2.3c1.5.8 3.7 1.3 6 1.3s4.5-.5 6-1.3v2.3zm0-4.5c0 .1-2.1 1-6 1s-6-.9-6-1V8.7C7.5 9.5 9.7 10 12 10s4.5-.5 6-1.3V9z"/></g></svg>';

interface Settings {
  siteName: string;
  title: string;
  iconSvg: string;
  dataUrl: string;
  dataSha256: string;
  kernelName: string;
  defaultAction: string;
  seedNotebooks: Array<{ path: string; title?: string }>;
  /** GridLook's 3D viewer in Inspect, and "View on globe". */
  gridlook: boolean;
  /** A seed notebook (one of `seedNotebooks`) opened when the Lab starts, as the visitor's copy. */
  startNotebook: string | null;
  launcher: { newNotebook: boolean; browse: boolean; examples: boolean; ask: boolean };
}

function readSettings(raw: Record<string, unknown>): Settings {
  const s = (v: unknown, d = "") => (typeof v === "string" ? v.trim() : d);
  const launcher = (raw.launcher ?? {}) as Record<string, unknown>;
  const siteName = s(raw.siteName) || "Freva";
  const settings: Settings = {
    siteName,
    title: s(raw.title) || `${siteName} data`,
    iconSvg: s(raw.iconSvg),
    dataUrl: s(raw.dataUrl),
    dataSha256: s(raw.dataSha256).toLowerCase(),
    kernelName: s(raw.kernelName) || "freva-python",
    defaultAction: DEFAULT_ACTIONS[s(raw.defaultAction)] ?? CommandIds.openInNotebook,
    seedNotebooks: (Array.isArray(raw.seedNotebooks) ? raw.seedNotebooks : [])
      .map((n) => n as { path?: unknown; title?: unknown })
      .filter(
        (n) =>
          typeof n.path === "string" &&
          /^[A-Za-z0-9][\w ./-]*\.ipynb$/.test(n.path) &&
          !n.path.includes(".."),
      )
      .map((n) => ({
        path: n.path as string,
        ...(typeof n.title === "string" ? { title: n.title } : {}),
      })),
    gridlook: raw.gridlook === true,
    startNotebook: null,
    launcher: {
      newNotebook: launcher.newNotebook !== false,
      browse: launcher.browse !== false,
      examples: launcher.examples !== false,
      ask: launcher.ask !== false,
    },
  };
  // Only a published seed can be the start notebook.
  const start = s(raw.startNotebook);
  if (settings.seedNotebooks.some((n) => n.path === start)) settings.startNotebook = start;
  return settings;
}

/** A same-origin (or explicitly absolute http(s)) URL under the site root. */
function siteUrl(path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  return new URL(URLExt.join(PageConfig.getBaseUrl(), path), window.location.href).href;
}

async function loadSearchIndex(url: string): Promise<unknown> {
  const response = await fetch(url, { credentials: "same-origin" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const { parseDatasetTreeSearchIndexV1 } = await import("@freva-org/dataset-tree/search-index");
  return parseDatasetTreeSearchIndexV1(await response.json());
}

const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description: "The site's data panel, its actions and launcher cards.",
  autoStart: true,
  requires: [ISettingRegistry, INotebookTracker],
  optional: [ILauncher, ILayoutRestorer, ICommandPalette, IFrevaAuth],
  activate: async (
    app: JupyterFrontEnd,
    registry: ISettingRegistry,
    notebooks: INotebookTracker,
    launcher: ILauncher | null,
    restorer: ILayoutRestorer | null,
    palette: ICommandPalette | null,
    auth: IFrevaAuth | null,
  ) => {
    const { commands } = app;
    const contents = app.serviceManager.contents;
    let raw: Record<string, unknown> = {};
    try {
      raw = (await registry.load(PLUGIN_ID)).composite as Record<string, unknown>;
    } catch (error) {
      console.warn("Data panel: settings could not be loaded", error);
    }
    const settings = readSettings(raw);
    const icon = new LabIcon({
      name: `${PACKAGE}:site`,
      svgstr: /^<svg[\s>]/.test(settings.iconSvg) ? settings.iconSvg : DATA_ICON_SVG,
    });
    const logos = launcherIcons(settings.iconSvg);

    const panel = new DataPanel({
      commands,
      actions: CARD_ACTIONS,
      looks: LOOKS,
      defaultAction: settings.defaultAction,
    });
    panel.id = "freva-data-panel";
    panel.title.icon = icon;
    panel.title.caption = settings.title;
    panel.node.setAttribute("aria-label", settings.title);
    let index: ExampleIndex | null = null;

    const refresh = () => {
      for (const id of ACTIONS) commands.notifyCommandChanged(id);
    };
    panel.selectionChanged.connect(refresh);
    notebooks.currentChanged.connect(refresh);

    // Not app.contextMenuHitTest: it keeps the last context menu's row, so the card's actions
    // would stay on a store right-clicked earlier after another row was selected.
    const nodeFor = (args: Record<string, unknown>): DatasetTreeNode | null => panel.target(args);
    const isData = (node: DatasetTreeNode | null): node is DatasetTreeNode =>
      !!node && (node.kind === "dataset" || node.kind === "file");
    const urlOf = (node: DatasetTreeNode) => index?.url(node) ?? null;

    const kernelDisplayName = () => {
      const specs = app.serviceManager.kernelspecs.specs?.kernelspecs ?? {};
      return specs[settings.kernelName]?.display_name ?? "Freva Python";
    };
    // New notebooks never replace a file: only a confirmed "not found" frees a name, and the
    // lookup and the save run under a lock the origin's tabs share.
    const notebookFiles = new FileCreator<unknown>({
      lookup: async (path) => {
        try {
          await contents.get(path, { content: false });
          return "present";
        } catch (error) {
          if (isNotFound(error)) return "absent";
          throw error;
        }
      },
      save: async (path, content) => {
        await contents.save(path, { type: "notebook", format: "json", content: content as never });
      },
    });
    /** A new notebook file, or null (and why, to the visitor) when none could be made safely. */
    const createNotebook = async (base: string, content: unknown): Promise<string | null> => {
      try {
        return await notebookFiles.create(base, ".ipynb", content);
      } catch (error) {
        Notification.error(
          `The notebook was not created: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      }
    };
    const openNotebookFile = (path: string) =>
      commands.execute("docmanager:open", {
        path,
        factory: "Notebook",
        kernel: { name: settings.kernelName },
      });

    commands.addCommand(CommandIds.openInNotebook, {
      label: "Open notebook",
      icon: openIcon,
      caption: (args) =>
        isData(nodeFor(args))
          ? "A new notebook with this dataset's registered Python access examples"
          : "Select a dataset (not a folder) to open it in a notebook",
      isEnabled: (args) => isData(nodeFor(args)),
      execute: async (args) => {
        const node = nodeFor(args);
        if (!isData(node)) return;
        const snippets = await panel.snippets(node);
        const notebook = notebookFor(node, snippets, {
          url: urlOf(node),
          siteName: settings.siteName,
          kernelName: settings.kernelName,
          kernelDisplayName: kernelDisplayName(),
        });
        const path = await createNotebook(notebookBaseName(node), notebook);
        return path ? openNotebookFile(path) : undefined;
      },
    });

    commands.addCommand(CommandIds.insert, {
      label: "Insert into notebook",
      icon: insertIcon,
      caption: (args) =>
        !isData(nodeFor(args))
          ? "Select a dataset (not a folder) to insert its code"
          : notebooks.currentWidget === null
            ? "Open a notebook first: the code goes below its active cell"
            : "Insert this dataset's registered Python access examples below the active cell (or drag the dataset onto the notebook)",
      isEnabled: (args) => {
        const node = nodeFor(args);
        return isData(node) && notebooks.currentWidget !== null;
      },
      execute: async (args) => {
        const node = nodeFor(args);
        const current = notebooks.currentWidget;
        if (!isData(node) || !current?.content.model) return;
        const snippets = await panel.snippets(node);
        if (!snippets.length) {
          Notification.info(`No registered Python access example for ${displayName(node)}.`);
          return;
        }
        const notebook = current.content;
        const at = Math.max(0, notebook.activeCellIndex) + 1;
        notebook.model!.sharedModel.insertCells(at, codeCells(snippets, node) as never);
        notebook.activeCellIndex = at;
        app.shell.activateById(current.id);
      },
    });

    /** Inspect in a new tab; `globe`: then straight to the 3D viewer, or say why it cannot. */
    const inspect = async (args: Record<string, unknown>, globe: boolean) => {
      const node = nodeFor(args);
      const url = node ? urlOf(node) : null;
      if (!node || !url) return;
      const widget = inspectorWidget(url, displayName(node), auth, settings.gridlook, globe);
      app.shell.add(widget, "main");
      app.shell.activateById(widget.id);
      try {
        await widget.content.start(() => widget.dispose());
      } catch (error) {
        Notification.error(
          `Inspect failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
      if (!globe || widget.isDisposed) return;
      const why = widget.content.showViewer();
      if (why) Notification.info(`View on globe: ${why}`, { autoClose: 8000 });
    };

    commands.addCommand(CommandIds.inspect, {
      label: "Inspect",
      icon: inspectIcon,
      caption: (args) =>
        isData(nodeFor(args))
          ? "Read the store's metadata in a new tab"
          : "Select a dataset (not a folder) to read its metadata",
      isEnabled: (args) => {
        const node = nodeFor(args);
        return isData(node) && !!urlOf(node);
      },
      execute: (args) => inspect(args, false),
    });

    commands.addCommand(CommandIds.ask, {
      label: "Ask ClimateClaw",
      icon: borrowedIcon(commands, CLIMATECLAW_ASK, askIcon),
      caption: "Open ClimateClaw with a question about this dataset",
      isVisible: () => commands.hasCommand(CLIMATECLAW_ASK),
      isEnabled: (args) => commands.hasCommand(CLIMATECLAW_ASK) && !!nodeFor(args),
      execute: (args) => {
        const node = nodeFor(args);
        if (!node) return;
        const { prompt, context } = askFor(node, urlOf(node), settings.siteName);
        return commands.execute(CLIMATECLAW_ASK, { prompt, context });
      },
    });

    commands.addCommand(CommandIds.copyUrl, {
      label: "Copy URL",
      icon: linkIcon,
      caption: (args) => {
        const node = nodeFor(args);
        if (!node) return "Select an item to copy its address";
        return urlOf(node) ? "Copy its address" : "This item has no address to copy";
      },
      isEnabled: (args) => {
        const node = nodeFor(args);
        return !!node && !!urlOf(node);
      },
      execute: (args) => {
        const node = nodeFor(args);
        const url = node ? urlOf(node) : null;
        if (url) Clipboard.copyToSystem(url);
      },
    });

    commands.addCommand(CommandIds.copyCode, {
      label: "Copy code",
      icon: codeIcon,
      isEnabled: (args) => {
        const node = nodeFor(args);
        return isData(node) && !!index && index.accessExamples(node).length > 0;
      },
      execute: async (args) => {
        const node = nodeFor(args);
        if (!isData(node) || !index) return;
        const verified = await panel.snippets(node);
        const snippets = verified.length ? verified : index.pythonExamples(node);
        if (snippets.length) Clipboard.copyToSystem(snippets.map((s) => s.code).join("\n\n"));
      },
    });

    commands.addCommand(CommandIds.globe, {
      label: "View on globe",
      icon: globeIcon,
      caption: (args) =>
        !settings.gridlook
          ? "Not enabled on this site"
          : isData(nodeFor(args))
            ? "Show the store on GridLook's 3D globe (stores readable without a token)"
            : "Select a dataset (not a folder) to see it on the globe",
      isEnabled: (args) => {
        const node = nodeFor(args);
        return settings.gridlook && isData(node) && !!urlOf(node);
      },
      execute: (args) => (settings.gridlook ? inspect(args, true) : undefined),
    });

    commands.addCommand(CommandIds.browse, {
      label: "Browse data",
      caption: settings.title,
      icon,
      execute: () => app.shell.activateById(panel.id),
    });

    commands.addCommand(CommandIds.newNotebook, {
      label: `New ${settings.siteName} notebook`,
      caption: "A new notebook on the Freva Python kernel",
      icon: logos.newNotebook,
      execute: async () => {
        // Named by the contents manager, as JupyterLab's own "New Notebook" is: JupyterLite counts
        // untitled names itself and hands an existing `Untitled.ipynb` out again otherwise (which
        // jupyterlite-ai's first chat backup then renames into `chats/`, notebook and all).
        const { path } = await contents.newUntitled({ type: "notebook" });
        await contents.save(path, {
          type: "notebook",
          format: "json",
          content: {
            nbformat: 4,
            nbformat_minor: 5,
            metadata: {
              kernelspec: {
                name: settings.kernelName,
                display_name: kernelDisplayName(),
                language: "python",
              },
            },
            cells: [
              {
                cell_type: "code",
                id: "cell-0",
                source: "",
                metadata: {},
                outputs: [],
                execution_count: null,
              },
            ],
          } as never,
        });
        return openNotebookFile(path);
      },
    });

    /** The visitor's own copies of the site's notebooks: made once, theirs after that. */
    const readSeed = async (path: string) =>
      (await contents.get(path, { content: true, type: "notebook" })).content as unknown;
    /** The visitor's files, for finding their copies by what each notebook says it is. */
    const copyStore: CopyStore = {
      list: async (dir) =>
        ((await contents.get(dir, { content: true })).content ?? []) as ListedFile[],
      read: async (path) => (await contents.get(path, { content: true, type: "notebook" })).content,
      isNotFound,
    };
    const copyMemory = localCopyMemory();
    const findCopy = (seed: string): Promise<string | null> =>
      findCopyOf(seed, copyStore, copyMemory);
    const ownCopies: OwnCopyHost = {
      readSeed,
      findCopy,
      exclusive: (fn) => notebookFiles.exclusive(fn),
      allocate: (base, content, locked) => notebookFiles.allocate(base, ".ipynb", content, locked),
      open: (path: string, activate: boolean) =>
        commands.execute("docmanager:open", {
          path,
          factory: "Notebook",
          kernel: { name: settings.kernelName },
          options: { activate },
        }),
    };

    commands.addCommand(CommandIds.openExample, {
      label: (args) => String(args.title ?? args.path ?? "Example notebook"),
      execute: async (args) => {
        const seed = settings.seedNotebooks.find((n) => n.path === args.path);
        if (!seed) return;
        // Seeds stay as published: the visitor works on their own copy, made the first time.
        try {
          return await openOwnCopy(seed.path, ownCopies);
        } catch (error) {
          Notification.error(
            `The example did not open: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    });

    const summaries = new Map<string, Promise<NotebookSummary>>();
    commands.addCommand(CommandIds.examples, {
      label: "Example notebooks",
      caption: "Pick one of the site's worked examples: it opens as your own copy",
      icon: logos.examples,
      isEnabled: () => settings.seedNotebooks.length > 0,
      execute: async () => {
        let chosen: string | null = null;
        let dialog: Dialog<unknown> | null = null;
        let scan: Promise<Map<string, string>> | null = null;
        const gallery = new ExampleGallery({
          seeds: settings.seedNotebooks,
          start: settings.startNotebook,
          read: readSeed,
          // One search for the whole gallery.
          hasCopy: async (path) => {
            scan ??= scanCopies(copyStore);
            return (await scan).has(path);
          },
          choose: (seed) => {
            chosen = seed.path;
            dialog?.resolve(0);
          },
          cache: summaries,
        });
        dialog = new Dialog({
          title: "Start from an example",
          body: gallery,
          buttons: [Dialog.cancelButton({ label: "Close" })],
          focusNodeSelector: ".jp-FrevaData-gallerySearch",
        });
        dialog.addClass("jp-FrevaData-galleryDialog");
        await dialog.launch();
        if (chosen) {
          const seed = settings.seedNotebooks.find((n) => n.path === chosen);
          await commands.execute(CommandIds.openExample, {
            path: chosen,
            title: seed?.title ?? chosen,
          });
        }
      },
    });

    commands.addCommand(CommandIds.launchAsk, {
      label: "Ask ClimateClaw",
      caption: "Open a ClimateClaw chat",
      icon: borrowedIcon(commands, CLIMATECLAW_ASK, logos.ask),
      isVisible: () => commands.hasCommand(CLIMATECLAW_ASK),
      execute: () => commands.execute(CLIMATECLAW_ASK, {}),
    });

    // After ClimateClaw (rank 10), before the file browser (rank 100).
    app.shell.add(panel, "left", { rank: 20 });
    restorer?.add(panel, panel.id);
    for (const command of [CommandIds.browse, CommandIds.newNotebook, CommandIds.examples]) {
      palette?.addItem({ command, category: settings.siteName });
    }

    const category = settings.siteName;
    if (launcher) {
      if (settings.launcher.newNotebook)
        launcher.add({ command: CommandIds.newNotebook, category, rank: 1 });
      if (settings.launcher.browse) launcher.add({ command: CommandIds.browse, category, rank: 2 });
      if (settings.launcher.examples && settings.seedNotebooks.length) {
        launcher.add({ command: CommandIds.examples, category, rank: 3 });
      }
      if (settings.launcher.ask) {
        // ClimateClaw may activate after this plugin: decide once the application is up.
        void app.restored.then(() => {
          if (commands.hasCommand(CLIMATECLAW_ASK)) {
            launcher.add({ command: CommandIds.launchAsk, category, rank: 4 });
          }
        });
      }
    }

    if (settings.startNotebook) {
      const seed = settings.startNotebook;
      void app.restored
        .then(() =>
          openStartNotebook(seed, {
            ...ownCopies,
            otherDocumentOpen: (path) =>
              [...app.shell.widgets("main")].some((widget) => {
                const open = (widget as { context?: { path?: string } }).context?.path;
                return typeof open === "string" && open !== path;
              }),
          }),
        )
        .catch((error: unknown) =>
          console.warn(
            "Data panel: the start notebook did not open.",
            error instanceof Error ? error.message : error,
          ),
        );
    }

    if (!settings.dataUrl) {
      panel.fail(new Error("no panel data is configured for this site"));
      return;
    }
    try {
      const response = await fetch(siteUrl(settings.dataUrl), { credentials: "same-origin" });
      if (!response.ok) throw new Error(`the panel data answered HTTP ${response.status}`);
      const text = await response.text();
      if (settings.dataSha256 && (await sha256Hex(text)) !== settings.dataSha256) {
        throw new Error("the panel data does not match its recorded digest");
      }
      const data = parsePanelData(JSON.parse(text));
      index = new ExampleIndex(data);
      const searchIndexUrl = data.searchIndex ? siteUrl(data.searchIndex) : null;
      await panel.load(data, index, searchIndexUrl, loadSearchIndex);
    } catch (error) {
      panel.fail(error);
    }
  },
};

export default [plugin];
