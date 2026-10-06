// ClimateClaw's chat controller over the real jupyterlite-ai 0.20.1 chat models and the real
// jupyternaut personas, made by jupyterlite-ai's own ChatModelHandler as the notebook makes them:
// a restore that replays questions, or a save that writes an old snapshot, shows here. Only the
// agent (the language model) and the contents store are stand-ins.
//
// A test file using this mocks "@jupyter/chat" with its chat model alone (the package entry loads
// every widget, which the model does not need) and gives jsdom what those modules read on load.
import { Signal } from "@lumino/signaling";

import { ChatModelHandler } from "@jupyterlite/ai/lib/chat-model-handler.js";
import { PersonaRegistry } from "@jupyternaut/persona/lib/persona-registry.js";

import { ChatController, replaceChat, type AIChat, type ChatPresenter } from "../src/chats.js";
import { HUMAN_USER, PERSONA_USER } from "../src/history.js";
import { threadMarker, turnMarker } from "../src/threads.js";
import { FakeContents } from "./fake-contents.js";

/** The agent behind a persona: what it was asked, and a reply on demand. */
export class FakeAgent {
  activeProvider = "climateclaw";
  readonly activeProviderChanged = new Signal<FakeAgent, string>(this);
  readonly agentEvent = new Signal<FakeAgent, unknown>(this);
  readonly tokenUsageChanged = new Signal<FakeAgent, unknown>(this);
  /** Every question it was asked to answer, in order. */
  readonly prompts: string[] = [];
  history: unknown[] = [];
  stops = 0;
  /** Called for each question (e.g. to add a reply). */
  onPrompt: (content: string) => Promise<void> | void = () => undefined;
  hasValidConfig() {
    return true;
  }
  async generateResponse(content: string) {
    this.prompts.push(content);
    await this.onPrompt(content);
  }
  setHistory(history: unknown[]) {
    this.history = history;
  }
  async clearHistory() {}
  stopStreaming() {
    this.stops += 1;
  }
  async textResponse() {
    return "Automatic title";
  }
}

export const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** A backup as jupyterlite-ai writes it: the question, and a reply on `thread` (if any). */
export function backupOf(thread: string | null, extra: Array<[string, string, boolean]> = []) {
  const rows: Array<[string, string, boolean]> = [
    ["u1", "q", false],
    ["a1", thread ? `${threadMarker(thread)}\nanswer\n${turnMarker(thread, 0)}` : "answer", true],
    ...extra,
  ];
  return JSON.stringify({
    messages: rows.map(([id, body, bot], i) => ({
      id,
      body,
      type: "msg",
      time: 1_000 + i,
      raw_time: false,
      sender: bot ? PERSONA_USER.username : HUMAN_USER.username,
      attachments: [],
    })),
    users: { [PERSONA_USER.username]: PERSONA_USER, [HUMAN_USER.username]: HUMAN_USER },
    attachments: {},
    metadata: { provider: "climateclaw", autosave: true },
  });
}

export function setup(api: Record<string, unknown> = {}, options: { autoTitle?: boolean } = {}) {
  const store = new FakeContents();
  store.dirs.add("chats");
  const settingsModel = {
    stateChanged: new Signal({}),
    getProvider: () => ({ id: "climateclaw", provider: "climateclaw", model: "m" }),
    getDefaultProvider: () => ({ id: "climateclaw", provider: "climateclaw" }),
    providers: [{ id: "climateclaw", provider: "climateclaw" }],
  };
  const agents: FakeAgent[] = [];
  const personas = new PersonaRegistry({
    settingsModel,
    providerRegistry: { getProviderInfo: () => null },
    documentManager: null,
    persona: PERSONA_USER,
  } as never);
  const handler = new ChatModelHandler({
    agentManagerFactory: {
      createAgent: () => {
        const agent = new FakeAgent();
        agents.push(agent);
        return agent;
      },
    },
    settingsModel,
    toolRegistry: {},
    providerRegistry: {},
    rmRegistry: {},
    personaRegistry: personas,
    chatSettings: {
      composite: { chatBackupDirectory: "chats", autoTitle: options.autoTitle === true },
      changed: new Signal({}),
    },
    activeCellManager: null,
    docManager: null,
    contentsManager: store,
  } as never);

  const added = new Signal<object, { model: AIChat; disposed: Signal<object, void> }>({});
  type Panel = { model: AIChat; area: string; disposed: Signal<object, void> };
  const panels: Panel[] = [];
  const tracker = {
    widgetAdded: added,
    currentChanged: new Signal<object, void>({}),
    get currentWidget() {
      return panels[panels.length - 1] ?? null;
    },
    forEach: (fn: (p: Panel) => void) => panels.forEach(fn),
    find: (fn: (p: Panel) => boolean) => panels.find(fn),
  };
  const calls: Array<[string, ...unknown[]]> = [];
  const core = {
    api: {
      setTopic: async (...a: unknown[]) => void calls.push(["setTopic", ...a]),
      deleteThread: async (...a: unknown[]) => void calls.push(["deleteThread", ...a]),
      thread: async () => [
        { variant: "User", content: "q" },
        { variant: "Assistant", content: "server answer" },
      ],
      userThreads: async () => ({ threads: [], total: 0 }),
      editThread: async (...a: unknown[]) => {
        calls.push(["editThread", ...a]);
        return "B1";
      },
      ...api,
    },
    hideCode: false,
    chatTitleOf: () => null,
    config: {},
  };
  const app = { serviceManager: { contents: store } };
  const registry = { load: async () => ({ composite: { chatBackupDirectory: "chats" } }) };
  const controller = new ChatController(
    app as never,
    core as never,
    tracker as never,
    registry as never,
    settingsModel as never,
    null,
  );
  const opened: string[] = [];
  const models: AIChat[] = [];
  /** As ClimateClaw's own panel: the model from the controller (made by jupyterlite-ai), a view. */
  const presenter: ChatPresenter = {
    open: async (request) => {
      opened.push(`${request.area}:${request.name}`);
      let panel = panels.find((p) => p.model.name === request.name);
      const model =
        panel?.model ??
        (await controller.model(request.name, async () => {
          const made = handler.createModel({
            name: request.name,
            activeProvider: "climateclaw",
          }) as unknown as AIChat;
          models.push(made);
          // Restored from its backup before it is ready, and before its persona listens.
          await made.ready;
          return made;
        }));
      panel = panels.find((p) => p.model.name === request.name);
      if (!panel || panel.area !== request.area) {
        if (panel) {
          panels.splice(panels.indexOf(panel), 1);
          panel.disposed.emit();
        }
        panel = { model, area: request.area, disposed: new Signal<object, void>({}) };
        panels.push(panel);
        added.emit(panel);
      }
      if (typeof request.input === "string") model.input.value = request.input;
      return panel as never;
    },
    closeChat: (model) => {
      for (const panel of panels.filter((p) => p.model === (model as unknown))) {
        panels.splice(panels.indexOf(panel), 1);
        panel.disposed.emit();
      }
    },
    remove: (model) => presenter.closeChat(model),
    replace: (old, request) => replaceChat(presenter, old, request),
    current: () => (panels[panels.length - 1] ?? null) as never,
  };
  controller.presenter = presenter;

  /** The agent of a model (its persona's). */
  const agentOf = (model: AIChat) => (model as unknown as { agentManager: FakeAgent }).agentManager;
  /** The model the chat named `name` shows now. */
  const shown = (name: string) => panels.find((p) => p.model.name === name)?.model ?? null;
  /** A chat restored from a backup: a question and a reply on `thread`. */
  const chatWith = async (thread: string | null, extra: Array<[string, string, boolean]> = []) => {
    const name = await controller.newName();
    store.files.set(`chats/${name}.chat`, { type: "file", content: backupOf(thread, extra) });
    await controller.open({ name, area: "sidebar" });
    return shown(name)!;
  };
  /** A reply from the persona: what `agent.onPrompt` can add. */
  const reply = (model: AIChat, body: string) =>
    model.messageAdded({
      id: `r-${Math.random().toString(36).slice(2)}`,
      body,
      sender: PERSONA_USER,
      time: Date.now() / 1000,
      type: "msg",
      raw_time: false,
    } as never);
  const backup = (name: string) => store.files.get(`chats/${name}.chat`)?.content as string;
  return {
    store,
    controller,
    calls,
    panels,
    opened,
    models,
    agents,
    agentOf,
    shown,
    chatWith,
    reply,
    backup,
    core,
    personas,
  };
}
