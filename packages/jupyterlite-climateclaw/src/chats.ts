// The ClimateClaw chats, one controller for both hosts: ClimateClaw's own panel (the portal's
// notebook) and jupyterlite-ai's panel (a JupyterLab or JupyterLite installed with pip). What
// differs - where a chat is shown and how its model is made - is the presenter's; everything else
// is here, on jupyterlite-ai's chat model API (name, title, autosave, save, restore, the agent).
//
// Three identities, never mixed: `model.name` is the chat's stable local id and its backup's file
// name; `model.title` is what the user reads and may rename; the ClimateClaw thread is the
// server's conversation, read from the chat's replies, and changes when a message is edited (a
// branch) or the server forks it.
//
// Each chat has one session here, by its local id (see chat-session.ts): views are presentations
// of it. The session owns the listeners (for the model's lifetime, not a view's), the opens, the
// operations that replace the conversation, and the whole of its backup: ClimateClaw writes it
// (jupyterlite-ai's own autosave stays off), and another version is shown by replacing the
// chat's model with one made from that version's backup - never by restoring into a live model,
// whose persona would answer the restored questions again.

import type { JupyterFrontEnd } from "@jupyterlab/application";
import { Dialog, InputDialog, Notification, showDialog } from "@jupyterlab/apputils";
import { PathExt } from "@jupyterlab/coreutils";
import type { ISettingRegistry } from "@jupyterlab/settingregistry";
import type {
  IAttachment,
  IChatModel,
  IChatPanel,
  IChatTracker,
  IInputModel,
  IMessageContent,
  IUser,
} from "@jupyter/chat";
import type { IAISettingsModel } from "@jupyternaut/agent";

import type { ConversationsPanel } from "./conversations.js";
import type { IClimateClaw } from "./core.js";
import { PROVIDER_ID } from "./config.js";
import { routeChatContents } from "./ai-chat-internals.js";
import { serializeChat } from "./chat-backup.js";
import { ChatSession, guardedContents } from "./chat-session.js";
import {
  chatNameFor,
  isNotFound,
  newChatName,
  randomId,
  threadToChat,
  type ExportedChat,
} from "./history.js";
import { BranchStore, chatThread, FeedbackStore, storedTurn } from "./reply-actions.js";
import type { ThreadNotebooks } from "./thread-notebooks.js";
import { delay } from "./thread-gate.js";
import { branchMarker, branchOf, markedThread, stripBranch, stripMarkers } from "./threads.js";

export const AI_CHAT_SETTINGS = "@jupyterlite/ai:chat";

/** jupyterlite-ai's chat model, as far as this module uses it. */
export interface AIChat extends IChatModel {
  title: string | null;
  autosave: boolean;
  readonly autosaveChanged: IChatModel["messagesUpdated"];
  readonly titleChanged: IChatModel["messagesUpdated"];
  readonly isBusy?: boolean;
  save(): Promise<void>;
  restore(filepath: string, silent?: boolean): Promise<boolean>;
  stopStreaming?(): void;
}

export type ChatArea = "sidebar" | "main";

export interface OpenRequest {
  /** The chat's local name; its backup, if any, is restored. */
  name: string;
  area: ChatArea;
  focus?: boolean;
  input?: string;
  send?: boolean;
}

/**
 * Where chats are shown, and how their models are made: the host's part. Both hosts give the
 * same lifecycle: `open` shows a chat, making its model (from its backup) when it has none;
 * `closeChat` takes its views away and keeps its model; `remove` lets go of a model the
 * controller is about to dispose - its views and every reference the host keeps to it - so the
 * next `open` makes a new one; `replace` (see `replaceChat`) is remove, dispose, open.
 */
export interface ChatPresenter {
  open(request: OpenRequest): Promise<IChatPanel | null>;
  /** Takes a chat's views away; its model stays (the session keeps it). */
  closeChat(model: IChatModel): void;
  /** Lets go of `model` everywhere the host holds it; the caller disposes it. */
  remove(model: IChatModel): void;
  /** The chat's model replaced by a new one, made from its backup (see `replaceChat`). */
  replace(old: IChatModel, request: OpenRequest): Promise<IChatModel | null>;
  /** The chat in front, if any. */
  current(): IChatPanel | null;
}

/**
 * Replaces a chat's model, the same in every host: the host lets go of the old one, it is
 * disposed, and the chat is opened again - so its new model is made from its backup. The model
 * shown then, or null when the host shows none; never the old one.
 */
export async function replaceChat(
  presenter: ChatPresenter,
  old: IChatModel,
  request: OpenRequest,
): Promise<IChatModel | null> {
  presenter.remove(old);
  if (!old.isDisposed) old.dispose();
  const panel = await presenter.open(request);
  const model = panel?.model ?? null;
  if (model === old || model?.isDisposed) {
    throw new Error("the chat's old model was shown again after it was replaced");
  }
  return model;
}

/** The id of the newest message from the user, or null. */
function lastHumanId(model: IChatModel): string | null {
  for (let i = model.messages.length - 1; i >= 0; i -= 1) {
    const message = model.messages[i]!;
    if (!message.sender.bot) return message.id;
  }
  return null;
}

type Contents = JupyterFrontEnd["serviceManager"]["contents"];

/**
 * The thread a backup file's conversation is on (its replies' markers), or null. Messages are
 * stored with a sender key; a reply's sender is a bot in `users`.
 */
export function backupThread(text: string): string | null {
  try {
    const chat = JSON.parse(text) as {
      messages?: Array<{ body?: unknown; sender?: unknown }>;
      users?: Record<string, { bot?: boolean }>;
    };
    return markedThread(
      (chat.messages ?? []).map((m) => ({
        role:
          chat.users && typeof m.sender === "string" && !chat.users[m.sender]?.bot
            ? "user"
            : "assistant",
        content: typeof m.body === "string" ? m.body : "",
      })),
    );
  } catch {
    return null;
  }
}

/** How long a chat's changes settle before its backup is written. */
const SAVE_DELAY_MS = 1_500;

/**
 * jupyterlite-ai's own debounced autosave goes through contents that write no backup, where its
 * pinned internals allow (see ai-chat-internals.ts): the session is the only writer.
 */
function guardModelSaves(model: AIChat, contents: Contents): void {
  if (!routeChatContents(model, contents)) {
    console.warn("ClimateClaw: this jupyterlite-ai's own chat saves are not ordered with ours.");
  }
}

export class ChatController {
  readonly feedback: FeedbackStore;
  readonly branches: BranchStore;
  presenter: ChatPresenter | null = null;
  /** One session per chat, by its local id. */
  readonly #sessions = new Map<string, ChatSession>();
  /** Each session's guarded contents (see chat-session.ts). */
  readonly #contents = new WeakMap<ChatSession, Contents>();
  /** Models whose listeners are connected (until the model is disposed). */
  readonly #bound = new WeakSet<IChatModel>();

  constructor(
    private readonly app: JupyterFrontEnd,
    private readonly core: IClimateClaw,
    private readonly tracker: IChatTracker,
    private readonly registry: ISettingRegistry,
    private readonly settings: IAISettingsModel | null,
    readonly notebooks: ThreadNotebooks | null,
  ) {
    this.feedback = new FeedbackStore(() => core.api);
    let storage: Storage | null = null;
    try {
      storage = window.localStorage;
    } catch {
      storage = null;
    }
    this.branches = new BranchStore(storage);
    tracker.forEach((panel) => this.attach(panel));
    tracker.widgetAdded.connect((_, panel) => this.attach(panel));
    // The notebook a thread's code goes to is named after its chat.
    core.chatTitleOf = (thread) => {
      const panel = tracker.find((p) => chatThread(p.model) === thread);
      return (panel?.model as AIChat | undefined)?.title ?? null;
    };
  }

  /** The configured ClimateClaw entry to start chats with: the default, if it is ClimateClaw's. */
  providerId(): string {
    const settings = this.settings;
    if (!settings) return PROVIDER_ID;
    const fallback = settings.getDefaultProvider();
    if (fallback?.provider === PROVIDER_ID) return fallback.id;
    return settings.providers.find((p) => p.provider === PROVIDER_ID)?.id ?? PROVIDER_ID;
  }

  async backupDirectory(): Promise<string> {
    try {
      const chat = await this.registry.load(AI_CHAT_SETTINGS);
      return String(chat.composite.chatBackupDirectory ?? "");
    } catch {
      return "";
    }
  }

  async backupPath(name: string): Promise<string> {
    return PathExt.join(await this.backupDirectory(), `${name}.chat`);
  }

  /** A name no open chat and no saved backup has: a backup of that name would be restored. */
  async newName(): Promise<string> {
    const taken = new Set<string>();
    this.tracker.forEach((panel) => taken.add(panel.model.name));
    const directory = await this.backupDirectory();
    const stamp = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = newChatName(stamp, randomId());
      if (taken.has(candidate) || this.#sessions.has(candidate)) continue;
      // Free only when the store confirms there is no such backup.
      const saved = await this.app.serviceManager.contents
        .get(PathExt.join(directory, `${candidate}.chat`), { content: false })
        .then(
          () => true,
          (error: unknown) => !isNotFound(error),
        );
      if (!saved) return candidate;
    }
    throw new Error("No free name for a new chat.");
  }

  // sessions and opening

  /** The chat's session (made on first use). */
  #session(name: string): ChatSession {
    let session = this.#sessions.get(name);
    if (!session) {
      session = new ChatSession(name);
      this.#sessions.set(name, session);
      this.#contents.set(session, guardedContents(this.app.serviceManager.contents, session));
    }
    return session;
  }

  /** The chat's session, once any deletion of an earlier chat of that name has finished. */
  async #live(name: string): Promise<ChatSession> {
    for (;;) {
      const session = this.#sessions.get(name);
      if (!session?.deleted) return this.#session(name);
      await session.deletion?.catch(() => undefined);
      if (this.#sessions.get(name) === session) this.#sessions.delete(name);
    }
  }

  #store(session: ChatSession): Contents {
    return this.#contents.get(session)!;
  }

  /**
   * Shows a chat: one open at a time per chat, so two calls never make two models for it. Every
   * open goes through here, whichever host shows it.
   */
  async open(request: OpenRequest): Promise<IChatPanel | null> {
    const session = await this.#live(request.name);
    return session.serialize(() => this.#presenter().open(request));
  }

  /**
   * The chat's model, made once: a presenter that makes models (ClimateClaw's own panel) asks
   * here, and concurrent asks get the same model.
   */
  model(name: string, create: () => Promise<AIChat>): Promise<AIChat> {
    const session = this.#session(name);
    const current = session.model as AIChat | null;
    if (current && !current.isDisposed) return Promise.resolve(current);
    session.creating ??= create().then(
      (model) => {
        this.#bind(session, model);
        return model;
      },
      (error: unknown) => {
        session.creating = null;
        throw error;
      },
    );
    return session.creating as Promise<AIChat>;
  }

  async newChat(options: Omit<OpenRequest, "name"> = { area: "sidebar" }) {
    const name = await this.newName();
    return this.open({ focus: true, ...options, name });
  }

  /**
   * A stored thread, as the server has it (its conversation is the truth): an open chat on it is
   * shown as it is (its draft kept); otherwise the thread's conversation is written to its backup
   * and opened.
   */
  async openThread(threadId: string, topic: string, area: ChatArea): Promise<IChatPanel | null> {
    // A chat on the thread, shown or not (a closed tab keeps its session): that one.
    const open = this.tracker.find((panel) => chatThread(panel.model) === threadId);
    const kept = open ? null : this.#onThread(threadId).find((s) => this.#alive(s));
    const existing = open?.model.name ?? kept?.name;
    if (existing) return this.open({ name: existing, area, focus: true });
    const api = this.core.api;
    if (!api) return null;
    const variants = await api.thread(threadId);
    let session = await this.#live(chatNameFor(threadId));
    // The thread's chat may have moved to another version meanwhile, and be replying there:
    // the thread opens as a chat of its own then.
    let model = this.#alive(session);
    if (model && this.#busy(model)) {
      session = await this.#live(await this.newName());
      model = null;
    }
    const target = session;
    return target.serialize(async () => {
      const shown = this.#alive(target);
      if (shown) {
        // Its model shows another version: it becomes the thread's conversation (its backup and
        // what it shows), or its next save would write that version over the thread's backup.
        if (chatThread(shown) !== threadId) {
          const op = target.begin();
          if (!(await this.#show(target, op, shown, threadId, variants, topic))) return null;
        }
      } else {
        await this.#writeBackup(target, variants, threadId, topic);
      }
      return this.#presenter().open({ name: target.name, area, focus: true });
    });
  }

  /** The session's model, unless there is none or it is disposed. */
  #alive(session: ChatSession): AIChat | null {
    const model = session.model as AIChat | null;
    return model && !model.isDisposed ? model : null;
  }

  /** The chats on a thread: shown or not, by what they show (or showed last). */
  #onThread(threadId: string): ChatSession[] {
    const found: ChatSession[] = [];
    for (const session of this.#sessions.values()) {
      if (session.deleted) continue;
      const model = this.#alive(session);
      if ((model ? chatThread(model) : session.thread) === threadId) found.push(session);
    }
    return found;
  }

  /**
   * A question from elsewhere (the data panel's Ask, the launcher): a new chat, so the
   * conversation in front is never interrupted - unless that one is still blank (no messages,
   * nothing typed or attached), which it then fills instead of leaving behind.
   */
  async ask(input: string, send: boolean, area: ChatArea): Promise<void> {
    const current = this.#presenter().current();
    const blank =
      current?.area === area &&
      current.model.messages.length === 0 &&
      !current.model.input.value.trim() &&
      !(current.model.input.attachments?.length ?? 0);
    if (!blank) {
      await this.newChat({ area, input, send, focus: true });
      return;
    }
    await this.open({ name: current.model.name, area, focus: true, input, send });
  }

  // per chat

  /** What every ClimateClaw chat gets, in either host: once per model, for its lifetime. */
  attach(panel: IChatPanel): void {
    const model = panel.model as AIChat;
    this.#bind(this.#session(model.name), model);
  }

  #bind(session: ChatSession, model: AIChat): void {
    if (this.#bound.has(model)) return;
    this.#bound.add(model);
    session.model = model;
    session.lastHuman = lastHumanId(model);
    session.thread = chatThread(model) ?? session.thread;
    // The session writes the backup: jupyterlite-ai's Save (its toolbar button calls the
    // model's `save`) is the session's; its debounced autosave, which keeps the model's original
    // `save`, writes nothing (see `guardedContents`).
    guardModelSaves(model, guardedContents(this.app.serviceManager.contents, session, true));
    (model as { save: () => Promise<void> }).save = async () => {
      await this.saveNow(model);
    };
    session.loaded = this.#checkLoaded(session, model);
    // An edited question branches the thread on the server (see `edit`). jupyterlite-ai's persona
    // streams its replies through the same hook when it is there: those are applied as they come.
    (model as IChatModel).updateMessage = (id, message) => {
      const target = model.messages.find((m) => m.id === id);
      if (!target) return;
      if (target.sender.bot || message.sender?.bot) {
        target.update(message);
        return;
      }
      return this.edit(model, id, message);
    };
    // Autosave is one setting, the session's, shown by both UIs: the model's flag mirrors it, so
    // jupyterlite-ai's button shows it and toggles it (both ways). A restored backup's choice
    // arrives the same way, unless one was made in this page.
    const onAutosave = () => {
      if (model.autosave === session.autosave) return;
      // jupyterlite-ai's button, or a backup it restored: the chat's setting now.
      this.#setAutosave(session, model, model.autosave);
    };
    const onChange = () => this.#scheduleSave(session, model);
    // A title the user gave stays: jupyterlite-ai's Auto Title (or anything else) never replaces it.
    const onTitle = () => {
      const manual = session.manualTitle;
      if (manual && model.title !== manual && !model.isDisposed) {
        model.title = manual;
        return;
      }
      onChange();
    };
    // The thread's topic, once the server has one, is the chat's title.
    let writing = (model.writers ?? []).some((w) => w.user.bot === true);
    const onWriters = (_: unknown, writers: IChatModel.IWriter[]) => {
      const now = writers.some((w) => w.user.bot === true);
      if (writing && !now) void this.#replyEnded(session, model);
      writing = now;
    };
    // A question sent moves the chat on: an operation started before it is stale.
    const onMessages = () => {
      const thread = chatThread(model);
      if (thread || !model.messages.length) session.thread = thread;
      onChange();
      const human = lastHumanId(model);
      if (human === session.lastHuman) return;
      session.lastHuman = human;
      session.epoch += 1;
    };
    const changes = (model as IChatModel).messageChanged as
      | IChatModel["messageChanged"]
      | undefined;
    model.autosaveChanged?.connect(onAutosave);
    model.writersChanged?.connect(onWriters);
    model.messagesUpdated.connect(onMessages);
    changes?.connect(onChange);
    model.titleChanged?.connect(onTitle);
    // The model shows the chat's setting once it is known (else once its backup is read).
    if (session.autosaveKnown) this.#mirrorAutosave(session, model);
    // For the model's lifetime: a view moved or closed keeps them (another view shows it).
    model.disposed.connect(() => {
      model.autosaveChanged?.disconnect(onAutosave);
      model.writersChanged?.disconnect(onWriters);
      model.messagesUpdated.disconnect(onMessages);
      changes?.disconnect(onChange);
      model.titleChanged?.disconnect(onTitle);
      if (session.model === model) {
        session.model = null;
        session.creating = null;
      }
    });
  }

  #sessionOf(model: IChatModel): ChatSession {
    const session = this.#sessions.get(model.name);
    if (session && session.model === model) return session;
    // A model this controller has not seen yet (or one of a deleted chat): its own session.
    const own = session ?? this.#session(model.name);
    this.#bind(own, model as AIChat);
    return own;
  }

  // the backup

  /** Whether the chat is saved as it changes. */
  autosaves(model: IChatModel): boolean {
    return this.#sessionOf(model).autosave;
  }

  setAutosave(model: AIChat, on: boolean): void {
    this.#setAutosave(this.#sessionOf(model), model, on);
  }

  #setAutosave(session: ChatSession, model: AIChat, on: boolean): void {
    session.autosave = on;
    session.autosaveKnown = true;
    this.#mirrorAutosave(session, model);
    if (on) this.#scheduleSave(session, model);
    else if (session.saveTimer) clearTimeout(session.saveTimer);
  }

  /** jupyterlite-ai's own flag (its button) shows the session's setting. */
  #mirrorAutosave(session: ChatSession, model: AIChat): void {
    if (!model.isDisposed && model.autosave !== session.autosave) model.autosave = session.autosave;
  }

  /** Writes the chat's backup now (the "Save chat" command). */
  async saveNow(model: AIChat): Promise<void> {
    const session = this.#sessionOf(model);
    if (session.saveTimer) clearTimeout(session.saveTimer);
    await this.#save(session, model);
  }

  /**
   * Whether the model holds its backup: it has messages, or there is no backup (a confirmed 404),
   * or the backup is an empty conversation. A backup that is there but did not load (a failed
   * read, a damaged file) is never saved over. The backup's autosave choice is the chat's, unless
   * one was made in this page already (jupyterlite-ai's own autosave stays off, so the model does
   * not carry it).
   */
  async #checkLoaded(session: ChatSession, model: AIChat): Promise<boolean> {
    // jupyterlite-ai's model is ready once it has loaded its backup.
    await (model as { ready?: Promise<unknown> }).ready?.catch(() => undefined);
    const restored = model.messages.length > 0;
    const path = await this.backupPath(session.name);
    let text: unknown;
    try {
      text = (await this.#store(session).get(path, { content: true, type: "file", format: "text" }))
        .content;
    } catch (error) {
      this.#mirrorAutosave(session, model);
      return restored || isNotFound(error);
    }
    let backup: { messages?: unknown[]; metadata?: { autosave?: unknown } };
    try {
      backup = JSON.parse(String(text)) as typeof backup;
    } catch {
      this.#mirrorAutosave(session, model);
      return restored;
    }
    if (!session.autosaveKnown && typeof backup.metadata?.autosave === "boolean") {
      session.autosave = backup.metadata.autosave;
      session.autosaveKnown = true;
    }
    this.#mirrorAutosave(session, model);
    return restored || (Array.isArray(backup.messages) && backup.messages.length === 0);
  }

  /** Whether `model` is the one the chat shows, so the backup is its to write. */
  #owns(session: ChatSession, model: AIChat): boolean {
    return session.model === model && !model.isDisposed && !session.replacing && !session.deleted;
  }

  /** The backup to write from `model` now, or null (an unread backup, an empty new chat). */
  async #snapshot(session: ChatSession, model: AIChat): Promise<string | null> {
    if (!(await session.loaded)) {
      console.warn("ClimateClaw: the chat's backup could not be read, so it is not replaced.");
      return null;
    }
    // A new chat with nothing in it has nothing to keep.
    if (!this.#owns(session, model) || !model.messages.length) return null;
    return JSON.stringify(serializeChat(model, this.#providerOf(model), session.autosave));
  }

  #scheduleSave(session: ChatSession, model: AIChat): void {
    if (!session.autosave || session.deleted || session.model !== model) return;
    if (session.saveTimer) clearTimeout(session.saveTimer);
    session.saveTimer = setTimeout(() => {
      session.saveTimer = null;
      void this.#save(session, model, true).catch((error: unknown) =>
        console.warn("ClimateClaw: the chat was not saved", errorText(error)),
      );
    }, SAVE_DELAY_MS);
  }

  /**
   * One write of the backup, in the session's queue. Its snapshot is taken when its turn comes,
   * from the model the chat shows then - so the last write is the newest conversation, and a
   * model replaced meanwhile (another version) writes nothing. `auto`: a save the chat's autosave
   * asked for, made only if autosave is still on then. True when written.
   */
  async #save(session: ChatSession, model: AIChat, auto = false): Promise<boolean> {
    if (session.deleted) return false;
    if (!(await session.loaded)) {
      console.warn("ClimateClaw: the chat's backup could not be read, so it is not replaced.");
      return false;
    }
    const store = this.#store(session);
    const path = await this.backupPath(session.name);
    await this.#ensureDirectory(store, PathExt.dirname(path));
    const real = this.app.serviceManager.contents;
    return session.write(
      async () => {
        if (auto && !session.autosave) return false;
        const content = await this.#snapshot(session, model);
        if (content === null || !this.#owns(session, model)) return false;
        await real.save(path, { type: "file", format: "text", content });
        return true;
      },
      () => false,
    );
  }

  #providerOf(model: AIChat): string {
    return (
      (model as { agentManager?: { activeProvider?: string } | null }).agentManager
        ?.activeProvider ?? this.providerId()
    );
  }

  /** The backup directory, made only when the store confirms it is not there. */
  async #ensureDirectory(store: Contents, directory: string): Promise<void> {
    if (!directory) return;
    try {
      await store.get(directory, { content: false });
    } catch (error) {
      if (!isNotFound(error)) throw error;
      const made = await store.newUntitled({ type: "directory" });
      await store.rename(made.path, directory);
    }
  }

  async #replyEnded(session: ChatSession, model: AIChat): Promise<void> {
    // The edited question's branch marker has done its work: the reply names the thread now.
    const branched = session.branchMessage;
    session.branchMessage = null;
    const question = branched ? model.messages.find((m) => m.id === branched) : undefined;
    if (question && typeof question.body === "string" && branchOf(question.body)) {
      question.update({ body: stripBranch(question.body) });
    }
    const thread = chatThread(model);
    if (!thread || session.deleted) return;
    session.thread = thread;
    void this.feedback.load(thread, true);
    const pending = session.pendingTopic;
    if (pending) {
      session.pendingTopic = null;
      await this.core.api?.setTopic(thread, pending).catch(() => undefined);
      return;
    }
    // The server may name the thread a moment after the first reply. Its name is applied only
    // if the user gave none meanwhile and the chat is still on that thread.
    const revision = session.titleRevision;
    const still = () =>
      !session.deleted && session.titleRevision === revision && chatThread(model) === thread;
    for (const wait of [0, 4_000]) {
      if (wait) await delay(wait);
      if (!still()) return;
      const topic = await this.#topicOf(thread);
      if (!still()) return;
      if (topic) {
        if (model.title !== topic) this.#retitle(model, thread, topic);
        return;
      }
    }
  }

  async #topicOf(thread: string): Promise<string | null> {
    try {
      const page = await this.core.api?.userThreads(0, 30);
      const topic = page?.threads.find((t) => t.threadId === thread)?.topic ?? "";
      return topic && topic !== "Untitled" ? topic : null;
    } catch {
      return null;
    }
  }

  #retitle(model: AIChat, thread: string | null, title: string): void {
    model.title = title;
    if (thread) void this.notebooks?.rename(thread, title);
  }

  /** The user renames a chat: its title, the thread's topic, and its notebook's name. */
  async rename(model: AIChat, title: string): Promise<void> {
    const clean = title.replace(/\s+/g, " ").trim().slice(0, 120);
    if (!clean || clean === model.title) return;
    const thread = chatThread(model);
    const session = this.#sessionOf(model);
    session.titleRevision += 1;
    session.manualTitle = clean;
    this.#retitle(model, thread, clean);
    if (!thread) {
      session.pendingTopic = clean;
      return;
    }
    try {
      await this.core.api?.setTopic(thread, clean);
    } catch (error) {
      Notification.warning(
        `Renamed here, but ClimateClaw did not take the new name: ${errorText(error)}`,
        { autoClose: 6000 },
      );
    }
  }

  /**
   * Deletes a chat for good: its thread on the server first - a failure there changes nothing
   * here - then, with nothing left to write it, the local backup.
   */
  async delete(model: AIChat): Promise<boolean> {
    const thread = chatThread(model);
    const title = model.title || "this conversation";
    // Taken while the chat shows `model`: once it shows another, asking for the session would
    // bind it back to this one.
    const session = this.#sessionOf(model);
    const answer = await showDialog({
      title: "Delete this conversation?",
      body: thread
        ? `"${title}" is removed from your ClimateClaw history and from this browser. Its notebook stays.`
        : `"${title}" is removed from this browser.`,
      buttons: [Dialog.cancelButton(), Dialog.warnButton({ label: "Delete" })],
    });
    if (!answer.button.accept) return false;
    // The chat may have moved to another version while the dialog was open: what it shows now
    // was not what the user confirmed, and stays (as when deleting from the history).
    const still = () =>
      !session.deleted && this.#alive(session) === model && chatThread(model) === thread;
    const own = still();
    if (!own && !thread) return false;
    if (own) {
      // Nothing more may run in it, and nothing may move it to another version meanwhile.
      model.stopStreaming?.();
      session.deleting = true;
    }
    if (thread) {
      try {
        await this.core.api?.deleteThread(thread);
      } catch (error) {
        if (own) session.deleting = false;
        Notification.error(`The conversation was not deleted: ${errorText(error)}`, {
          autoClose: 8000,
        });
        return false;
      }
    }
    if (own && still()) await this.#discard(session);
    else if (own) session.deleting = false;
    if (thread) this.history?.removed(thread);
    return true;
  }

  /**
   * Removes a chat from this browser. From the first step nothing writes it again (every write
   * checks); the writes already started are waited for; then the backup goes, then the model.
   */
  #discard(session: ChatSession): Promise<void> {
    if (session.deletion) return session.deletion;
    session.deleted = true;
    session.pendingTopic = null;
    if (session.saveTimer) clearTimeout(session.saveTimer);
    const model = session.model as AIChat | null;
    model?.stopStreaming?.();
    if (model) model.autosave = false;
    session.deletion = (async () => {
      if (model) this.presenter?.remove(model);
      await session.drain();
      const path = await this.backupPath(session.name);
      await this.app.serviceManager.contents.delete(path).catch((error: unknown) => {
        if (!isNotFound(error))
          console.warn("ClimateClaw: the chat's backup was not removed", error);
      });
      model?.dispose();
    })().finally(() => {
      // A chat opened under this name later is a new one, with a session of its own.
      if (this.#sessions.get(session.name) === session) this.#sessions.delete(session.name);
    });
    return session.deletion;
  }

  /** The history list as a widget, for a presenter that shows it itself. */
  conversations: ConversationsPanel | null = null;
  /** Shows or hides the history, and says whether it shows (ClimateClaw's own panel). */
  showHistory: ((on: boolean) => void) | null = null;
  historyShown: (() => boolean) | null = null;

  /** The history list, when there is one (its rows follow renames and deletions). */
  history: {
    renamed(threadId: string, topic: string): void;
    removed(threadId: string): void;
  } | null = null;

  /** Renames a stored thread from the history list (and an open chat on it). */
  async renameThread(threadId: string, topic: string): Promise<void> {
    const answer = await InputDialog.getText({
      title: "Rename conversation",
      text: topic,
      okLabel: "Rename",
    });
    const clean = (answer.value ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
    if (!answer.button.accept || !clean || clean === topic) return;
    try {
      await this.core.api?.setTopic(threadId, clean);
    } catch (error) {
      Notification.error(`Not renamed: ${errorText(error)}`, { autoClose: 6000 });
      return;
    }
    this.history?.renamed(threadId, clean);
    for (const session of this.#onThread(threadId)) {
      session.titleRevision += 1;
      session.manualTitle = clean;
      const model = session.model as AIChat | null;
      if (model && !model.isDisposed) this.#retitle(model, threadId, clean);
    }
  }

  /** Deletes a stored thread from the history list (and closes a chat on it). */
  async deleteThread(threadId: string, topic: string): Promise<void> {
    const answer = await showDialog({
      title: "Delete this conversation?",
      body: `"${topic}" is removed from your ClimateClaw history and from this browser. Its notebook stays.`,
      buttons: [Dialog.cancelButton(), Dialog.warnButton({ label: "Delete" })],
    });
    if (!answer.button.accept) return;
    // Every chat on it: shown, closed but kept, and backups no chat has opened since this page
    // loaded (a random name, not the thread's).
    const sessions = new Set<ChatSession>();
    this.tracker.forEach((panel) => {
      if (chatThread(panel.model) === threadId) sessions.add(this.#sessionOf(panel.model));
    });
    for (const session of this.#onThread(threadId)) sessions.add(session);
    // Nothing may move them to another version while the server deletes the thread. Every one
    // marked is let go afterwards - also one that is not deleted after all (it moved to another
    // version while the server deleted), or it could never move again.
    const marked = [...sessions];
    for (const session of marked) {
      session.deleting = true;
      this.#alive(session)?.stopStreaming?.();
    }
    const settle = () => {
      for (const session of marked) if (!session.deleted) session.deleting = false;
    };
    try {
      await this.core.api?.deleteThread(threadId);
    } catch (error) {
      settle();
      Notification.error(`The conversation was not deleted: ${errorText(error)}`, {
        autoClose: 8000,
      });
      return;
    }
    // Only what is still on the thread now goes.
    for (const session of [...sessions]) {
      const model = this.#alive(session);
      if ((model ? chatThread(model) : session.thread) !== threadId) sessions.delete(session);
    }
    // The backup a stored thread is opened from - unless that chat shows another version now.
    const named = this.#session(chatNameFor(threadId));
    const namedModel = this.#alive(named);
    if (!namedModel || chatThread(namedModel) === threadId || !chatThread(namedModel)) {
      sessions.add(named);
    }
    for (const name of await this.#backupsOnThread(threadId)) sessions.add(this.#session(name));
    try {
      await Promise.all([...sessions].map((session) => this.#discard(session)));
    } finally {
      settle();
    }
    this.history?.removed(threadId);
  }

  /** The names of the backups on a thread that no live chat holds (read from their files). */
  async #backupsOnThread(threadId: string): Promise<string[]> {
    const contents = this.app.serviceManager.contents;
    const directory = await this.backupDirectory();
    let listing: { content?: unknown };
    try {
      listing = await contents.get(directory, { content: true });
    } catch {
      return [];
    }
    const names: string[] = [];
    const files = Array.isArray(listing.content)
      ? (listing.content as Array<{ name: string; path: string }>)
      : [];
    for (const file of files) {
      if (!file.name.endsWith(".chat")) continue;
      const name = file.name.slice(0, -".chat".length);
      const session = this.#sessions.get(name);
      if (session && (session.deleted || this.#alive(session))) continue;
      try {
        const read = await contents.get(file.path, { content: true, type: "file", format: "text" });
        if (backupThread(String(read.content ?? "")) === threadId) names.push(name);
      } catch {
        // Unread: left as it is.
      }
    }
    return names;
  }

  // versions

  /**
   * An edited question is a new version: the server branches the thread before it (`/editthread`),
   * the chat shows the branch's history and sends the edited question there - its attachments
   * and mentions too. The original stays one click away ("‹ 1/2 ›"). Only a question the server
   * has stored can be edited.
   */
  async edit(model: AIChat, id: string, message: IMessageContent): Promise<void> {
    const body = typeof message.body === "string" ? stripMarkers(message.body).trim() : "";
    if (!body) return;
    if (this.#busy(model)) {
      Notification.warning("Wait for the reply, or stop it, before editing a message.", {
        autoClose: 5000,
      });
      return;
    }
    const turn = storedTurn(model.messages, id);
    const api = this.core.api;
    if (!turn || !api) {
      Notification.warning(
        "This message cannot be edited: ClimateClaw has not stored its reply. Send it again instead.",
        { autoClose: 6000 },
      );
      return;
    }
    const session = this.#sessionOf(model);
    if (session.deleting) return;
    const op = session.begin();
    try {
      const branch = await api.editThread(turn.thread, turn.index);
      // The version exists on the server either way: it is one click away.
      this.branches.add(turn.thread, turn.index, branch);
      const history = await api.thread(branch);
      const shown = await session.serialize(() => this.#show(session, op, model, branch, history));
      if (!shown) {
        Notification.info(
          "The edited version was made but not shown: the chat moved on meanwhile. ‹ › under the question shows it.",
          { autoClose: 6000 },
        );
        return;
      }
      // A branch with no reply before the edit leaves no marker in the chat: the question names
      // its branch itself, so this request goes there and no other chat's can.
      const marked = chatThread(shown) === branch ? body : `${body}\n${branchMarker(branch)}`;
      const sent = await shown.sendMessage({
        body: marked,
        ...(message.attachments?.length ? { attachments: message.attachments } : {}),
        ...(message.mentions?.length ? { mentions: message.mentions } : {}),
      });
      if (marked !== body && typeof sent === "string") session.branchMessage = sent;
    } catch (error) {
      Notification.error(`The message was not edited: ${errorText(error)}`, { autoClose: 8000 });
    }
  }

  /** Shows another version of the conversation (another thread) in the same chat. */
  async switchTo(model: AIChat, thread: string): Promise<void> {
    if (this.#busy(model) || !this.core.api) return;
    const session = this.#sessionOf(model);
    if (session.deleting) return;
    const op = session.begin();
    try {
      const variants = await this.core.api.thread(thread);
      // Stale when a question was sent (or another version chosen) meanwhile: nothing is shown.
      await session.serialize(() => this.#show(session, op, model, thread, variants));
    } catch (error) {
      Notification.error(`That version could not be shown: ${errorText(error)}`, {
        autoClose: 8000,
      });
    }
  }

  /**
   * The chat becomes `thread`'s conversation - only while `op` is the newest operation on it, no
   * reply runs and it is not being deleted; null when nothing changed. Its backup is written (in
   * the write queue, if still current then), and its model is replaced by one made from it:
   * jupyterlite-ai loads a new model's backup before its persona listens, so the questions it
   * holds are not answered again - which restoring into a live model would do. A version that
   * does not load as written leaves the chat as it was, and says so (throws). One at a time per
   * chat: callers run it in `session.serialize`.
   */
  async #show(
    session: ChatSession,
    op: number,
    model: AIChat,
    thread: string,
    variants: unknown[],
    topic = model.title ?? "",
  ): Promise<AIChat | null> {
    const current = () =>
      session.isCurrent(op) &&
      !session.deleting &&
      session.model === model &&
      !model.isDisposed &&
      !this.#busy(model);
    if (!current()) return null;
    const before = serializeChat(model, this.#providerOf(model), session.autosave);
    const written = await this.#writeBackup(session, variants, thread, topic, true, current);
    if (!written) return null;
    if (!current()) {
      // Overtaken after its backup was written (a question was sent): the chat as it is now.
      await this.#save(session, model);
      return null;
    }
    const view = this.tracker.find((panel) => panel.model === model);
    const area: ChatArea = view?.area === "main" ? "main" : "sidebar";
    // What the user was writing - its text, attachments and mentions - goes to the new model.
    const draft = draftOf(model);
    const replace = async (): Promise<AIChat | null> => {
      const old = this.#alive(session);
      session.replacing = true;
      try {
        if (session.saveTimer) clearTimeout(session.saveTimer);
        const request: OpenRequest = { name: session.name, area, focus: true };
        if (old) await this.#presenter().replace(old, request);
        else await this.#presenter().open(request);
      } finally {
        session.replacing = false;
      }
      const fresh = this.#alive(session);
      if (fresh) restoreDraft(fresh, draft);
      return fresh;
    };
    const fresh = await replace();
    if (!fresh || fresh.messages.length !== written.messages.length) {
      // It did not load as written: the conversation the chat showed comes back.
      await this.#writeRaw(session, before);
      await replace();
      throw new Error("that version could not be loaded here");
    }
    session.lastHuman = lastHumanId(fresh);
    return fresh;
  }

  /** Writes a backup as given, in the session's write queue. */
  async #writeRaw(session: ChatSession, backup: object): Promise<boolean> {
    if (session.deleted) return false;
    const path = await this.backupPath(session.name);
    const real = this.app.serviceManager.contents;
    return session.write(
      async () => {
        await real.save(path, { type: "file", format: "text", content: JSON.stringify(backup) });
        return true;
      },
      () => false,
    );
  }

  /**
   * Writes a chat's backup from a stored thread, in the session's write queue: never once deleted,
   * and - with `current` - only if that still holds when its turn comes. What was written, or null.
   */
  async #writeBackup(
    session: ChatSession,
    variants: unknown[],
    threadId: string,
    topic: string,
    allowEmpty = false,
    current: () => boolean = () => true,
  ): Promise<ExportedChat | null> {
    if (session.deleted) return null;
    const chat = threadToChat(variants, {
      threadId,
      topic,
      provider: this.providerId(),
      hideCode: this.core.hideCode,
      // The chat's own choice: its backup is what a reload adopts.
      autosave: session.autosave,
      allowEmpty,
    });
    const store = this.#store(session);
    const path = await this.backupPath(session.name);
    await this.#ensureDirectory(store, PathExt.dirname(path));
    const real = this.app.serviceManager.contents;
    return session.write(
      async () => {
        if (!current()) return null;
        await real.save(path, { type: "file", format: "text", content: JSON.stringify(chat) });
        return chat;
      },
      () => null,
    );
  }

  #busy(model: AIChat): boolean {
    return model.isBusy === true || (model.writers ?? []).some((w) => w.user.bot === true);
  }

  #presenter(): ChatPresenter {
    if (!this.presenter) throw new Error("ClimateClaw: no chat panel to open chats in.");
    return this.presenter;
  }
}

/** A chat's composer: its text, attachments and mentions. */
interface Draft {
  value: string;
  attachments: IAttachment[];
  mentions: IUser[];
}

function draftOf(model: IChatModel): Draft {
  const input = model.input as Partial<IInputModel> | undefined;
  return {
    value: input?.value ?? "",
    attachments: [...(input?.attachments ?? [])],
    mentions: [...(input?.mentions ?? [])],
  };
}

/** Puts a draft into another model's composer, as it was. */
function restoreDraft(model: IChatModel, draft: Draft): void {
  const input = model.input as Partial<IInputModel> | undefined;
  if (!input) return;
  if (draft.value) input.value = draft.value;
  for (const attachment of draft.attachments) input.addAttachment?.(attachment);
  for (const user of draft.mentions) input.addMention?.(user);
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
