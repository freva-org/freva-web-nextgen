// ClimateClaw (Freva) for JupyterLite and JupyterLab, on jupyterlite-ai's extension points: a
// provider in its registry, chat models from its `IChatModelHandler`, slash commands in its chat
// command registry, toolbar items in the chat input.
//
// Two hosts, one controller (chats.ts). Where jupyterlite-ai's chat panel plugin is disabled (the
// portal's notebook), ClimateClaw shows chats in a panel of its own and provides the chat
// tracker and jupyterlite-ai's chat commands in its place; elsewhere (pip installs)
// jupyterlite-ai's panel stays, with ClimateClaw's header items and composer controls in it.

import {
  ILabShell,
  ILayoutRestorer,
  type JupyterFrontEnd,
  type JupyterFrontEndPlugin,
} from "@jupyterlab/application";
import {
  Dialog,
  ICommandPalette,
  IThemeManager,
  IToolbarWidgetRegistry,
  Notification,
  showDialog,
  WidgetTracker,
} from "@jupyterlab/apputils";
import { PageConfig, PathExt, URLExt } from "@jupyterlab/coreutils";
import { INotebookTracker } from "@jupyterlab/notebook";
import { IRenderMimeRegistry } from "@jupyterlab/rendermime";
import { ISettingRegistry } from "@jupyterlab/settingregistry";
import {
  IChatCommandRegistry,
  IChatTracker,
  IInputToolbarRegistryFactory,
  MessageFooterRegistry,
  type IChatModel,
  type IChatPanel,
} from "@jupyter/chat";
import {
  IAISettingsModel,
  IProviderRegistry,
  type IProviderConfig,
  type IProviderInfo,
} from "@jupyternaut/agent";
import { IChatModelHandler } from "@jupyterlite/ai";
import { FileDialog } from "@jupyterlab/filebrowser";
import { fileIcon, notebookIcon } from "@jupyterlab/ui-components";
import { Token } from "@lumino/coreutils";
import { Menu, Widget } from "@lumino/widgets";
import { IComponentsRendererFactory } from "jupyter-chat-components";

import {
  CALLBACK_FILE,
  PACKAGE,
  PLUGIN_ID,
  PROVIDER_ID,
  PROVIDER_NAME,
  CHAT_NAME,
  readConfig,
  siteOverrides,
} from "./config.js";
import { ClimateClawCore, IClimateClaw, UnconfiguredAuth } from "./core.js";
import { AI_CHAT_SETTINGS, ChatController, errorText, type AIChat } from "./chats.js";
import { ChatsPanel, PANEL_ID, type MainChat } from "./chat-panel.js";
import { otherPanelRequested, widenLeftAreaWhenReady } from "./layout.js";
import { addComposer, ComposerCommandIds } from "./composer.js";
import { cellsAttachment, ContextFollower, InputRegistry, type CellRef } from "./context.js";
import { CONVERSATIONS_ID, ConversationsPanel } from "./conversations.js";
import { emptyChatFactory } from "./empty-chat.js";
import { ExamplesCommandProvider } from "./examples.js";
import { addSelectModelCommand, isClimateClawChat, ModelChip } from "./header.js";
import { followIcon, historyIcon, logoIcon, promptsIcon } from "./icons.js";
import { avatarText, hostLabel } from "./identity.js";
import {
  AI_MOVE_CHAT,
  AI_OPEN_CHAT,
  AI_OPEN_OR_REVEAL_CHAT,
  AI_CHAT_PANEL_ID,
  AI_SAVE_CHAT,
  LabPresenter,
  type LoadedModels,
} from "./lab-presenter.js";
import { DKRZ_RUNNING_FILE, setDkrzRunningUrl } from "./dkrz-logo.js";
import { ClimateClawModel } from "./model.js";
import { startModelSync, type ProviderEntry } from "./models.js";
import { createNotebookSink } from "./notebook-sink.js";
import { doingText, presentAsClimateClaw } from "./persona.js";
import { branchFooter, chatThread, feedbackFooter } from "./reply-actions.js";
import { registerRunAndFix } from "./runfix-plugin.js";
import { ThreadNotebooks } from "./thread-notebooks.js";
import { IFrevaAuth } from "./token.js";
import { menuFor, openMenuAtActiveElement, showPopupBlocked } from "./ui.js";

export { IFrevaAuth } from "./token.js";
export { IClimateClaw } from "./core.js";

/** The chat inputs the composer's controls were drawn in, for the commands they run. */
const composerInputs = new InputRegistry<object>();

export const CommandIds = {
  ask: "climateclaw:ask",
  account: "climateclaw:account",
  signIn: "climateclaw:sign-in",
  signOut: "climateclaw:sign-out",
  signedInAs: "climateclaw:signed-in-as",
  examples: "climateclaw:examples",
  example: "climateclaw:example",
  toggleHideCode: "climateclaw:toggle-hide-code",
  history: "climateclaw:history",
  openThread: "climateclaw:open-thread",
  renameThread: "climateclaw:rename-thread",
  deleteThread: "climateclaw:delete-thread",
  newChat: "climateclaw:new-chat",
} as const;

/** The portal's notebook: jupyterlite-ai's chat panel plugin is disabled, ClimateClaw's shows. */
export function ownsChatPanel(): boolean {
  return PageConfig.Extension.isDisabled(AI_CHAT_SETTINGS);
}

function staticUrl(file: string): string {
  return URLExt.join(PageConfig.getOption("fullLabextensionsUrl"), PACKAGE, "static", file);
}

const CLOSE_HISTORY = "climateclaw:close-history";

const IChatController = new Token<ChatController>(
  `${PACKAGE}:IChatController`,
  "ClimateClaw's chats (private to this extension).",
);

/** One per application: the notebooks of the threads. */
const threadNotebooks = new WeakMap<JupyterFrontEnd, ThreadNotebooks>();
function notebooksFor(app: JupyterFrontEnd, tracker: INotebookTracker | null) {
  if (!tracker) return null;
  let notebooks = threadNotebooks.get(app);
  if (!notebooks) {
    notebooks = new ThreadNotebooks(app, tracker);
    threadNotebooks.set(app, notebooks);
  }
  return notebooks;
}

/** A saved `codeDisplay` (notebook / chat / hidden) becomes `hideCode`, then is removed. */
async function migrateSettings(settings: ISettingRegistry.ISettings): Promise<void> {
  const old = settings.user.codeDisplay;
  if (old === undefined) return;
  if (typeof old === "string" && settings.user.hideCode === undefined) {
    await settings.set("hideCode", old !== "chat");
  }
  await settings.remove("codeDisplay");
}

const corePlugin: JupyterFrontEndPlugin<IClimateClaw> = {
  id: PLUGIN_ID,
  description: "ClimateClaw configuration, Freva sign-in and API.",
  autoStart: true,
  provides: IClimateClaw,
  requires: [ISettingRegistry],
  activate: async (_app: JupyterFrontEnd, registry: ISettingRegistry): Promise<IClimateClaw> => {
    let settings: ISettingRegistry.ISettings | null = null;
    try {
      settings = await registry.load(PLUGIN_ID);
      await migrateSettings(settings);
    } catch (error) {
      console.warn("ClimateClaw: settings could not be loaded", error);
    }
    // Settings this browser saved that fail validation: the site's own still configure it.
    const raw = (settings?.composite ?? siteOverrides(PLUGIN_ID)) as Record<string, unknown>;
    const config = readConfig(raw, window.location.href, staticUrl(CALLBACK_FILE));
    if (!config.host)
      console.warn("ClimateClaw: no Freva host is configured; the provider is inert.");
    return new ClimateClawCore(config, settings, {
      onBlocked: (retry) => showPopupBlocked(retry),
      onError: (message) => Notification.error(message, { autoClose: 8000 }),
    });
  },
};

const authPlugin: JupyterFrontEndPlugin<IFrevaAuth> = {
  id: `${PACKAGE}:auth`,
  description: "Provides the Freva sign-in to other extensions.",
  autoStart: true,
  provides: IFrevaAuth,
  requires: [IClimateClaw],
  activate: (_app, core: IClimateClaw) => core.auth ?? new UnconfiguredAuth(),
};

const providerPlugin: JupyterFrontEndPlugin<void> = {
  id: `${PACKAGE}:provider`,
  description: 'Registers the "ClimateClaw (Freva)" provider with jupyterlite-ai.',
  autoStart: true,
  requires: [IClimateClaw, IProviderRegistry],
  optional: [IAISettingsModel, INotebookTracker],
  activate: (
    app,
    core: IClimateClaw,
    providers: IProviderRegistry,
    settingsModel: IAISettingsModel | null,
    notebookTracker: INotebookTracker | null,
  ) => {
    const { config } = core;
    const notebooks = notebooksFor(app, notebookTracker);
    const fetchModels = async (): Promise<string[]> => {
      if (!core.api || !core.auth?.signedIn)
        return config.defaultModel ? [config.defaultModel] : [];
      try {
        const models = await core.api.availableChatbots();
        return models.length ? models : config.defaultModel ? [config.defaultModel] : [];
      } catch {
        return config.defaultModel ? [config.defaultModel] : [];
      }
    };
    // jupyterlite-ai reads `fetchModels` and `connectAccount` after 0.20.1; 0.20.1 ignores them.
    const info: IProviderInfo & {
      fetchModels: () => Promise<string[]>;
      connectAccount: () => Promise<boolean>;
    } = {
      id: PROVIDER_ID,
      name: PROVIDER_NAME,
      apiKeyRequirement: "none",
      defaultModels: config.defaultModel ? [config.defaultModel] : [],
      supportsBaseURL: false,
      supportsHeaders: false,
      supportsToolCalling: false,
      description: config.host
        ? `ClimateClaw at ${config.host}. Sign in with Freva from the chat toolbar.`
        : "ClimateClaw (not configured for this site).",
      factory: (options) => {
        const model = options.model || config.defaultModel;
        return new ClimateClawModel(model, {
          api: () => core.api,
          signInProblem: () => core.signInProblem(),
          hideCode: () => core.hideCode,
          scopeNote: () => config.scopeNote,
          codeSink: (thread, title) =>
            config.codeToNotebook && notebooks
              ? createNotebookSink(
                  app,
                  { notebooks, thread, title: core.chatTitleOf(thread) ?? title },
                  model,
                  (owner, cell) => core.activity.addCell(owner, cell),
                  config.previewOrigin,
                )
              : null,
          imageOrigin: config.previewOrigin,
          // ClimateClaw's own panel turns a sign-in link in a reply into the sign-in.
          signedOut: () => ownsChatPanel() && !!core.auth && !core.auth.signedIn,
          activity: core.activity,
          gate: core.gate,
        });
      },
      fetchModels,
      connectAccount: () =>
        new Promise<boolean>((resolve) => {
          const auth = core.auth;
          if (!auth) return resolve(false);
          if (auth.signedIn) return resolve(true);
          const done = () => {
            auth.changed.disconnect(done);
            resolve(auth.signedIn);
          };
          auth.changed.connect(done);
          auth.login();
        }),
    };
    if (providers.getProviderInfo(PROVIDER_ID)) {
      console.warn(`ClimateClaw: a provider "${PROVIDER_ID}" is already registered.`);
      return;
    }
    providers.registerProvider(info);

    if (!settingsModel || !core.auth) return;
    // Now (a sign-in restored before this plugin activated) and on every sign-in change.
    startModelSync({
      auth: core.auth,
      fetchModels,
      defaultModel: config.defaultModel,
      name: CHAT_NAME,
      // Published by the sync, so an overtaken request never replaces a newer list.
      publish: (models) => {
        core.servedModels = models;
        core.changed.emit();
      },
      settings: {
        providers: () => settingsModel.providers as ProviderEntry[],
        hasDefaultProvider: () => Boolean(settingsModel.config.defaultProvider),
        update: (providers) =>
          settingsModel.updateConfig({ providers: providers as IProviderConfig[] }),
        activate: (id) => settingsModel.setActiveProvider(id),
      },
    });
  },
};

/** The chat tracker, where ClimateClaw shows chats itself (jupyterlite-ai's is disabled there). */
const trackerPlugin: JupyterFrontEndPlugin<IChatTracker> = {
  id: `${PACKAGE}:chat-tracker`,
  description: "The chat tracker of ClimateClaw's own chat panel.",
  autoStart: true,
  provides: IChatTracker,
  activate: () => new WidgetTracker<IChatPanel>({ namespace: "climateclaw-chat" }),
};

/** A toolbar button's chat: the one containing the focused element, else the current one. */
function chatForToolbar(tracker: IChatTracker): IChatPanel | null {
  const active = document.activeElement;
  return tracker.find((panel) => !!active && panel.node.contains(active)) ?? tracker.currentWidget;
}

const chatPlugin: JupyterFrontEndPlugin<ChatController> = {
  id: `${PACKAGE}:chat`,
  description: "ClimateClaw's chats: commands, history, composer and the chat controller.",
  autoStart: true,
  provides: IChatController,
  requires: [IClimateClaw, IChatTracker, ISettingRegistry],
  optional: [
    IChatCommandRegistry,
    ICommandPalette,
    IToolbarWidgetRegistry,
    IAISettingsModel,
    INotebookTracker,
    ILabShell,
  ],
  activate: (
    app: JupyterFrontEnd,
    core: IClimateClaw,
    tracker: IChatTracker,
    registry: ISettingRegistry,
    chatCommands: IChatCommandRegistry | null,
    palette: ICommandPalette | null,
    toolbars: IToolbarWidgetRegistry | null,
    settingsModel: IAISettingsModel | null,
    notebooks: INotebookTracker | null,
    labShell: ILabShell | null,
  ): ChatController => {
    const { commands } = app;
    const { config } = core;
    const own = ownsChatPanel();
    const controller = new ChatController(
      app,
      core,
      tracker,
      registry,
      settingsModel,
      notebooksFor(app, notebooks),
    );
    if (!own) {
      const sidePanel = () => {
        for (const widget of app.shell.widgets("left")) {
          if (widget.id === AI_CHAT_PANEL_ID) return widget as unknown as LoadedModels;
        }
        return null;
      };
      controller.presenter = new LabPresenter(
        commands,
        tracker,
        () => controller.providerId(),
        sidePanel,
      );
    }
    const findChat = (id: string) => tracker.find((panel) => panel.id === id);
    let conversations: ConversationsPanel | null = null;
    const refresh = () => {
      for (const id of [CommandIds.account, CommandIds.toggleHideCode, CommandIds.history]) {
        commands.notifyCommandChanged(id);
      }
    };
    core.changed.connect(refresh);
    // Another account: a new list, and a load still in flight for the previous one is dropped.
    core.auth?.changed.connect(() => conversations?.accountChanged());

    // header (jupyterlite-ai's panel)

    const host = hostLabel(config.host, config.hostLabel);
    if (settingsModel) addSelectModelCommand(commands, settingsModel, findChat);
    if (toolbars && settingsModel) {
      toolbars.addFactory<IChatPanel>(
        "Chat",
        "climateclawModel",
        (panel) => new ModelChip(panel, settingsModel, commands, host),
      );
    } else {
      toolbars?.addFactory<IChatPanel>("Chat", "climateclawModel", () => new Widget());
    }

    commands.addCommand(CommandIds.signIn, {
      label: "Sign in with Freva",
      isEnabled: () => !!core.auth && !core.auth.signedIn,
      execute: () => core.auth?.login(),
    });
    commands.addCommand(CommandIds.signOut, {
      label: "Sign out",
      caption: "Sign out of Freva here and at the identity provider",
      isEnabled: () => !!core.auth?.signedIn,
      execute: () => {
        // Nothing keeps running on the account that is signing out.
        tracker.forEach((panel) => (panel.model as AIChat).stopStreaming?.());
        if (commands.hasCommand("climateclaw:stop-run-and-fix")) {
          void commands.execute("climateclaw:stop-run-and-fix", { all: true });
        }
        // Synchronous up to the popup: the end-session window opens inside the click.
        return core.auth?.signOut();
      },
    });
    commands.addCommand(CommandIds.signedInAs, {
      label: () => {
        const profile = core.auth?.profile;
        return `Signed in as ${profile?.fullName || profile?.username || "a Freva user"}`;
      },
      isEnabled: () => false,
      execute: () => undefined,
    });
    commands.addCommand(CommandIds.account, {
      // Signed in: the user's initials, shown as an avatar; the name is in the tooltip and menu.
      label: () =>
        !core.auth
          ? "Freva sign-in unavailable"
          : core.auth.signedIn
            ? (avatarText(
                core.auth.profile?.fullName,
                core.auth.profile?.username ?? core.auth.username,
              ) ?? "✓")
            : "Sign in",
      caption: () =>
        core.auth?.signedIn
          ? `Signed in as ${core.auth.profile?.fullName || core.auth.username || "a Freva user"}: your Freva account`
          : "Sign in with Freva in a popup window",
      className: () =>
        core.auth?.signedIn ? "jp-ClimateClaw-account jp-mod-signedIn" : "jp-ClimateClaw-account",
      isEnabled: () => !!core.auth,
      execute: () => {
        const auth = core.auth;
        if (!auth) return;
        // Synchronous: the popup must open inside the click.
        if (!auth.signedIn) return auth.login();
        const menu = menuFor(commands, "jp-ClimateClaw-accountMenu");
        menu.addItem({ command: CommandIds.signedInAs });
        menu.addItem({ type: "separator" });
        menu.addItem({ command: CommandIds.signOut });
        openMenuAtActiveElement(menu);
      },
    });

    commands.addCommand(CommandIds.example, {
      label: (args) => String(args.title ?? "Example"),
      icon: (args) => (args.chatId ? promptsIcon : undefined),
      execute: (args) => {
        const example = config.examples[Number(args.index)];
        const panel =
          (typeof args.chatId === "string"
            ? tracker.find((w) => w.id === args.chatId)
            : undefined) ?? chatForToolbar(tracker);
        if (!example) return;
        if (!panel) {
          return controller.newChat({
            area: "sidebar",
            input: example.prompt,
            send: args.send === true,
            focus: true,
          });
        }
        const input =
          (composerInputs.get(args.inputId) as IChatModel["input"] | null) ?? panel.model.input;
        if (args.send === true) input.send(example.prompt);
        else {
          input.value = example.prompt;
          input.focus();
        }
      },
    });
    commands.addCommand(CommandIds.examples, {
      label: "Examples ▾",
      caption: "Example questions: fill the input, or send one",
      className: "jp-ClimateClaw-examples",
      isEnabled: () => config.examples.length > 0,
      isVisible: () => config.examples.length > 0,
      execute: () => {
        const panel = chatForToolbar(tracker);
        const menu = menuFor(commands, "jp-ClimateClaw-examplesMenu");
        const send = new Menu({ commands });
        send.title.label = "Send now";
        config.examples.forEach((example, index) => {
          menu.addItem({
            command: CommandIds.example,
            args: { index, title: example.title, ...(panel ? { chatId: panel.id } : {}) },
          });
          send.addItem({
            command: CommandIds.example,
            args: {
              index,
              title: example.title,
              send: true,
              ...(panel ? { chatId: panel.id } : {}),
            },
          });
        });
        menu.addItem({ type: "separator" });
        menu.addItem({ type: "submenu", submenu: send });
        openMenuAtActiveElement(menu);
      },
    });

    commands.addCommand(CommandIds.toggleHideCode, {
      label: "Hide code",
      caption:
        "Fold each run's code in the chat; click a run's line to see it. Outputs, errors and " +
        "figures always show (all are in the notebook cell too)",
      className: "jp-ClimateClaw-hideCode",
      isToggled: () => core.hideCode,
      execute: () => core.setHideCode(!core.hideCode),
    });

    const reportError = (error: unknown) =>
      Notification.error(errorText(error), { autoClose: 8000 });

    commands.addCommand(CommandIds.openThread, {
      label: (args) =>
        args.area === "main"
          ? "Open in a tab"
          : args.area === "sidebar"
            ? "Open in the chat panel"
            : "Open ClimateClaw thread",
      isEnabled: () => !!core.auth?.signedIn,
      execute: (args) =>
        controller
          .openThread(
            String(args.threadId ?? ""),
            String(args.topic ?? "ClimateClaw thread"),
            args.area === "main" ? "main" : "sidebar",
          )
          .catch(reportError),
    });
    commands.addCommand(CommandIds.renameThread, {
      label: "Rename…",
      isEnabled: () => !!core.auth?.signedIn,
      execute: (args) =>
        controller
          .renameThread(String(args.threadId ?? ""), String(args.topic ?? ""))
          .catch(reportError),
    });
    commands.addCommand(CommandIds.deleteThread, {
      label: "Delete…",
      isEnabled: () => !!core.auth?.signedIn,
      execute: (args) =>
        controller
          .deleteThread(String(args.threadId ?? ""), String(args.topic ?? ""))
          .catch(reportError),
    });

    // conversations

    commands.addCommand(CommandIds.newChat, {
      label: "New chat",
      caption: "Start a new ClimateClaw conversation",
      execute: () => controller.newChat({ area: "sidebar", focus: true }).catch(reportError),
    });

    const currentThread = (): string | null => {
      const panel = controller.presenter?.current() ?? tracker.currentWidget;
      return panel ? chatThread(panel.model) : null;
    };
    if (core.api && core.auth) {
      const api = core.api;
      const auth = core.auth;
      conversations = new ConversationsPanel({
        commands,
        openCommand: CommandIds.openThread,
        newChatCommand: CommandIds.newChat,
        renameCommand: CommandIds.renameThread,
        deleteCommand: CommandIds.deleteThread,
        signedIn: () => auth.signedIn,
        signIn: () => auth.login(),
        load: (page, size) => api.userThreads(page, size),
        currentThread,
        close: () => (own ? controller.showHistory?.(false) : labShell?.collapseRight()),
      });
      controller.history = conversations;
      controller.conversations = conversations;
      if (!own) app.shell.add(conversations, "right", { rank: 200 });
      tracker.currentChanged.connect(() => conversations?.invalidate());
    }

    commands.addCommand(CommandIds.history, {
      // Icon only in a chat header (jupyterlite-ai's toolbar passes the chat's `area`).
      label: (args) => (args.toolbar || args.area ? "" : "ClimateClaw conversations"),
      icon: historyIcon,
      caption: () =>
        core.auth?.signedIn
          ? "Your ClimateClaw conversations: search, open, continue"
          : "Your ClimateClaw conversations (sign in with Freva to see them)",
      className: "jp-ClimateClaw-history-button",
      isEnabled: () => !!conversations,
      isToggled: () => (own ? !!controller.historyShown?.() : !!conversations?.isVisible),
      execute: () => {
        const panel = conversations;
        if (!panel) return;
        if (own) controller.showHistory?.(!controller.historyShown?.());
        else if (panel.isVisible && labShell) labShell.collapseRight();
        else {
          panel.invalidate();
          app.shell.activateById(CONVERSATIONS_ID);
        }
        commands.notifyCommandChanged(CommandIds.history);
      },
    });

    commands.addCommand(CommandIds.ask, {
      label: "Ask ClimateClaw",
      caption: "Open a ClimateClaw chat with a question (and optional context) in its input",
      // Its logo, for the data panel's Ask button and launcher card.
      icon: logoIcon,
      execute: (args) => {
        const prompt = typeof args.prompt === "string" ? args.prompt : "";
        const context = typeof args.context === "string" ? args.context : "";
        const input = [prompt, context].filter(Boolean).join("\n\n");
        return controller
          .ask(
            input,
            args.send === true && input.length > 0,
            args.area === "main" ? "main" : "sidebar",
          )
          .catch(reportError);
      },
      describedBy: {
        args: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "The question" },
            context: { type: "string", description: "Context appended below the question" },
            send: { type: "boolean", description: "Send at once instead of pre-filling" },
            area: { type: "string", enum: ["main", "sidebar"] },
          },
        },
      },
    });

    // composer

    const notebookPath = () => notebooks?.currentWidget?.context.path ?? null;
    const cellRef = (cell: { model: { id: string; type: string } }): CellRef => ({
      id: cell.model.id,
      type: cell.model.type === "markdown" || cell.model.type === "raw" ? cell.model.type : "code",
    });
    const activeCellAttachment = () => {
      const path = notebookPath();
      const cell = notebooks?.activeCell;
      return path && cell ? cellsAttachment(path, [cellRef(cell)]) : null;
    };
    const followers = new WeakMap<IChatPanel, ContextFollower>();
    const followerFor = (panel: IChatPanel): ContextFollower => {
      let follower = followers.get(panel);
      if (!follower) {
        follower = new ContextFollower(panel.model.input, activeCellAttachment, () =>
          commands.notifyCommandChanged(ComposerCommandIds.followActiveCell),
        );
        followers.set(panel, follower);
        panel.disposed.connect(() => follower?.dispose());
      }
      return follower;
    };
    const moveFollowers = () => tracker.forEach((panel) => followers.get(panel)?.refresh());
    notebooks?.activeCellChanged.connect(moveFollowers);
    notebooks?.currentChanged.connect(moveFollowers);

    const chatFor = (args: { chatId?: unknown }) =>
      (typeof args.chatId === "string" ? findChat(args.chatId) : undefined) ??
      chatForToolbar(tracker);
    /** The input a control was drawn in, else the chat's own. */
    const inputFor = (args: { chatId?: unknown; inputId?: unknown }) =>
      (composerInputs.get(args.inputId) as IChatModel["input"] | null) ??
      chatFor(args)?.model.input;
    const attach = (args: { chatId?: unknown; inputId?: unknown }, cells: CellRef[]) => {
      const input = inputFor(args);
      const path = notebookPath();
      if (!input || !path || cells.length === 0) return;
      input.addAttachment?.(cellsAttachment(path, cells));
      input.focus();
    };
    const notebookName = () => PathExt.basename(notebookPath() ?? "") || "the notebook";

    commands.addCommand(ComposerCommandIds.attachActiveCell, {
      label: () => `Active cell of ${notebookName()}`,
      icon: followIcon,
      caption: "Its source and outputs go with the next message",
      isEnabled: () => !!notebooks?.activeCell,
      execute: (args) => {
        const cell = notebooks?.activeCell;
        if (cell) attach(args, [cellRef(cell)]);
      },
    });
    commands.addCommand(ComposerCommandIds.attachSelectedCells, {
      label: "Selected cells",
      isEnabled: () => !!notebooks?.currentWidget,
      execute: (args) => {
        const nb = notebooks?.currentWidget?.content;
        if (!nb) return;
        attach(args, nb.widgets.filter((c) => nb.isSelectedOrActive(c)).map(cellRef));
      },
    });
    commands.addCommand(ComposerCommandIds.attachNotebook, {
      label: () => `All cells of ${notebookName()}`,
      icon: notebookIcon,
      isEnabled: () => !!notebooks?.currentWidget,
      execute: (args) => {
        const nb = notebooks?.currentWidget?.content;
        if (nb) attach(args, nb.widgets.map(cellRef));
      },
    });
    commands.addCommand(ComposerCommandIds.attachFile, {
      label: "A file…",
      icon: fileIcon,
      execute: async (args) => {
        const input = inputFor(args);
        if (!input?.documentManager || !input.addAttachment) return;
        const files = await FileDialog.getOpenFiles({
          title: "Add files as context",
          manager: input.documentManager,
        });
        for (const file of files.value ?? []) {
          if (file.type !== "directory") input.addAttachment({ type: "file", value: file.path });
        }
        input.focus();
      },
    });
    commands.addCommand(ComposerCommandIds.followActiveCell, {
      label: "Follow the active cell",
      caption: "Keep the notebook's active cell attached to every message until you remove it",
      isToggled: (args) => {
        const panel = chatFor(args);
        return !!panel && !!followers.get(panel)?.following;
      },
      isEnabled: () => !!notebooks,
      execute: (args) => {
        const panel = chatFor(args);
        if (!panel) return;
        const follower = followerFor(panel);
        if (follower.following) follower.stop();
        else follower.start();
      },
    });

    if (settingsModel) {
      const composer = (panel: IChatPanel) => {
        // Its replies under ClimateClaw's name and logo, not the default persona's.
        const stop = presentAsClimateClaw(
          panel.model,
          () => isClimateClawChat(panel, settingsModel),
          {
            text: () => {
              const thread = chatThread(panel.model);
              const now = thread ? core.activity.activity(thread) : null;
              return doingText(now?.phase ?? "thinking", now?.label);
            },
            changed: core.activity.changed,
          },
        );
        panel.disposed.connect(stop);
        panel.disposed.connect(() => composerInputs.forget(panel.model.input));
        addComposer(panel, {
          commands,
          inputs: composerInputs,
          settings: settingsModel,
          hideCode: () => core.hideCode,
          setHideCode: (hidden) => void core.setHideCode(hidden),
          changed: core.changed,
          ownPanel: own,
          askVoiceConsent: async () =>
            (
              await showDialog({
                title: "Speak your message",
                body: "Your browser turns speech into text. This browser does it with its maker's online speech service (in Chrome and Edge, Google's or Microsoft's): what you say is sent there, not to Freva or ClimateClaw. You can edit the text before sending it.",
                buttons: [Dialog.cancelButton(), Dialog.okButton({ label: "Use the microphone" })],
              })
            ).button.accept,
          onVoiceError: (error) =>
            Notification.warning(
              error === "not-allowed" || error === "service-not-allowed"
                ? "The microphone is not allowed here: allow it for this site in the browser."
                : `Speech recognition stopped: ${error}`,
              { autoClose: 6000 },
            ),
          examples: config.examples,
          exampleCommand: CommandIds.example,
          activity: core.activity,
          follower: followerFor,
          activeCellNumber: () => (notebooks?.currentWidget?.content.activeCellIndex ?? -1) + 1,
        });
      };
      tracker.forEach(composer);
      tracker.widgetAdded.connect((_, panel) => composer(panel));
    }

    if (chatCommands && config.examples.length) {
      chatCommands.addProvider(new ExamplesCommandProvider(config.examples));
    }
    if (palette) {
      for (const command of [
        CommandIds.ask,
        CommandIds.newChat,
        CommandIds.signIn,
        CommandIds.signOut,
        CommandIds.history,
      ]) {
        palette.addItem({ command, category: "ClimateClaw" });
      }
    }
    return controller;
  },
};

const panelPlugin: JupyterFrontEndPlugin<void> = {
  id: `${PACKAGE}:chat-panel`,
  description: "ClimateClaw's own chat panel, where jupyterlite-ai's panel plugin is disabled.",
  autoStart: true,
  requires: [
    IClimateClaw,
    IChatController,
    IChatTracker,
    IChatModelHandler,
    IRenderMimeRegistry,
    IInputToolbarRegistryFactory,
  ],
  optional: [
    IChatCommandRegistry,
    IThemeManager,
    ILayoutRestorer,
    ILabShell,
    IComponentsRendererFactory,
  ],
  activate: (
    app: JupyterFrontEnd,
    core: IClimateClaw,
    controller: ChatController,
    tracker: IChatTracker,
    handler: IChatModelHandler,
    rmRegistry: IRenderMimeRegistry,
    inputToolbarFactory: IInputToolbarRegistryFactory,
    chatCommands: IChatCommandRegistry | null,
    themeManager: IThemeManager | null,
    restorer: ILayoutRestorer | null,
    labShell: ILabShell | null,
    components: IComponentsRendererFactory | null,
  ) => {
    const { commands } = app;
    const mainTracker = new WidgetTracker<MainChat>({ namespace: "climateclaw-main-chat" });
    const footers = new MessageFooterRegistry();
    footers.addSection({
      position: "left",
      component: branchFooter(
        controller.branches,
        (model, thread) => void controller.switchTo(model as AIChat, thread),
      ),
    });
    footers.addSection({
      position: "right",
      component: feedbackFooter(
        controller.feedback,
        (message) => Notification.error(`Feedback not saved: ${message}`, { autoClose: 6000 }),
        core.activity,
      ),
    });
    const panel = new ChatsPanel({
      app,
      core,
      controller,
      tracker: tracker as WidgetTracker<IChatPanel>,
      mainTracker,
      handler,
      rmRegistry,
      inputToolbarFactory,
      chatCommands,
      themeManager,
      footers,
      placeholder: emptyChatFactory({
        examples: core.config.examples,
        name: () => {
          const profile = core.auth?.signedIn ? core.auth.profile : null;
          // A real name only: an account id (k202187) is no way to greet anyone.
          return profile?.fullName || null;
        },
        recent: async () =>
          core.api && core.auth?.signedIn ? (await core.api.userThreads(0, 2)).threads : [],
        openThread: (thread) =>
          void commands.execute(CommandIds.openThread, {
            threadId: thread.threadId,
            topic: thread.topic,
            area: "sidebar",
          }),
        showHistory: () => controller.showHistory?.(true),
      }),
      history: controller.conversations,
      commands: { signIn: CommandIds.signIn, signOut: CommandIds.signOut },
      logoUrl: staticUrl("climateclaw-animated.gif"),
      close: () => labShell?.collapseLeft(),
    });
    panel.title.icon = logoIcon;
    panel.title.caption = "ClimateClaw";
    // First in the left side bar, then the data panel, then the files (rank 100).
    app.shell.add(panel, "left", { rank: 10 });
    controller.showHistory = (on) => {
      if (on) app.shell.activateById(PANEL_ID);
      panel.showHistory(on);
      commands.notifyCommandChanged(CommandIds.history);
    };
    controller.historyShown = () => panel.historyShown;
    // Escape leaves History, as it closes any overlay (a key binding: JupyterLab owns the keys).
    commands.addCommand(CLOSE_HISTORY, {
      label: "Close History",
      execute: () => controller.showHistory?.(false),
    });
    commands.addKeyBinding({
      command: CLOSE_HISTORY,
      keys: ["Escape"],
      selector: `#${PANEL_ID}[data-view="history"]`,
    });

    // jupyterlite-ai's queued messages (the composer queues while a reply runs): its callbacks,
    // as its own panel plugin sets them.
    if (components) {
      const findModel = (name: string) =>
        tracker.find((chat) => chat.model.name === name)?.model as
          | (AIChat & {
              removeQueuedMessage(id: string): void;
              reorderQueuedMessages(ids: string[]): void;
              editQueuedMessage(id: string, body: string): void;
            })
          | undefined;
      components.queueMessageCallbacks = {
        ...components.queueMessageCallbacks,
        removeQueuedMessage: (target: string, id: string) =>
          findModel(target)?.removeQueuedMessage(id),
        reorderQueuedMessages: (target: string, ids: string[]) =>
          findModel(target)?.reorderQueuedMessages(ids),
        editQueuedMessage: (target: string, id: string, body: string) =>
          findModel(target)?.editQueuedMessage(id, body),
      };
    }

    // jupyterlite-ai's chat commands, kept for whatever calls them (other extensions, users).
    const nameOf = async (args: Record<string, unknown>) =>
      typeof args.name === "string" && args.name ? args.name : controller.newName();
    const areaOf = (args: Record<string, unknown>) => (args.area === "main" ? "main" : "sidebar");
    const inputArgs = (args: Record<string, unknown>) => ({
      ...(typeof args.input === "string" ? { input: args.input } : {}),
      send: args.autoSend === true,
      focus: args.focus === true,
    });
    commands.addCommand(AI_OPEN_CHAT, {
      label: "Open a chat",
      execute: async (args) => {
        await controller.open({ name: await nameOf(args), area: areaOf(args), ...inputArgs(args) });
        return true;
      },
    });
    commands.addCommand(AI_OPEN_OR_REVEAL_CHAT, {
      label: "Open or reveal the chat panel",
      execute: async (args) => {
        const area = areaOf(args);
        const name =
          typeof args.name === "string" && args.name
            ? args.name
            : (tracker.find((chat) => chat.area === area)?.model.name ??
              (await controller.newName()));
        await controller.open({ name, area, ...inputArgs(args) });
        return true;
      },
    });
    commands.addCommand(AI_MOVE_CHAT, {
      label: "Move the chat",
      execute: async (args) => {
        const from = areaOf(args);
        const chat =
          typeof args.name === "string"
            ? tracker.find((c) => c.model.name === args.name)
            : (panel.current() ?? undefined);
        if (!chat || chat.area !== from) return false;
        await controller.open({
          name: chat.model.name,
          area: from === "main" ? "sidebar" : "main",
        });
        return true;
      },
    });
    commands.addCommand(AI_SAVE_CHAT, {
      label: "Save chat",
      execute: async (args) => {
        const chat =
          typeof args.name === "string"
            ? tracker.find((c) => c.model.name === args.name)
            : panel.current();
        const model = chat?.model as AIChat | undefined;
        if (model) await controller.saveNow(model);
      },
    });

    if (restorer) {
      restorer.add(panel, PANEL_ID);
      void restorer.restore(mainTracker, {
        command: AI_OPEN_CHAT,
        args: (chat) => ({ name: chat.model.name, area: "main" }),
        name: (chat) => chat.model.name,
      });
    }
    const ownSideBar = !otherPanelRequested(window.location.href);
    void app.restored.then(async () => {
      // ClimateClaw's tab first, whichever side-bar tab the last session ended on, and wide
      // enough for a conversation.
      if (ownSideBar) {
        app.shell.activateById(PANEL_ID);
        requestAnimationFrame(() => widenLeftAreaWhenReady(labShell));
      }
      await panel
        .restoreLast()
        .catch((error: unknown) =>
          console.warn("ClimateClaw: the last chat was not restored", errorText(error)),
        );
      if (ownSideBar) app.shell.activateById(PANEL_ID);
    });
  },
};

const runAndFixPlugin: JupyterFrontEndPlugin<void> = {
  id: `${PACKAGE}:run-and-fix`,
  description: '"Run at DKRZ" for notebook cells.',
  autoStart: true,
  requires: [IClimateClaw, INotebookTracker],
  optional: [ICommandPalette, IToolbarWidgetRegistry],
  activate: (
    app,
    core: IClimateClaw,
    tracker: INotebookTracker,
    palette: ICommandPalette | null,
    toolbars: IToolbarWidgetRegistry | null,
  ) => {
    setDkrzRunningUrl(staticUrl(DKRZ_RUNNING_FILE));
    registerRunAndFix(app, core, tracker, toolbars, staticUrl(DKRZ_RUNNING_FILE));
    for (const command of [
      "climateclaw:run-and-fix",
      "climateclaw:run-and-fix-with-note",
      "climateclaw:stop-run-and-fix",
      "climateclaw:apply-fix",
      "climateclaw:new-dkrz-thread",
    ]) {
      palette?.addItem({ command, category: "ClimateClaw" });
    }
  },
};

export { ExamplesCommandProvider } from "./examples.js";

/**
 * Exactly one chat tracker: ClimateClaw's, only where jupyterlite-ai's panel plugin (its
 * provider) is disabled, with the panel that fills it. Decided when the extension loads, from
 * the page's configuration.
 */
const own = ownsChatPanel();
export default [
  corePlugin,
  authPlugin,
  providerPlugin,
  ...(own ? [trackerPlugin] : []),
  chatPlugin,
  ...(own ? [panelPlugin] : []),
  runAndFixPlugin,
] as JupyterFrontEndPlugin<unknown>[];
