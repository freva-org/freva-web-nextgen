/**
 * ClimateClaw's own chat panel, for the portal's notebook (where jupyterlite-ai's panel plugin is
 * disabled): a header of its own - the chat's title, delete, close; New chat, History, open in a
 * tab, the account - over @jupyter/chat's ChatWidget, with models made by jupyterlite-ai's
 * `IChatModelHandler`. Nothing of jupyterlite-ai is replaced but its panel: the chat model, its
 * agent, saving and restoring, the input and its toolbar are jupyterlite-ai's.
 *
 * A chat moves between this panel and the main area as the same model instance.
 */

import type { JupyterFrontEnd } from "@jupyterlab/application";
import {
  MainAreaWidget,
  Notification,
  type IThemeManager,
  type WidgetTracker,
} from "@jupyterlab/apputils";
import type { IRenderMimeRegistry } from "@jupyterlab/rendermime";
import {
  addIcon,
  caretLeftIcon,
  closeIcon,
  deleteIcon,
  ellipsesIcon,
  launchIcon,
  type LabIcon,
} from "@jupyterlab/ui-components";
import {
  AttachmentOpenerRegistry,
  ChatWidget,
  type IChatBodyPlaceholderFactory,
  type IChatCommandRegistry,
  type IChatModel,
  type IChatPanel,
  type IInputToolbarRegistryFactory,
  type IMessageFooterRegistry,
} from "@jupyter/chat";
import type { IChatModelHandler } from "@jupyterlite/ai";
import { CommandRegistry } from "@lumino/commands";
import type { Message } from "@lumino/messaging";
import { Signal } from "@lumino/signaling";
import { Menu, Panel, Widget } from "@lumino/widgets";

import type { AIChat, ChatArea, ChatController, ChatPresenter, OpenRequest } from "./chats.js";
import { errorText, replaceChat } from "./chats.js";
import type { IClimateClaw } from "./core.js";
import type { ConversationsPanel } from "./conversations.js";
import { historyIcon } from "./icons.js";
import { avatarText, shortName } from "./identity.js";
import { SIGN_IN_MARKER } from "./model.js";
import { chipCellId } from "./notebook-sink.js";
import { CODE_CLASS } from "./run-card.js";
import { button, el, openPopover } from "./popover.js";
import { chatThread } from "./reply-actions.js";
import { chatTranslator } from "./chat-text.js";
import { signInLeadsToNewChat, watchStop } from "./chat-views.js";
import { LOGO_DATA_URL } from "./logo.js";

export const PANEL_ID = "climateclaw-chat-panel";
/** Where this browser keeps the name of the last chat shown (reopened on the next visit). */
export const LAST_CHAT_KEY = "climateclaw:last-chat";

/** `jp-mod-empty` on a chat's view while it has no messages: its composer sits in the middle. */
function watchEmpty(widget: ChatWidget, host: Widget): () => void {
  const model = widget.model;
  const update = () => host.toggleClass("jp-mod-empty", model.messages.length === 0);
  model.messagesUpdated.connect(update);
  update();
  return () => model.messagesUpdated.disconnect(update);
}

function displayTitle(model: IChatModel): string {
  return (model as AIChat).title?.trim() || "New chat";
}

/** How long the "Signed in as" note stays. */
const SIGNED_IN_NOTE_MS = 4_000;

const PERSON_SVG =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><circle cx="12" cy="8.5" r="4"/><path d="M4.5 20c.9-4 3.9-6 7.5-6s6.6 2 7.5 6z"/></svg>';

/** The account's avatar: initials, or a person for an account id; a dot says it is signed in. */
function avatar(fullName: string | null | undefined, username: string | null | undefined) {
  const text = avatarText(fullName, username);
  const node = el("span", "jp-ClimateClaw-avatar", text ?? "");
  if (text === null) node.innerHTML = PERSON_SVG;
  return node;
}

/** A chat in the side panel. */
export class SideChat extends Panel implements IChatPanel {
  readonly area = "sidebar" as const;
  /** The panel's header is the chat's toolbar; this one is never shown. */
  readonly toolbar = new Widget();
  readonly #unwatch: () => void;

  constructor(readonly widget: ChatWidget) {
    super();
    this.addClass("jp-ClimateClaw-sideChat");
    this.id = `climateclaw-chat-${Math.random().toString(36).slice(2, 10)}`;
    this.title.label = widget.model.name;
    this.addWidget(widget);
    const unwatchStop = watchStop(widget);
    const unwatchEmpty = watchEmpty(widget, this);
    this.#unwatch = () => {
      unwatchStop();
      unwatchEmpty();
    };
  }

  get model(): IChatModel {
    return this.widget.model;
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.#unwatch();
    // The model is not disposed with its view: it may move, or be deleted by its owner.
    super.dispose();
  }
}

/** A chat in its own tab in the main area. */
export class MainChat extends MainAreaWidget<ChatWidget> implements IChatPanel {
  readonly #unwatch: () => void;

  constructor(widget: ChatWidget) {
    super({ content: widget });
    this.addClass("jp-ClimateClaw-mainChat");
    this.id = `climateclaw-main-${Math.random().toString(36).slice(2, 10)}`;
    this.title.closable = true;
    const unwatchStop = watchStop(widget);
    const unwatchEmpty = watchEmpty(widget, this);
    this.#unwatch = () => {
      unwatchStop();
      unwatchEmpty();
    };
    const model = widget.model as AIChat;
    const retitle = () => {
      this.title.label = displayTitle(model);
      this.title.caption = `ClimateClaw: ${displayTitle(model)}`;
    };
    model.titleChanged?.connect(retitle);
    this.disposed.connect(() => model.titleChanged?.disconnect(retitle));
    retitle();
  }

  get model(): IChatModel {
    return this.content.model;
  }
  get widget(): ChatWidget {
    return this.content;
  }
  get area(): "main" {
    return "main";
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.#unwatch();
    super.dispose();
  }
}

export interface ChatsPanelOptions {
  app: JupyterFrontEnd;
  core: IClimateClaw;
  controller: ChatController;
  /** Every chat view (the IChatTracker this extension provides), and the main-area ones. */
  tracker: WidgetTracker<IChatPanel>;
  mainTracker: WidgetTracker<MainChat>;
  handler: IChatModelHandler;
  rmRegistry: IRenderMimeRegistry;
  inputToolbarFactory: IInputToolbarRegistryFactory;
  chatCommands: IChatCommandRegistry | null;
  themeManager: IThemeManager | null;
  footers: IMessageFooterRegistry;
  placeholder: IChatBodyPlaceholderFactory;
  history: ConversationsPanel | null;
  /** The commands of the account card and the header. */
  commands: { signIn: string; signOut: string };
  logoUrl: string;
  close: () => void;
}

type View = "welcome" | "chat" | "history";

function iconButton(icon: LabIcon, className: string, label: string, onClick: () => void) {
  const node = button(`jp-ClimateClaw-headerButton ${className}`, label, onClick);
  const glyph = el("span", "jp-ClimateClaw-headerIcon");
  icon.element({ container: glyph });
  node.append(glyph);
  return node;
}

function labelled(node: HTMLButtonElement, text: string): HTMLButtonElement {
  node.append(el("span", "jp-ClimateClaw-headerLabel", text));
  return node;
}

export class ChatsPanel extends Panel implements ChatPresenter {
  readonly #body = new Panel();
  readonly #welcome = new Widget();
  readonly #chats: SideChat[] = [];
  #current: SideChat | null = null;
  #view: View = "welcome";
  readonly #openers = new AttachmentOpenerRegistry();
  readonly #title = el("button", "jp-ClimateClaw-chatTitle");
  readonly #deleteButton: HTMLButtonElement;
  readonly #tabButton: HTMLButtonElement;
  readonly #historyButton: HTMLButtonElement;
  readonly #back: HTMLButtonElement;
  readonly #close: HTMLButtonElement;
  #actions: HTMLElement | null = null;
  readonly #account = el("button", "jp-ClimateClaw-account");
  #signedInNote: HTMLElement | null = null;
  /** A new chat is being opened in place of the welcome. */
  #startingNew = false;
  /**
   * Transitions under way - a model replaced, a chat moved to a tab: the old views go without
   * leaving an empty state behind, and no chat is made then (see `#settle`).
   */
  #transitions = 0;
  /** A sign-in asked for by a reply: that chat's question comes back when it completes. */
  #signInFor: AIChat | null = null;
  /** A sign-in started from the first page: a new chat opens when it completes. */
  #signInFromWelcome = false;
  readonly currentChanged = new Signal<ChatsPanel, IChatPanel | null>(this);

  constructor(private readonly options: ChatsPanelOptions) {
    super();
    this.id = PANEL_ID;
    this.addClass("jp-ClimateClaw-panel");
    this.title.caption = "ClimateClaw";
    const { app, core, controller } = options;
    controller.presenter = this;

    this.#openers.set("file", (attachment) => {
      void app.commands.execute("docmanager:open", { path: attachment.value });
    });
    this.#openers.set("notebook", (attachment) => {
      void app.commands.execute("docmanager:open", { path: attachment.value });
    });

    // header, row 1: the chat's title (click to rename), delete, close
    const row1 = el("div", "jp-ClimateClaw-headerRow jp-mod-title");
    this.#title.type = "button";
    this.#title.addEventListener("click", () => this.#startRename());
    this.#deleteButton = iconButton(deleteIcon, "jp-mod-delete", "Delete this conversation", () => {
      const model = this.#current?.model as AIChat | undefined;
      if (model) void controller.delete(model);
    });
    // In History: a way back on the left, and × closes History (not the panel).
    this.#back = labelled(
      iconButton(caretLeftIcon, "jp-mod-back", "Back to the chat", () => this.showHistory(false)),
      "Back",
    );
    this.#close = iconButton(closeIcon, "jp-mod-close", "Close the ClimateClaw panel", () =>
      this.#view === "history" ? this.showHistory(false) : options.close(),
    );
    row1.append(this.#back, this.#title, this.#deleteButton, this.#close);

    // row 2: New chat, History | open in a tab, account, more
    const row2 = el("div", "jp-ClimateClaw-headerRow jp-mod-actions");
    const left = el("div", "jp-ClimateClaw-headerGroup");
    const newChat = labelled(
      iconButton(addIcon, "jp-mod-new", "New chat", () => void this.#newChat()),
      "New chat",
    );
    this.#historyButton = labelled(
      iconButton(historyIcon, "jp-mod-history", "Your conversations", () =>
        this.#view === "history"
          ? this.#current
            ? this.#setView("chat")
            : this.#showEmpty()
          : this.#setView("history"),
      ),
      "History",
    );
    this.#historyButton.hidden = !options.history;
    left.append(newChat, this.#historyButton);
    const right = el("div", "jp-ClimateClaw-headerGroup");
    this.#tabButton = iconButton(launchIcon, "jp-mod-tab", "Open this chat in a tab", () => {
      const model = this.#current?.model;
      if (model) void controller.open({ name: model.name, area: "main", focus: true });
    });
    this.#account.type = "button";
    this.#account.addEventListener("click", () => this.#accountClicked());
    const more = iconButton(ellipsesIcon, "jp-mod-more", "More", () => this.#moreMenu(more));
    more.setAttribute("aria-haspopup", "menu");
    right.append(this.#tabButton, this.#account, more);
    row2.append(left, right);
    this.#actions = row2;

    const header = new Widget({ node: el("div", "jp-ClimateClaw-panelHeader") });
    header.node.append(row1, row2);

    this.#body.addClass("jp-ClimateClaw-panelBody");
    this.#buildWelcome();
    this.#body.addWidget(this.#welcome);
    if (options.history) {
      options.history.addClass("jp-mod-embedded");
      options.history.hide();
      this.#body.addWidget(options.history);
    }
    this.addWidget(header);
    this.addWidget(this.#body);
    this.node.addEventListener("click", (event) => this.#onClick(event));
    this.#followHideCode();

    const newChatAfter = signInLeadsToNewChat(!!core.auth?.signedIn);
    let wasSignedIn = !!core.auth?.signedIn;
    core.auth?.changed.connect(() => {
      const signedIn = !!core.auth?.signedIn;
      const view = this.#view;
      this.#update();
      if (signedIn && !wasSignedIn) this.#saySignedIn();
      wasSignedIn = signedIn;
      if (signedIn && this.#signInFor) {
        this.#refill(this.#signInFor);
        this.#signInFor = null;
      }
      // A sign-in from anywhere leads to a new chat, not back to the welcome.
      if (newChatAfter({ signedIn, view, fromWelcome: this.#signInFromWelcome })) {
        this.#signInFromWelcome = false;
        this.#startNew();
      }
    });
    this.#update();
  }

  // ChatPresenter

  current(): IChatPanel | null {
    const shell = this.options.app.shell;
    const main = this.options.mainTracker.currentWidget;
    if (main && shell.currentWidget === main) return main;
    return this.#current;
  }

  async open(request: OpenRequest): Promise<IChatPanel | null> {
    const { tracker } = this.options;
    let panel = tracker.find((p) => p.model.name === request.name) ?? null;
    // One model per chat: the controller's session makes it, once.
    const model =
      (panel?.model as AIChat | undefined) ??
      (await this.options.controller.model(request.name, async () => {
        const made = this.options.handler.createModel({
          name: request.name,
          activeProvider: this.options.controller.providerId(),
        }) as unknown as AIChat;
        // Restored from its backup, if it has one, before it is ready (and before its persona
        // listens). ClimateClaw's controller saves it as it changes.
        await made.ready;
        return made;
      }));
    panel = tracker.find((p) => p.model.name === request.name) ?? panel;
    if (!panel || panel.area !== request.area) {
      // A move (the side panel's chat into a tab, or back): its old view goes as a transition.
      if (panel) {
        this.#transitions += 1;
        try {
          panel.dispose();
        } finally {
          this.#transitions -= 1;
        }
      }
      panel = request.area === "main" ? this.#addMain(model) : this.#addSide(model);
      if (request.area === "main") this.#settle();
    }
    if (panel instanceof SideChat) this.#show(panel);
    if (request.focus !== false) this.options.app.shell.activateById(panel.id);
    if (request.area === "sidebar" && request.focus !== false) {
      this.options.app.shell.activateById(this.id);
    }
    if (typeof request.input === "string") {
      model.input.value = request.input;
      if (request.send && request.input) model.input.send(request.input);
    }
    if (request.focus !== false) model.input.focus();
    this.#remember(model.name);
    return panel;
  }

  closeChat(model: IChatModel): void {
    for (const chat of [...this.#chats]) if (chat.model === model) this.#removeSide(chat);
    this.options.mainTracker.forEach((main) => {
      if (main.model === model) main.dispose();
    });
  }

  /** Its views; its model is held nowhere else here (the controller's session lets go of it). */
  remove(model: IChatModel): void {
    this.closeChat(model);
  }

  /**
   * One presentation step: while the old model's views go and the new one opens, nothing else is
   * shown (no other chat, no welcome) and no chat is made. A replacement that showed nothing
   * leaves the welcome.
   */
  async replace(old: IChatModel, request: OpenRequest): Promise<IChatModel | null> {
    this.#transitions += 1;
    try {
      return await replaceChat(this, old, request);
    } finally {
      this.#transitions -= 1;
      this.#settle();
    }
  }

  /** Reopens the last chat of this browser, or shows the first page. */
  async restoreLast(): Promise<void> {
    let name: string | null = null;
    try {
      name = window.localStorage.getItem(LAST_CHAT_KEY);
    } catch {
      name = null;
    }
    if (name && this.options.tracker.find((p) => p.model.name === name)) return this.#update();
    const path = name ? await this.options.controller.backupPath(name) : null;
    const saved =
      path !== null &&
      (await this.options.app.serviceManager.contents.get(path, { content: false }).then(
        () => true,
        () => false,
      ));
    if (saved) await this.options.controller.open({ name: name!, area: "sidebar", focus: false });
    else if (!this.#current) this.#showEmpty();
    else this.#update();
  }

  /** The history list's view, shown in this panel. */
  showHistory(on = true): void {
    if (on) this.#setView("history");
    else if (this.#current) this.#setView("chat");
    else this.#showEmpty();
  }

  get historyShown(): boolean {
    return this.#view === "history" && this.isVisible;
  }

  // lumino

  protected onActivateRequest(msg: Message): void {
    super.onActivateRequest(msg);
    if (this.#view === "chat") this.#current?.model.input.focus();
  }

  // chats

  #widget(model: IChatModel, area: ChatArea): ChatWidget {
    const o = this.options;
    const registry = o.inputToolbarFactory.create();
    // No "clear": a conversation is deleted from the header, or a new one started.
    registry.hide("clear");
    return new ChatWidget({
      model,
      rmRegistry: o.rmRegistry,
      themeManager: o.themeManager,
      inputToolbarRegistry: registry,
      attachmentOpenerRegistry: this.#openers,
      ...(o.chatCommands ? { chatCommandRegistry: o.chatCommands } : {}),
      messageFooterRegistry: o.footers,
      chatBodyPlaceholderFactory: o.placeholder,
      area,
      // ClimateClaw's placeholder in the input (no "@ to mention": nobody is mentioned here).
      translator: chatTranslator(),
    });
  }

  #addSide(model: IChatModel): SideChat {
    const chat = new SideChat(this.#widget(model, "sidebar"));
    chat.hide();
    this.#chats.push(chat);
    this.#body.addWidget(chat);
    void this.options.tracker.add(chat);
    const retitle = () => this.#update();
    (model as AIChat).titleChanged?.connect(retitle);
    chat.disposed.connect(() => {
      (model as AIChat).titleChanged?.disconnect(retitle);
      const at = this.#chats.indexOf(chat);
      if (at >= 0) this.#chats.splice(at, 1);
      if (this.#current === chat) {
        this.#current = null;
        // Replaced or moved: what shows next is the transition's (see `#settle`).
        if (this.#transitions > 0) return;
        const next = this.#chats[this.#chats.length - 1];
        if (next) this.#show(next);
        else this.#showEmpty();
      }
    });
    return chat;
  }

  #removeSide(chat: SideChat): void {
    chat.dispose();
  }

  #addMain(model: IChatModel): MainChat {
    const main = new MainChat(this.#widget(model, "main"));
    this.options.app.shell.add(main, "main");
    void this.options.tracker.add(main);
    void this.options.mainTracker.add(main);
    return main;
  }

  #show(chat: SideChat): void {
    this.#current = chat;
    for (const other of this.#chats) other.setHidden(other !== chat || this.#view === "history");
    this.#setView("chat");
    this.currentChanged.emit(chat);
  }

  #remember(name: string): void {
    try {
      window.localStorage.setItem(LAST_CHAT_KEY, name);
    } catch {
      // Not kept: the next visit starts on the first page.
    }
  }

  async #newChat(): Promise<void> {
    try {
      await this.options.controller.newChat({ area: "sidebar", focus: true });
    } catch (error) {
      console.warn("ClimateClaw: no new chat", errorText(error));
    }
  }

  // views and header

  /**
   * No chat to show, after the user's own step (the last chat closed or deleted, back from the
   * history, a first visit): signed in, a new chat's own page (its greeting and examples, made
   * once); signed out, the welcome. Never from a view change alone (see `#setView`).
   */
  #showEmpty(): void {
    this.#setView("welcome");
    if (this.options.core.auth?.signedIn) this.#startNew();
  }

  /**
   * After a transition, when the side panel shows no chat: its latest other chat, else the
   * welcome. Never a new chat: the user asked for none (the moved chat is in its tab).
   */
  #settle(): void {
    if (this.#transitions > 0 || this.#current) return;
    const next = this.#chats[this.#chats.length - 1];
    if (next) this.#show(next);
    else if (this.#view === "chat") this.#setView("welcome");
  }

  /** A new chat, once at a time (a sign-in and an emptied panel at once make one). */
  #startNew(): void {
    if (this.#startingNew) return;
    this.#startingNew = true;
    void this.#newChat().finally(() => (this.#startingNew = false));
  }

  /** Shows a view; nothing else (no chat is made or opened here). */
  #setView(view: View): void {
    this.#view = view === "chat" && !this.#current ? "welcome" : view;
    this.#welcome.setHidden(this.#view !== "welcome");
    for (const chat of this.#chats) {
      chat.setHidden(this.#view !== "chat" || chat !== this.#current);
    }
    const history = this.options.history;
    if (history) {
      if (this.#view === "history") {
        history.show();
        history.invalidate();
        // Focus stays in the panel (the header's buttons hide): search, and Escape, work at once.
        history.node.querySelector<HTMLInputElement>("input[type=search]")?.focus();
      } else history.hide();
    }
    this.#update();
  }

  #update(): void {
    const model = this.#view === "chat" ? (this.#current?.model ?? null) : null;
    const title =
      this.#view === "history" ? "History" : model ? displayTitle(model) : "ClimateClaw";
    const history = this.#view === "history";
    this.#title.textContent = title;
    this.#title.disabled = !model;
    this.#title.title = model ? `${title} (click to rename)` : title;
    this.#back.hidden = !history;
    this.#deleteButton.hidden = history;
    if (this.#actions) this.#actions.hidden = history;
    const closeLabel = history ? "Close History" : "Close the ClimateClaw panel";
    this.#close.title = closeLabel;
    this.#close.setAttribute("aria-label", closeLabel);
    this.#deleteButton.disabled = !model;
    this.#tabButton.disabled = !model;
    this.#historyButton.setAttribute("aria-pressed", String(this.#view === "history"));
    this.node.dataset.view = this.#view;
    this.#renderAccount();
    this.#renderWelcome();
  }

  #startRename(): void {
    const model = this.#current?.model as AIChat | undefined;
    if (!model || this.#view !== "chat") return;
    const input = el("input", "jp-ClimateClaw-chatTitleInput");
    input.value = displayTitle(model);
    input.setAttribute("aria-label", "Conversation name");
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      input.replaceWith(this.#title);
      if (save && input.value.trim()) void this.options.controller.rename(model, input.value);
      this.#update();
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") finish(true);
      else if (event.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
    this.#title.replaceWith(input);
    input.focus();
    input.select();
  }

  #renderAccount(): void {
    const auth = this.options.core.auth;
    const node = this.#account;
    node.hidden = !auth;
    node.replaceChildren();
    if (!auth) return;
    if (!auth.signedIn) {
      node.className = "jp-ClimateClaw-account jp-mod-signedOut";
      node.textContent = "Sign in";
      node.title = "Sign in with Freva in a popup window";
      node.setAttribute("aria-label", node.title);
      node.removeAttribute("aria-haspopup");
      return;
    }
    const profile = auth.profile;
    const name = profile?.fullName || profile?.username || "Freva user";
    node.className = "jp-ClimateClaw-account jp-mod-signedIn";
    node.append(avatar(profile?.fullName, profile?.username ?? auth.username));
    node.title = `Signed in as ${name}`;
    node.setAttribute("aria-label", `${node.title}: your Freva account`);
    node.setAttribute("aria-haspopup", "dialog");
  }

  /** A short note that the user is signed in now, which goes by itself. */
  #saySignedIn(): void {
    const auth = this.options.core.auth;
    if (!auth?.signedIn) return;
    this.#signedInNote?.remove();
    const note = el(
      "div",
      "jp-ClimateClaw-signedInNote",
      `Signed in as ${shortName(auth.profile?.fullName, auth.profile?.username ?? auth.username)}`,
    );
    note.setAttribute("role", "status");
    this.#signedInNote = note;
    this.#body.node.append(note);
    setTimeout(() => note.classList.add("jp-mod-leaving"), SIGNED_IN_NOTE_MS);
    setTimeout(() => note.remove(), SIGNED_IN_NOTE_MS + 400);
  }

  #accountClicked(): void {
    const auth = this.options.core.auth;
    if (!auth) return;
    // Synchronous: the popup must open inside the click.
    if (!auth.signedIn) return auth.login();
    const profile = auth.profile;
    const username = profile?.username || "Freva user";
    const card = el("div", "jp-ClimateClaw-accountCard");
    const head = el("div", "jp-ClimateClaw-accountHead");
    const big = avatar(profile?.fullName, username);
    big.classList.add("jp-mod-large");
    head.append(big);
    // The username first, then - small - the person's name and e-mail.
    const who = el("div", "jp-ClimateClaw-accountWho");
    who.append(el("strong", undefined, username));
    if (profile?.fullName && profile.fullName !== username) {
      who.append(el("span", "jp-ClimateClaw-accountName", profile.fullName));
    }
    if (profile?.email && profile.email !== username)
      who.append(el("span", undefined, profile.email));
    head.append(who);
    const note = el("p", "jp-ClimateClaw-accountNote", `Signed in with Freva at ${auth.host}`);
    const signOut = el("button", "jp-ClimateClaw-signOut", "Sign out");
    signOut.type = "button";
    card.append(head, note, signOut);
    const popover = openPopover(this.#account, card, {
      label: "Your Freva account",
      className: "jp-ClimateClaw-accountPopover",
      align: "end",
    });
    // Synchronous too: the end-session window opens inside this click.
    signOut.addEventListener("click", () => {
      popover.close();
      void this.options.app.commands.execute(this.options.commands.signOut);
    });
    signOut.focus();
  }

  #moreMenu(anchor: HTMLElement): void {
    const model = this.#current?.model as AIChat | undefined;
    const commands = new CommandRegistry();
    const { controller } = this.options;
    commands.addCommand("save", {
      label: "Save chat now",
      isEnabled: () => !!model,
      execute: () =>
        model &&
        controller
          .saveNow(model)
          .catch((error: unknown) => console.warn("ClimateClaw: not saved", errorText(error))),
    });
    commands.addCommand("autosave", {
      label: "Save automatically",
      isEnabled: () => !!model,
      isToggled: () => !!model && controller.autosaves(model),
      execute: () => {
        if (model) controller.setAutosave(model, !controller.autosaves(model));
      },
    });
    const menu = new Menu({ commands });
    menu.addClass("jp-ClimateClaw-moreMenu");
    menu.addItem({ command: "save" });
    menu.addItem({ command: "autosave" });
    menu.aboutToClose.connect(() => queueMicrotask(() => menu.dispose()));
    const rect = anchor.getBoundingClientRect();
    menu.open(rect.right, rect.bottom, { horizontalAlignment: "right" });
  }

  #buildWelcome(): void {
    this.#welcome.addClass("jp-ClimateClaw-welcome");
  }

  #renderWelcome(): void {
    if (this.#view !== "welcome") return;
    const { core, logoUrl } = this.options;
    const auth = core.auth;
    const signedIn = !!auth?.signedIn;
    const node = this.#welcome.node;
    node.replaceChildren();
    const logo = el("img", "jp-ClimateClaw-welcomeLogo");
    logo.src = logoUrl;
    logo.alt = "";
    logo.addEventListener("error", () => (logo.src = LOGO_DATA_URL), { once: true });
    const pitch = el(
      "p",
      "jp-ClimateClaw-pitch",
      "Let's explore the data and build your analysis together.",
    );
    const actions = el("div", "jp-ClimateClaw-welcomeActions");
    const start = el(
      "button",
      `jp-ClimateClaw-welcomeNew${signedIn ? " jp-mod-primary" : ""}`,
      "New chat",
    );
    start.type = "button";
    start.addEventListener("click", () => void this.#newChat());
    actions.append(start);
    if (auth && !signedIn) {
      const signIn = el("button", "jp-ClimateClaw-welcomeSignIn jp-mod-primary");
      signIn.type = "button";
      signIn.append(
        el("span", "jp-ClimateClaw-finger", "👉"),
        el("span", undefined, "Sign in with Freva"),
      );
      // Synchronous: the popup opens inside the click.
      signIn.addEventListener("click", () => {
        this.#signInFromWelcome = true;
        auth.login();
      });
      actions.append(signIn);
    }
    node.append(logo, el("h2", "jp-ClimateClaw-welcomeTitle", "ClimateClaw"), pitch, actions);
    const register = core.config.registerUrl;
    if (auth && !signedIn && register) {
      // One line: what is needed, and where to get it.
      const link = el("a", "jp-ClimateClaw-register", "No DKRZ account? Register ↗");
      link.href = register;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.title = "Freva signs you in with a DKRZ account; registering opens DKRZ's user portal.";
      node.append(link);
    }
  }

  /** After a sign-in a reply asked for: the reply says so, the question is back in the box. */
  #refill(model: AIChat): void {
    const messages = model.messages;
    let at = messages.length - 1;
    while (at >= 0) {
      const m = messages[at]!;
      if (m.sender.bot === true && typeof m.body === "string" && m.body.includes(SIGN_IN_MARKER)) {
        break;
      }
      at -= 1;
    }
    if (at < 0) return;
    const question = [...messages.slice(0, at)].reverse().find((m) => !m.sender.bot);
    messages[at]!.update({
      body: `${SIGN_IN_MARKER}\n_Signed in. Your question is back in the box below: send it when you are ready._`,
    });
    if (typeof question?.body === "string" && !model.input.value.trim()) {
      model.input.value = question.body;
    }
    model.input.focus();
  }

  /**
   * Hide code, in this panel: every run's code folds under its card's line or shows - the cards
   * already shown and the ones rendered later. Outputs, errors and figures always show.
   */
  #followHideCode(): void {
    const { core } = this.options;
    const selector = `details.${CODE_CLASS}`;
    const apply = (cards: Iterable<Element>) => {
      for (const code of cards) (code as HTMLDetailsElement).open = !core.hideCode;
    };
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (node.matches(selector)) apply([node]);
          else apply(node.querySelectorAll(selector));
        }
      }
    }).observe(this.node, { childList: true, subtree: true });
    let hidden = core.hideCode;
    core.changed.connect(() => {
      if (core.hideCode === hidden) return;
      hidden = core.hideCode;
      apply(this.node.querySelectorAll(selector));
    });
  }

  /** Clicks inside this panel: a sign-in link signs in, a DKRZ chip jumps to its cell. */
  #onClick(event: MouseEvent): void {
    const signIn = (event.target as HTMLElement | null)?.closest?.(".jp-ClimateClaw-signInLink");
    if (signIn && this.node.contains(signIn)) {
      event.preventDefault();
      // The chat it was asked in gets its question back once signed in.
      this.#signInFor = (this.#current?.model as AIChat | undefined) ?? null;
      // Synchronous: the popup opens inside this click.
      this.options.core.auth?.login();
      return;
    }
    const chip = (event.target as HTMLElement | null)?.closest?.(".jp-ClimateClaw-ran");
    if (!chip || !this.node.contains(chip)) return;
    const cellId = chipCellId(chip.classList);
    if (!cellId) return;
    event.preventDefault();
    void this.#jump(cellId);
  }

  async #jump(cellId: string): Promise<void> {
    const notebooks = this.options.controller.notebooks;
    if (!notebooks) return;
    let found = notebooks.findCell(cellId);
    const thread = this.#current ? chatThread(this.#current.model) : null;
    if (!found && thread) {
      // Its notebook was closed: reopened (never made anew), then the cell is found by its id.
      await notebooks.reopen(thread).catch(() => null);
      found = notebooks.findCell(cellId);
    }
    if (found) notebooks.reveal(found.panel, found.index);
    else Notification.info("That cell is no longer in its notebook.", { autoClose: 4000 });
  }
}
