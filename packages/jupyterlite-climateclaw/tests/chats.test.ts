// @vitest-environment jsdom
// The chat controller over the real jupyterlite-ai 0.20.1 chat models and jupyternaut personas
// (see upstream.ts): identities (name, title, thread) stay apart; a chat has one session (one
// model, listeners for the model's lifetime); the session writes the backup (each write's snapshot
// taken when its turn comes, jupyterlite-ai's autosave off) and never over one it could not read;
// another version replaces the model, so no stored question is answered again; deletion is
// server-first, revalidated, and waits for the writes already started; edits branch for their own
// chat only; a manual title stays.
import { beforeEach, describe, expect, it, vi } from "vitest";

// What jsdom lacks and the upstream modules read when loaded.
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
vi.mock("@jupyter/chat", async () => ({
  AbstractChatModel: (await import("@jupyter/chat/lib/model.js")).AbstractChatModel,
}));

const dialogs = vi.hoisted(() => ({
  gate: null as Promise<void> | null,
  accept: true,
  text: "",
  errors: [] as string[],
  warnings: [] as string[],
  infos: [] as string[],
}));
vi.mock("@jupyterlab/apputils", () => ({
  Dialog: {
    cancelButton: () => ({ accept: false }),
    warnButton: () => ({ accept: true }),
    okButton: () => ({ accept: true }),
  },
  showDialog: async () => {
    // A test may keep the dialog open while the chat changes underneath.
    await dialogs.gate;
    return { button: { accept: dialogs.accept } };
  },
  InputDialog: {
    getText: async () => ({ button: { accept: dialogs.accept }, value: dialogs.text }),
  },
  Notification: {
    error: (m: string) => dialogs.errors.push(m),
    warning: (m: string) => dialogs.warnings.push(m),
    info: (m: string) => dialogs.infos.push(m),
  },
}));

import type { AIChat } from "../src/chats.js";
import { PERSONA_USER } from "../src/history.js";
import { branchMarker, branchOf, threadMarker } from "../src/threads.js";
import { backupOf, setup, tick } from "./upstream.js";

const SAVED = { timeout: 4_000 };

beforeEach(() => {
  dialogs.accept = true;
  dialogs.gate = null;
  dialogs.text = "";
  dialogs.errors.length = 0;
  dialogs.warnings.length = 0;
  dialogs.infos.length = 0;
});

/** The bodies of a model's messages. */
const bodies = (model: AIChat) => model.messages.map((m) => String(m.body));
const saved = (text: string | undefined) =>
  (JSON.parse(text ?? "{}").messages ?? []).map((m: { body: string }) => m.body) as string[];
const writing = (model: AIChat, on: boolean) =>
  model.updateWriters(on ? [{ user: PERSONA_USER } as never] : []);

describe("names, titles and threads", () => {
  it("Ask from elsewhere opens a new chat; a blank chat in front is filled instead", async () => {
    const { controller, chatWith, panels } = setup();
    const ongoing = await chatWith("t-ongoing");
    ongoing.input.value = "half a question";
    await controller.ask("What is in this store?", false, "sidebar");
    const asked = panels[panels.length - 1]!.model;
    expect(asked).not.toBe(ongoing);
    expect(asked.input.value).toBe("What is in this store?");
    // The conversation in front is untouched: its messages and its draft.
    expect(ongoing.messages.length).toBeGreaterThan(0);
    expect(ongoing.input.value).toBe("half a question");
    // The new chat is still blank (nothing sent): a second Ask fills it, no third chat.
    asked.input.value = "";
    await controller.ask("And this one?", false, "sidebar");
    expect(panels[panels.length - 1]!.model).toBe(asked);
    expect(asked.input.value).toBe("And this one?");
    expect(panels).toHaveLength(2);
  });

  it("a new chat never takes the name of a saved backup (it would be restored into it)", async () => {
    const { store, controller } = setup();
    const name = await controller.newName();
    store.files.set(`chats/${name}.chat`, { type: "file", content: "{}" });
    expect(await controller.newName()).not.toBe(name);
  });

  it("opens a stored thread under its id, never its topic, as the server has it", async () => {
    const { controller, opened, backup, shown } = setup();
    await controller.openThread("T7", "Plot / ERA5: temp", "sidebar");
    expect(opened).toEqual(["sidebar:ClimateClaw T7"]);
    expect(JSON.parse(backup("ClimateClaw T7")).metadata.title).toBe("Plot / ERA5: temp");
    expect(bodies(shown("ClimateClaw T7")!)[1]).toContain("server answer");
  });

  it("an open chat on the thread is shown as it is (its draft kept), not rewritten", async () => {
    const { store, controller, chatWith, opened } = setup();
    const model = await chatWith("T3");
    model.input.value = "a draft";
    store.saved.length = 0;
    await controller.openThread("T3", "topic", "main");
    expect(opened.at(-1)).toBe(`main:${model.name}`);
    expect(model.input.value).toBe("a draft");
    expect(store.saved).toEqual([]);
  });
});

describe("one session per chat", () => {
  it("two opens at once make one model for the chat", async () => {
    const { controller, models, panels } = setup();
    const name = await controller.newName();
    await Promise.all([
      controller.open({ name, area: "sidebar" }),
      controller.open({ name, area: "sidebar" }),
    ]);
    expect(models).toHaveLength(1);
    expect(panels).toHaveLength(1);
  });

  it("a moved chat keeps its listeners: the server's title still arrives", async () => {
    const { controller, chatWith, panels } = setup({
      userThreads: async () => ({ threads: [{ threadId: "T1", topic: "Server title" }], total: 1 }),
    });
    const model = await chatWith("T1");
    await controller.open({ name: model.name, area: "main" });
    expect(panels).toHaveLength(1);
    expect(panels[0]!.area).toBe("main");
    writing(model, true);
    writing(model, false);
    await vi.waitFor(() => expect(model.title).toBe("Server title"));
  });

  it("a moved chat is still saved as it changes", async () => {
    const { controller, chatWith, backup } = setup();
    const model = await chatWith(null);
    await controller.open({ name: model.name, area: "main" });
    await model.sendMessage({ body: "after the move" });
    await vi.waitFor(() => expect(saved(backup(model.name))).toContain("after the move"), SAVED);
  });
});

describe("the backup", () => {
  it("is written by the session; jupyterlite-ai's flag shows the session's setting", async () => {
    const { controller, chatWith, backup, store } = setup();
    const model = await chatWith("T1");
    // Its backup said autosave: true: one setting, shown by both UIs.
    expect(model.autosave).toBe(true);
    expect(controller.autosaves(model)).toBe(true);
    await model.sendMessage({ body: "more" });
    await vi.waitFor(() => expect(saved(backup(model.name)).at(-1)).toBe("more"), SAVED);
    expect(store.newUntitled).not.toHaveBeenCalled();
  });

  it("jupyterlite-ai's autosave button turns it off and on; its Save always saves", async () => {
    const { controller, chatWith, backup } = setup();
    const model = await chatWith("T1");
    // The button: `model.autosave = !model.autosave`.
    model.autosave = !model.autosave;
    expect(controller.autosaves(model)).toBe(false);
    const before = backup(model.name);
    await model.sendMessage({ body: "not saved by itself" });
    // Longer than both savers wait (the session's 1.5 s, jupyterlite-ai's 3 s).
    await tick(3_400);
    expect(backup(model.name)).toBe(before);
    // Its Save button (`model.save()`) saves anyway, through the session.
    await model.save();
    expect(saved(backup(model.name)).at(-1)).toBe("not saved by itself");
    expect(JSON.parse(backup(model.name)).metadata.autosave).toBe(false);
    model.autosave = !model.autosave;
    expect(controller.autosaves(model)).toBe(true);
    await model.sendMessage({ body: "saved again" });
    await vi.waitFor(() => expect(saved(backup(model.name)).at(-1)).toBe("saved again"), SAVED);
    // ClimateClaw's own menu toggles the same setting, and the button shows it.
    controller.setAutosave(model, false);
    expect(model.autosave).toBe(false);
  }, 12_000);

  it("autosave turned off stays off after a reload, and after showing another version", async () => {
    const versions = {
      thread: async (id: string) => [
        { variant: "User", content: `question on ${id}` },
        { variant: "Assistant", content: `answer on ${id}` },
      ],
    };
    const { controller, chatWith, backup } = setup(versions);
    const model = await chatWith("T1");
    controller.setAutosave(model, false);
    await controller.saveNow(model);
    expect(JSON.parse(backup(model.name)).metadata.autosave).toBe(false);
    await controller.switchTo(model, "T2");
    expect(JSON.parse(backup(model.name)).metadata.autosave).toBe(false);
    // The next page: its backup is all it has.
    const page = setup();
    page.store.files.set(`chats/${model.name}.chat`, {
      type: "file",
      content: backup(model.name),
    });
    await page.controller.open({ name: model.name, area: "sidebar" });
    const reloaded = page.shown(model.name)!;
    await vi.waitFor(() => expect(page.controller.autosaves(reloaded)).toBe(false));
    const before = page.backup(model.name);
    await reloaded.sendMessage({ body: "not saved by itself" });
    await tick(2_000);
    expect(page.backup(model.name)).toBe(before);
  }, 10_000);

  it("the last write holds the newest conversation (its snapshot taken when its turn comes)", async () => {
    const { controller, chatWith, backup, store } = setup();
    const model = await chatWith("T1");
    const path = `chats/${model.name}.chat`;
    const release = store.holdOnce(path);
    const first = controller.saveNow(model);
    await vi.waitFor(() => expect(store.save).toHaveBeenCalled());
    // Changed while the first write waits; a second write is asked for.
    await model.sendMessage({ body: "newer" });
    const second = controller.saveNow(model);
    release();
    await Promise.all([first, second]);
    expect(saved(backup(model.name)).at(-1)).toBe("newer");
  });

  it("a backup it could not read (503) is never replaced", async () => {
    const { controller, store, backup } = setup();
    const name = await controller.newName();
    const path = `chats/${name}.chat`;
    store.files.set(path, { type: "file", content: '{"messages":[{"id":"kept"}]}' });
    store.failing.set(path, 503);
    await controller.open({ name, area: "sidebar" });
    store.failing.delete(path);
    const model = (await controller.open({ name, area: "sidebar" }))!.model as AIChat;
    await model.sendMessage({ body: "new" });
    await controller.saveNow(model);
    expect(backup(name)).toBe('{"messages":[{"id":"kept"}]}');
  });

  it("a backup directory it could not read is not made again", async () => {
    const { controller, chatWith, store } = setup();
    const model = await chatWith(null);
    store.dirs.delete("chats");
    store.failing.set("chats", 503);
    store.save.mockClear();
    await expect(controller.saveNow(model)).rejects.toThrow("503");
    expect(store.newUntitled).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();
  });
});

describe("rename", () => {
  it("sets the title and the thread's topic; the backup's name does not change", async () => {
    const { controller, chatWith, calls } = setup();
    const model = await chatWith("T1");
    const name = model.name;
    await controller.rename(model, "  ERA5   anomalies ");
    expect(model.title).toBe("ERA5 anomalies");
    expect(model.name).toBe(name);
    expect(calls).toContainEqual(["setTopic", "T1", "ERA5 anomalies"]);
  });

  it("before the chat has a thread, the topic is sent once the first reply ends", async () => {
    const { controller, chatWith, calls } = setup();
    const model = await chatWith(null);
    await controller.rename(model, "Early name");
    expect(calls).toEqual([]);
    model.messages[1]!.update({ body: `${threadMarker("T2")}\nanswer` });
    writing(model, true);
    writing(model, false);
    await vi.waitFor(() => expect(calls).toContainEqual(["setTopic", "T2", "Early name"]));
  });

  it("a title the server gives late never replaces the user's rename", async () => {
    let answer: (page: unknown) => void = () => undefined;
    const { controller, chatWith } = setup({
      userThreads: () => new Promise((resolve) => (answer = resolve)),
    });
    const model = await chatWith("T1");
    writing(model, true);
    writing(model, false);
    await tick();
    await controller.rename(model, "Mine");
    answer({ threads: [{ threadId: "T1", topic: "Automatic" }], total: 1 });
    await tick(10);
    expect(model.title).toBe("Mine");
  });

  it("jupyterlite-ai's Auto Title never replaces the user's rename", async () => {
    const { controller, chatWith } = setup({}, { autoTitle: true });
    const model = await chatWith("T1");
    // Auto Title names the chat after a reply...
    await model.sendMessage({ body: "first" });
    await vi.waitFor(() => expect(model.title).toBe("Automatic title"));
    // ...but not once the user named it.
    await controller.rename(model, "Mine");
    await model.sendMessage({ body: "second" });
    await tick(20);
    expect(model.title).toBe("Mine");
  });
});

describe("delete", () => {
  it("server first: when it fails nothing here changes", async () => {
    const { controller, chatWith, backup, panels } = setup({
      deleteThread: async () => {
        throw new Error("HTTP 500");
      },
    });
    const model = await chatWith("T1");
    expect(await controller.delete(model)).toBe(false);
    expect(dialogs.errors[0]).toContain("HTTP 500");
    expect(backup(model.name)).toBeDefined();
    expect(model.isDisposed).toBe(false);
    expect(panels).toHaveLength(1);
  });

  it("stops it, deletes the thread, then the backup; nothing writes it again", async () => {
    const { controller, chatWith, store, calls, agentOf } = setup();
    const model = await chatWith("T1");
    const agent = agentOf(model);
    expect(await controller.delete(model)).toBe(true);
    expect(agent.stops).toBeGreaterThan(0);
    expect(calls).toContainEqual(["deleteThread", "T1"]);
    expect(model.isDisposed).toBe(true);
    expect(store.files.has(`chats/${model.name}.chat`)).toBe(false);
    await controller.saveNow(model);
    await tick(20);
    expect(store.files.has(`chats/${model.name}.chat`)).toBe(false);
  });

  it("waits for a backup write already started, then removes it (no resurrection)", async () => {
    const { controller, chatWith, store } = setup();
    const model = await chatWith("T1");
    const path = `chats/${model.name}.chat`;
    const release = store.hold(path);
    const writing = controller.saveNow(model);
    await vi.waitFor(() => expect(store.save).toHaveBeenCalled());
    const deleting = controller.delete(model);
    await tick(20);
    expect(model.isDisposed).toBe(false);
    release();
    await writing;
    expect(await deleting).toBe(true);
    expect(store.files.has(path)).toBe(false);
    await tick(20);
    expect(store.files.has(path)).toBe(false);
  });

  it("a stored thread deleted from the history: its backup goes, and stays gone", async () => {
    const { controller, store } = setup();
    await controller.openThread("T9", "topic", "sidebar");
    expect(store.files.has("chats/ClimateClaw T9.chat")).toBe(true);
    await controller.deleteThread("T9", "topic");
    expect(store.files.has("chats/ClimateClaw T9.chat")).toBe(false);
    await tick(20);
    expect(store.files.has("chats/ClimateClaw T9.chat")).toBe(false);
  });

  it("asks first; a cancel changes nothing", async () => {
    dialogs.accept = false;
    const { controller, chatWith, calls, agentOf } = setup();
    const model = await chatWith("T1");
    const stops = agentOf(model).stops;
    expect(await controller.delete(model)).toBe(false);
    expect(calls).toEqual([]);
    expect(agentOf(model).stops).toBe(stops);
    expect(model.isDisposed).toBe(false);
  });

  it("deleting from the history finds a closed chat with a name of its own", async () => {
    const { controller, chatWith, store } = setup();
    const model = await chatWith("T1");
    controller.presenter!.closeChat(model);
    await controller.deleteThread("T1", "topic");
    expect(store.files.has(`chats/${model.name}.chat`)).toBe(false);
    expect(model.isDisposed).toBe(true);
  });

  it("deleting from the history removes a backup of the thread from an earlier visit", async () => {
    const { controller, store } = setup();
    const kept = (thread: string) =>
      JSON.stringify({
        messages: [
          { id: "1", body: "q", sender: "me" },
          { id: "2", body: `${threadMarker(thread)}\na`, sender: "bot" },
        ],
        users: { me: { username: "me" }, bot: { username: "bot", bot: true } },
      });
    store.files.set("chats/Chat 10:00 abc123.chat", { type: "file", content: kept("T5") });
    store.files.set("chats/Other.chat", { type: "file", content: kept("T6") });
    await controller.deleteThread("T5", "topic");
    expect(store.files.has("chats/Chat 10:00 abc123.chat")).toBe(false);
    expect(store.files.has("chats/Other.chat")).toBe(true);
  });

  it("while the server deletes a thread, its chat cannot move to another version", async () => {
    let done: () => void = () => undefined;
    const { controller, chatWith, calls, shown, store } = setup({
      deleteThread: () => new Promise<void>((resolve) => (done = resolve)),
      thread: async (id: string) => [
        { variant: "User", content: `q ${id}` },
        { variant: "Assistant", content: `a ${id}` },
      ],
    });
    const model = await chatWith("T1");
    const deleting = controller.deleteThread("T1", "topic");
    await tick();
    await controller.switchTo(model, "B");
    expect(shown(model.name)).toBe(model);
    expect(calls.some(([c]) => c === "editThread")).toBe(false);
    done();
    await deleting;
    expect(model.isDisposed).toBe(true);
    expect(store.files.has(`chats/${model.name}.chat`)).toBe(false);
  });
});

describe("delete, revalidated", () => {
  it("Delete confirmed after the chat moved to another version: the version shown stays", async () => {
    let confirm: () => void = () => undefined;
    dialogs.gate = new Promise<void>((resolve) => (confirm = resolve));
    const { controller, chatWith, calls, shown, store } = setup({
      thread: async (id: string) => [
        { variant: "User", content: `q ${id}` },
        { variant: "Assistant", content: `a ${id}` },
      ],
    });
    const model = await chatWith("T1");
    // Delete opens on T1; B finishes loading before the user confirms.
    const deleting = controller.delete(model);
    await tick();
    await controller.switchTo(model, "B");
    const now = shown(model.name)!;
    expect(now).not.toBe(model);
    confirm();
    expect(await deleting).toBe(true);
    // T1 is deleted on the server, as confirmed; B, its model and its backup stay.
    expect(calls).toContainEqual(["deleteThread", "T1"]);
    expect(shown(model.name)).toBe(now);
    expect(now.isDisposed).toBe(false);
    await controller.saveNow(now);
    expect(store.files.has(`chats/${model.name}.chat`)).toBe(true);
    // And it can still move: nothing left it marked as being deleted.
    await controller.switchTo(now, "B2");
    expect(shown(model.name)).not.toBe(now);
  });

  it("a chat that moved to another thread while the server deleted keeps its conversation", async () => {
    let done: () => void = () => undefined;
    const { controller, chatWith, reply, store } = setup({
      deleteThread: () => new Promise<void>((resolve) => (done = resolve)),
    });
    const model = await chatWith("T1");
    const deleting = controller.deleteThread("T1", "topic");
    await tick();
    // The server forked it meanwhile: its reply names another thread.
    reply(model, `${threadMarker("F1")}\nforked`);
    done();
    await deleting;
    expect(model.isDisposed).toBe(false);
    await controller.saveNow(model);
    expect(store.files.has(`chats/${model.name}.chat`)).toBe(true);
  });
});

describe("edit", () => {
  const branchApi = {
    thread: async (id: string) =>
      id.startsWith("B")
        ? [{ variant: "ServerHint", content: { thread_id: id } }]
        : [
            { variant: "User", content: "q" },
            { variant: "Assistant", content: "a" },
          ],
  };

  it("branches on the server at the stored question, shows the branch, sends the edit there", async () => {
    const { controller, chatWith, calls, shown, agentOf } = setup(branchApi);
    const model = await chatWith("T1");
    await controller.edit(model, "u1", { body: "q, better" } as never);
    expect(calls).toContainEqual(["editThread", "T1", 0]);
    // The branch's own model: nothing before the first question, which names its branch.
    const branch = shown(model.name)!;
    expect(branch).not.toBe(model);
    expect(model.isDisposed).toBe(true);
    expect(agentOf(branch).prompts).toEqual([`q, better\n${branchMarker("B1")}`]);
    expect(controller.branches.versions("B1", 0)).toEqual({ threads: ["T1", "B1"], index: 1 });
  });

  it("two chats editing to the same words each send to their own branch", async () => {
    let branches = 0;
    const { controller, chatWith, shown, agentOf } = setup({
      ...branchApi,
      editThread: async () => `B${(branches += 1)}`,
    });
    const one = await chatWith("T1");
    const two = await chatWith("T2");
    await Promise.all([
      controller.edit(one, "u1", { body: "same words" } as never),
      controller.edit(two, "u1", { body: "same words" } as never),
    ]);
    const sentTo = (name: string) => branchOf(agentOf(shown(name)!).prompts[0]!);
    expect(new Set([sentTo(one.name), sentTo(two.name)])).toEqual(new Set(["B1", "B2"]));
  });

  it("keeps the edited question's attachments and mentions", async () => {
    const { controller, chatWith, shown } = setup(branchApi);
    const model = await chatWith("T1");
    const attachments = [{ type: "notebook", value: "era5.ipynb" }];
    const mentions = [{ username: "someone" }];
    await controller.edit(model, "u1", {
      body: "explain this notebook",
      attachments,
      mentions,
    } as never);
    expect(shown(model.name)!.messages.at(-1)).toMatchObject({ attachments, mentions });
  });

  it("the branch marker leaves the question once its reply has ended", async () => {
    const { controller, chatWith, shown, agentOf } = setup(branchApi);
    const model = await chatWith("T1");
    await controller.edit(model, "u1", { body: "q2" } as never);
    const branch = shown(model.name)!;
    // Asked with its branch named; the persona's reply (at once, here) has ended since.
    expect(branchOf(agentOf(branch).prompts[0]!)).toBe("B1");
    expect(branch.messages.at(-1)!.body).toBe("q2");
  });

  it("refuses a question the server has not stored, and while a reply runs", async () => {
    const { controller, chatWith, calls } = setup();
    const unstored = await chatWith(null);
    await controller.edit(unstored, "u1", { body: "x" } as never);
    expect(dialogs.warnings[0]).toContain("cannot be edited");
    const busy = await chatWith("T1");
    writing(busy, true);
    await controller.edit(busy, "u1", { body: "x" } as never);
    expect(dialogs.warnings[1]).toContain("Wait for the reply");
    expect(calls).toEqual([]);
  });

  it("every chat gets the edit hook (jupyter/chat shows Edit only then)", async () => {
    const { chatWith } = setup();
    const model = await chatWith(null);
    expect(typeof model.updateMessage).toBe("function");
  });

  it("a reply streamed through the same hook is applied as it is, never taken for an edit", async () => {
    const { chatWith, calls } = setup();
    const model = await chatWith("T1");
    writing(model, true);
    await model.updateMessage!("a1", { body: "streaming…", sender: PERSONA_USER } as never);
    expect(model.messages[1]!.body).toBe("streaming…");
    expect(calls).toEqual([]);
    expect(dialogs.warnings).toEqual([]);
  });
});

describe("another version of the conversation", () => {
  const versions = {
    thread: async (id: string) => [
      { variant: "User", content: `question on ${id}` },
      { variant: "Assistant", content: `answer on ${id}` },
    ],
  };

  it("is shown without answering its stored questions again", async () => {
    const { controller, chatWith, shown, agents, backup } = setup(versions);
    const model = await chatWith("T1");
    await controller.switchTo(model, "T0");
    const now = shown(model.name)!;
    expect(bodies(now)[0]).toBe("question on T0");
    expect(JSON.parse(backup(model.name)).messages[0].body).toBe("question on T0");
    // No persona was asked anything: the restored question is history, not a new question.
    await tick(10);
    expect(agents.flatMap((agent) => agent.prompts)).toEqual([]);
  });

  it("(why: restoring into a live model makes its persona answer the restored question again)", async () => {
    const { chatWith, agentOf, store } = setup();
    const model = await chatWith("T1");
    // Another version's backup: its messages are new to this model's persona.
    const other = JSON.parse(backupOf("T0"));
    other.messages[0].id = "v1";
    other.messages[1].id = "v2";
    store.files.set("chats/other.chat", { type: "file", content: JSON.stringify(other) });
    await model.restore("chats/other.chat");
    await tick(10);
    expect(agentOf(model).prompts).toEqual(["q"]);
  });

  it("a question sent while the version loads wins: the switch is dropped", async () => {
    let answer: (variants: unknown[]) => void = () => undefined;
    const { controller, chatWith, shown, models } = setup({
      thread: () => new Promise<unknown[]>((resolve) => (answer = resolve)),
    });
    const model = await chatWith("T1");
    const switching = controller.switchTo(model, "T0");
    await tick();
    await model.sendMessage({ body: "a new question" });
    answer([
      { variant: "User", content: "old" },
      { variant: "Assistant", content: "old answer" },
    ]);
    await switching;
    expect(shown(model.name)).toBe(model);
    expect(models).toHaveLength(1);
    expect(bodies(model).at(-1)).toBe("a new question");
  });

  it("of two switches, the newer is shown; a question sent after it stays", async () => {
    const answers: Array<(variants: unknown[]) => void> = [];
    const { controller, chatWith, store, shown, backup, agents } = setup({
      thread: () => new Promise<unknown[]>((resolve) => answers.push(resolve)),
    });
    const model = await chatWith("T1");
    const path = `chats/${model.name}.chat`;
    const first = controller.switchTo(model, "A");
    const second = controller.switchTo(model, "B");
    await tick();
    // A's backup write is slow; B arrives meanwhile.
    const release = store.holdOnce(path);
    answers[0]!([
      { variant: "User", content: "on A" },
      { variant: "Assistant", content: "A" },
    ]);
    await tick(5);
    answers[1]!([
      { variant: "User", content: "on B" },
      { variant: "Assistant", content: "B" },
    ]);
    await tick(5);
    release();
    await Promise.all([first, second]);
    const now = shown(model.name)!;
    expect(bodies(now)[0]).toBe("on B");
    await now.sendMessage({ body: "after B" });
    await controller.saveNow(now);
    expect(saved(backup(model.name))).toEqual(["on B", expect.stringContaining("B"), "after B"]);
    expect(agents.flatMap((agent) => agent.prompts)).toEqual(["after B"]);
  });

  it("the old version's pending save never lands after the new one", async () => {
    const { controller, chatWith, store, shown, backup } = setup(versions);
    const model = await chatWith("T1");
    const path = `chats/${model.name}.chat`;
    const release = store.holdOnce(path);
    const stale = controller.saveNow(model);
    await vi.waitFor(() => expect(store.save).toHaveBeenCalled());
    const switching = controller.switchTo(model, "T2");
    await tick(5);
    release();
    await Promise.all([stale, switching]);
    expect(bodies(shown(model.name)!)[0]).toBe("question on T2");
    expect(saved(backup(model.name))[0]).toBe("question on T2");
  });

  it("jupyterlite-ai's final save of a replaced model never lands (its lookup held meanwhile)", async () => {
    const { controller, chatWith, store, shown, backup } = setup(versions);
    const model = await chatWith("T1");
    const path = `chats/${model.name}.chat`;
    // Turning its autosave off made jupyterlite-ai schedule a save (3 s); hold that save's lookup.
    const read = store.get.getMockImplementation()!;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let lookups = 0;
    store.get.mockImplementation(async (p: string, o?: { content?: boolean }) => {
      if (p === path && !o?.content && (lookups += 1) === 1) await held;
      return read(p, o);
    });
    await vi.waitFor(() => expect(lookups).toBe(1), { timeout: 6_000 });
    await controller.switchTo(model, "T2");
    expect(bodies(shown(model.name)!)[0]).toBe("question on T2");
    release();
    await tick(50);
    expect(saved(backup(model.name))[0]).toBe("question on T2");
  }, 10_000);

  it("the draft - its text, attachments and mentions - goes with the chat to the version", async () => {
    const { controller, chatWith, shown } = setup(versions);
    const model = await chatWith("T1");
    const attachment = { type: "file", value: "data.csv" };
    model.input.value = "half a question";
    model.input.addAttachment?.(attachment as never);
    model.input.addMention?.({ username: "someone" } as never);
    await controller.switchTo(model, "T2");
    const now = shown(model.name)!;
    expect(now).not.toBe(model);
    expect(now.input.value).toBe("half a question");
    expect(now.input.attachments).toEqual([attachment]);
    expect(now.input.mentions.map((user) => user.username)).toEqual(["someone"]);
  });

  it("a deletion that came during a switch lets the chat go on (it moved off the thread)", async () => {
    let done: () => void = () => undefined;
    const { controller, chatWith, store, shown } = setup({
      ...versions,
      deleteThread: () => new Promise<void>((resolve) => (done = resolve)),
    });
    const model = await chatWith("T1");
    await tick(10);
    const path = `chats/${model.name}.chat`;
    // The new model's read of its backup is slow.
    const read = store.get.getMockImplementation()!;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let reads = 0;
    store.get.mockImplementation(async (p: string, o?: { content?: boolean }) => {
      if (p === path && o?.content && (reads += 1) === 1) await held;
      return read(p, o);
    });
    const switching = controller.switchTo(model, "T2");
    await vi.waitFor(() => expect(reads).toBe(1));
    const deleting = controller.deleteThread("T1", "topic");
    await tick(5);
    release();
    await switching;
    done();
    await deleting;
    const now = shown(model.name)!;
    expect(bodies(now)[0]).toBe("question on T2");
    // Not deleted, and not stuck: it moves to another version again.
    await controller.switchTo(now, "T3");
    expect(bodies(shown(model.name)!)[0]).toBe("question on T3");
  });

  it("a version that does not load leaves the chat as it was, and says so", async () => {
    const { controller, chatWith, store, shown, agents } = setup(versions);
    const model = await chatWith("T1");
    const path = `chats/${model.name}.chat`;
    // The next read of the backup fails (the new model's), once.
    const fail = store.get.getMockImplementation()!;
    let failed = false;
    store.get.mockImplementation(async (p: string, o?: { content?: boolean }) => {
      if (p === path && o?.content && !failed) {
        failed = true;
        throw Object.assign(new Error("HTTP 503"), { response: { status: 503 } });
      }
      return fail(p, o);
    });
    await controller.edit(model, "u1", { body: "edited" } as never);
    expect(dialogs.errors[0]).toMatch(/could not be loaded/);
    expect(bodies(shown(model.name)!)).toEqual(bodies(model));
    // The edited question was not sent into the old history.
    expect(agents.flatMap((agent) => agent.prompts)).toEqual([]);
  });

  it("a thread reopened from the history after its chat moved to another version shows the thread", async () => {
    const { controller, shown, backup } = setup(versions);
    await controller.openThread("T", "topic", "sidebar");
    const name = "ClimateClaw T";
    await controller.switchTo(shown(name)!, "B");
    expect(bodies(shown(name)!)[0]).toBe("question on B");
    const moved = shown(name)!;
    controller.presenter!.closeChat(moved);
    await controller.openThread("T", "topic", "sidebar");
    expect(bodies(shown(name)!)[0]).toBe("question on T");
    await controller.saveNow(shown(name)!);
    expect(saved(backup(name))[0]).toBe("question on T");
  });
});
