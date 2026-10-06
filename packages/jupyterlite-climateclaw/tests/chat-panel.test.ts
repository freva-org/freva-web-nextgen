// @vitest-environment jsdom
// ClimateClaw's own panel: replacing a chat's model is one presentation step, and an empty view
// on its way makes no chat. Only the user's own steps (a sign-in, the last chat deleted, a first
// visit) lead to a new chat. The chat widget is a stand-in: what is tested is the panel's part.
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  const g = globalThis as { DragEvent?: unknown; MouseEvent: typeof MouseEvent };
  g.DragEvent ??= class extends g.MouseEvent {};
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as never;
});

vi.mock("@jupyter/chat", async () => {
  const lumino = await import("@lumino/widgets");
  class ChatWidget extends lumino.Widget {
    readonly model: unknown;
    constructor(options: { model: unknown }) {
      super();
      this.model = options.model;
    }
  }
  class AttachmentOpenerRegistry extends Map {}
  return {
    AbstractChatModel: (await import("@jupyter/chat/lib/model.js")).AbstractChatModel,
    AttachmentOpenerRegistry,
    ChatWidget,
  };
});

const { Signal } = await import("@lumino/signaling");
const { CommandRegistry } = await import("@lumino/commands");
const { Widget } = await import("@lumino/widgets");
const { WidgetTracker } = await import("@jupyterlab/apputils");
const { ChatsPanel, LAST_CHAT_KEY } = await import("../src/chat-panel.js");

class Model {
  isDisposed = false;
  messages: unknown[] = [];
  input = {
    value: "",
    attachments: [],
    focus: () => undefined,
    send: () => undefined,
  };
  readonly ready = Promise.resolve();
  readonly messagesUpdated = new Signal<object, void>(this);
  readonly writersChanged = new Signal<object, void>(this);
  constructor(readonly name: string) {}
  dispose() {
    this.isDisposed = true;
  }
}

function setup() {
  const models = new Map<string, Model>();
  let made = 0;
  const newChats: string[] = [];
  const tracker = new WidgetTracker<never>({ namespace: `t${Math.random()}` });
  const mainTracker = new WidgetTracker<never>({ namespace: `m${Math.random()}` });
  const auth = {
    signedIn: true,
    profile: { fullName: "Jane Doe", username: "jdoe" },
    username: "jdoe",
    changed: new Signal<object, void>({}),
  };
  const controller = {
    presenter: null as unknown,
    providerId: () => "climateclaw",
    model: async (name: string, make: () => Promise<Model>) => {
      const kept = models.get(name);
      if (kept && !kept.isDisposed) return kept;
      const model = await make();
      models.set(name, model);
      return model;
    },
    open: (request: { name: string; area: "sidebar" }) => panel.open(request as never),
    newChat: async () => {
      const name = `new-${++made}`;
      newChats.push(name);
      return panel.open({ name, area: "sidebar", focus: true } as never);
    },
    backupPath: async (name: string) => `chats/${name}.chat`,
  };
  const app = {
    shell: { currentWidget: null, activateById: () => undefined, add: () => undefined },
    commands: new CommandRegistry(),
    serviceManager: { contents: { get: async () => Promise.reject(new Error("404")) } },
  };
  const panel = new ChatsPanel({
    app: app as never,
    core: {
      auth,
      hideCode: false,
      changed: new Signal<object, void>({}),
      config: { registerUrl: "", examples: [] },
    } as never,
    controller: controller as never,
    tracker: tracker as never,
    mainTracker: mainTracker as never,
    handler: { createModel: ({ name }: { name: string }) => new Model(name) } as never,
    rmRegistry: {} as never,
    inputToolbarFactory: { create: () => ({ hide: () => undefined }) } as never,
    chatCommands: null,
    themeManager: null,
    footers: {} as never,
    placeholder: {} as never,
    history: null,
    commands: { signIn: "sign-in", signOut: "sign-out" },
    logoUrl: "",
    close: () => undefined,
  });
  Widget.attach(panel, document.body);
  const shown = () => (panel.current() as { model: Model } | null)?.model ?? null;
  return { panel, models, newChats, shown };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ClimateClaw's panel", () => {
  it("replacing the only chat's model shows the new one and makes no other chat", async () => {
    const { panel, newChats, shown, models } = setup();
    await panel.open({ name: "branchy", area: "sidebar", focus: true } as never);
    const old = shown()!;
    const replaced = await panel.replace(
      old as never,
      { name: "branchy", area: "sidebar" } as never,
    );
    await settle();
    expect(old.isDisposed).toBe(true);
    expect(replaced).toBe(models.get("branchy"));
    expect(shown()).toBe(replaced);
    expect(newChats).toEqual([]);
    panel.dispose();
  });

  it("a replacement that shows nothing leaves the welcome, still without a new chat", async () => {
    const { panel, newChats, shown } = setup();
    await panel.open({ name: "gone", area: "sidebar", focus: true } as never);
    const old = shown()!;
    vi.spyOn(panel, "open").mockResolvedValueOnce(null);
    await panel.replace(old as never, { name: "gone", area: "sidebar" } as never);
    await settle();
    expect(shown()).toBeNull();
    expect(panel.node.dataset.view).toBe("welcome");
    expect(newChats).toEqual([]);
    panel.dispose();
  });

  it("moving the only chat into a tab makes no chat; the moved one stays the last chat", async () => {
    const { panel, newChats, shown } = setup();
    await panel.open({ name: "mine", area: "sidebar", focus: true } as never);
    const tab = await panel.open({ name: "mine", area: "main", focus: true } as never);
    await settle();
    expect((tab as { area: string }).area).toBe("main");
    expect(newChats).toEqual([]);
    expect(shown()).toBeNull();
    expect(panel.node.dataset.view).toBe("welcome");
    expect(window.localStorage.getItem(LAST_CHAT_KEY)).toBe("mine");
    panel.dispose();
  });

  it("the user's own steps still lead to a new chat: the last chat closed, a first visit", async () => {
    const { panel, newChats, shown } = setup();
    await panel.open({ name: "only", area: "sidebar", focus: true } as never);
    panel.remove(shown() as never);
    await settle();
    expect(newChats).toEqual(["new-1"]);
    expect(shown()?.name).toBe("new-1");
    const second = setup();
    await second.panel.restoreLast();
    await settle();
    expect(second.newChats).toEqual(["new-1"]);
    panel.dispose();
    second.panel.dispose();
  });
});
