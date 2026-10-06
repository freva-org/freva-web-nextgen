// The Conversations drawer: the user's ClimateClaw threads, in the right sidebar or embedded in
// ClimateClaw's own panel (never a dialog), with search, Today / Yesterday / Earlier, a menu per
// conversation, "Show more" and "New chat". Built with DOM APIs and textContent; nothing here
// touches the chat panel.

import type { CommandRegistry } from "@lumino/commands";
import type { Message } from "@lumino/messaging";
import { Menu, Widget } from "@lumino/widgets";

import type { StoredThreadSummary } from "./api.js";
import { AccountThreads, filterThreads, groupThreads, threadTime } from "./conversations-model.js";
import { conversationIcon, historyIcon, moreIcon } from "./icons.js";

export const CONVERSATIONS_ID = "climateclaw-conversations";

export interface ConversationsOptions {
  commands: CommandRegistry;
  /** Command opening a thread (args: threadId, topic, area). */
  openCommand: string;
  /** Command starting a new ClimateClaw chat. */
  newChatCommand: string;
  /** Commands renaming and deleting a thread (args: threadId, topic). */
  renameCommand?: string;
  deleteCommand?: string;
  signedIn: () => boolean;
  signIn: () => void;
  /** Loads a page of the user's threads. */
  load: (page: number, size: number) => Promise<{ threads: StoredThreadSummary[]; total: number }>;
  /** The thread of the chat in front, to highlight. */
  currentThread: () => string | null;
  close: () => void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class ConversationsPanel extends Widget {
  readonly #threads: AccountThreads;
  readonly #search = el("input", "jp-ClimateClaw-conversations-search");
  readonly #status = el("p", "jp-ClimateClaw-conversations-status");
  readonly #list = el("div", "jp-ClimateClaw-conversations-list");
  readonly #more = el("button", "jp-ClimateClaw-conversations-more", "Show more");
  readonly #signIn = el("div", "jp-ClimateClaw-conversations-signin");
  /** A thin bar at the top while a load runs: the list never moves for it. */
  readonly #loading = el("div", "jp-ClimateClaw-conversations-loading");
  #stale = true;

  constructor(private readonly options: ConversationsOptions) {
    super();
    this.id = CONVERSATIONS_ID;
    this.addClass("jp-ClimateClaw-conversations");
    this.title.icon = historyIcon;
    this.title.caption = "ClimateClaw conversations";
    this.#threads = new AccountThreads(options.load, () => this.#render());

    const header = el("div", "jp-ClimateClaw-conversations-header");
    const title = el("h2", "jp-ClimateClaw-conversations-title", "Conversations");
    const close = el("button", "jp-ClimateClaw-conversations-close", "×");
    close.type = "button";
    close.title = "Close conversations";
    close.setAttribute("aria-label", "Close conversations");
    close.addEventListener("click", () => options.close());
    header.append(title, close);

    const newChat = el("button", "jp-ClimateClaw-conversations-new jp-mod-styled jp-mod-accept");
    newChat.type = "button";
    newChat.textContent = "+ New chat";
    newChat.addEventListener("click", () => void options.commands.execute(options.newChatCommand));

    this.#search.type = "search";
    this.#search.placeholder = "Search conversations…";
    this.#search.setAttribute("aria-label", "Search conversations");
    this.#search.addEventListener("input", () => this.#render());

    this.#status.setAttribute("role", "status");
    this.#more.type = "button";
    this.#more.addEventListener("click", () => this.#load(false));

    const prompt = el("p", undefined, "Sign in with Freva to see your conversations.");
    const button = el("button", "jp-mod-styled jp-mod-accept", "Sign in with Freva");
    button.type = "button";
    // Synchronous: the sign-in popup must open inside the click.
    button.addEventListener("click", () => options.signIn());
    this.#signIn.append(prompt, button);

    this.#loading.setAttribute("role", "progressbar");
    this.#loading.setAttribute("aria-label", "Loading conversations");
    this.#loading.hidden = true;
    this.node.append(
      header,
      newChat,
      this.#search,
      this.#loading,
      this.#signIn,
      this.#status,
      this.#list,
      this.#more,
    );
    this.#render();
  }

  /** Signed in as someone else, or signed out: a new list, never the previous account's. */
  accountChanged(): void {
    this.#threads.reset();
    this.invalidate();
  }

  /** The list is out of date (a new conversation): reloaded now if shown, else when next shown. */
  invalidate(): void {
    this.#stale = true;
    if (this.isVisible) this.#load(true);
    else this.#render();
  }

  protected onAfterShow(msg: Message): void {
    super.onAfterShow(msg);
    if (this.#stale) this.#load(true);
    else this.#render();
  }

  protected onActivateRequest(msg: Message): void {
    super.onActivateRequest(msg);
    this.#search.focus();
  }

  #load(fromStart: boolean): void {
    if (!this.options.signedIn()) {
      this.#stale = true;
      this.#render();
      return;
    }
    if (fromStart) this.#stale = false;
    void this.#threads.load(fromStart);
  }

  /** Renamed or deleted from this list: shown at once. */
  renamed(threadId: string, topic: string): void {
    this.#threads.pages.rename(threadId, topic);
    this.#render();
  }

  removed(threadId: string): void {
    this.#threads.pages.remove(threadId);
    this.#render();
  }

  #render(): void {
    const signedIn = this.options.signedIn();
    this.#signIn.hidden = signedIn;
    this.#search.disabled = !signedIn;
    this.#loading.hidden = !signedIn || !this.#threads.loading;
    this.#list.replaceChildren();
    this.#more.hidden = true;
    this.#more.textContent = "Show more";
    if (!signedIn) {
      this.#status.textContent = "";
      return;
    }
    const pages = this.#threads.pages;
    this.#more.disabled = this.#threads.loading;
    if (this.#threads.error) {
      this.#status.textContent = `Your conversations could not be loaded: ${this.#threads.error}`;
      this.#more.hidden = false;
      this.#more.textContent = "Try again";
      return;
    }
    if (!pages.loaded) {
      this.#status.textContent = "";
      return;
    }
    const query = this.#search.value;
    const shown = filterThreads(pages.threads, query);
    const current = this.options.currentThread();
    for (const group of groupThreads(shown)) {
      const section = el("section", "jp-ClimateClaw-conversations-group");
      section.append(el("h3", "jp-ClimateClaw-conversations-groupTitle", group.label));
      const list = el("ul");
      for (const thread of group.threads)
        list.append(this.#item(thread, thread.threadId === current));
      section.append(list);
      this.#list.append(section);
    }
    const loaded = pages.threads.length;
    this.#status.textContent =
      loaded === 0
        ? "No conversations yet. Ask ClimateClaw something to start one."
        : query.trim() && shown.length === 0
          ? `No match in the ${loaded} conversations loaded${pages.hasMore ? "; show more to search further" : ""}.`
          : "";
    this.#more.hidden = !pages.hasMore;
  }

  #item(thread: StoredThreadSummary, current: boolean): HTMLLIElement {
    const item = el("li", "jp-ClimateClaw-conversation");
    if (current) item.classList.add("jp-mod-current");
    const open = el("button", "jp-ClimateClaw-conversation-open");
    open.type = "button";
    open.dataset.threadId = thread.threadId;
    if (current) open.setAttribute("aria-current", "true");
    const icon = el("span", "jp-ClimateClaw-conversation-icon");
    conversationIcon.element({ container: icon });
    const text = el("span", "jp-ClimateClaw-conversation-text");
    text.append(
      el("span", "jp-ClimateClaw-conversation-topic", thread.topic),
      el("span", "jp-ClimateClaw-conversation-time", threadTime(thread.date)),
    );
    open.append(icon, text);
    open.addEventListener("click", () => void this.#open(thread, "sidebar"));

    const more = el("button", "jp-ClimateClaw-conversation-more");
    more.type = "button";
    more.title = `More actions for "${thread.topic}"`;
    more.setAttribute("aria-label", more.title);
    more.setAttribute("aria-haspopup", "menu");
    moreIcon.element({ container: more });
    more.addEventListener("click", () => {
      const menu = new Menu({ commands: this.options.commands });
      menu.addClass("jp-ClimateClaw-conversationMenu");
      const args = { threadId: thread.threadId, topic: thread.topic };
      menu.addItem({ command: this.options.openCommand, args: { ...args, area: "sidebar" } });
      menu.addItem({ command: this.options.openCommand, args: { ...args, area: "main" } });
      if (this.options.renameCommand || this.options.deleteCommand) {
        menu.addItem({ type: "separator" });
      }
      if (this.options.renameCommand) menu.addItem({ command: this.options.renameCommand, args });
      if (this.options.deleteCommand) menu.addItem({ command: this.options.deleteCommand, args });
      const rect = more.getBoundingClientRect();
      // Right-aligned to the button: the list may sit at the window's edge.
      menu.open(rect.right, rect.bottom, { horizontalAlignment: "right" });
    });
    item.append(open, more);
    return item;
  }

  #open(thread: StoredThreadSummary, area: "sidebar" | "main"): Promise<unknown> {
    return this.options.commands.execute(this.options.openCommand, {
      threadId: thread.threadId,
      topic: thread.topic,
      area,
    });
  }
}
