// Under the messages of ClimateClaw's own chat panel: a thumbs up or down on each reply (stored by
// ClimateClaw with the thread, `/userfeedback`) and, on a message that was edited, a switcher
// between its versions ("‹ 1/2 ›"). Each version is a thread of its own (`/editthread` branches
// one off at that message); switching shows that thread's conversation in the same chat. Each
// reply can be copied and read aloud; under each of the user's messages: its time, Edit and Copy.

import type { IChatModel, IMessageContent, MessageFooterSectionProps } from "@jupyter/chat";
import { Signal } from "@lumino/signaling";
import * as React from "react";

import type { ClimateClawApi } from "./api.js";
import { markedThread, turnOf } from "./threads.js";
import type { ActivityStore } from "./activity.js";
import { ReplyActivity } from "./busy-line.js";
import { canSpeak, isSpeaking, speakableText, toggleSpeech } from "./voice.js";

export type Rating = "up" | "down";

const RATED = new Set(["Assistant", "Code"]);

type Variant = { variant?: unknown; feedback?: unknown };

/**
 * Where reply `reply` (counted from 0, one per user message) is rated: the index, among the
 * thread's Assistant and Code variants, of its last one; null when the thread has no such reply.
 */
export function feedbackIndex(variants: readonly unknown[], reply: number): number | null {
  let users = -1;
  let rated = 0;
  let found: number | null = null;
  for (const value of variants) {
    const variant = (value as Variant | null)?.variant;
    if (variant === "User") users += 1;
    else if (typeof variant === "string" && RATED.has(variant)) {
      if (users === reply) found = rated;
      rated += 1;
    }
  }
  return found;
}

export function ratingOf(variants: readonly unknown[], reply: number): Rating | null {
  const index = feedbackIndex(variants, reply);
  if (index === null) return null;
  const rated = variants.filter((v) => RATED.has(String((v as Variant | null)?.variant)));
  const value = (rated[index] as Variant | undefined)?.feedback;
  return value === "up" || value === "down" ? value : null;
}

/**
 * Where the server stored a message: a reply's own turn marker, or - for a question - the marker
 * of the reply that answers it. Null for anything not (yet) stored: no rating, no edit.
 */
export function storedTurn(
  messages: ReadonlyArray<{ id: string; body: unknown; sender: { bot?: boolean } }>,
  id: string,
): { thread: string; index: number } | null {
  const at = messages.findIndex((m) => m.id === id);
  const message = messages[at];
  if (!message) return null;
  if (message.sender.bot) return typeof message.body === "string" ? turnOf(message.body) : null;
  for (const next of messages.slice(at + 1)) {
    if (!next.sender.bot) return null;
    const turn = typeof next.body === "string" ? turnOf(next.body) : null;
    if (turn) return turn;
  }
  return null;
}

/** The thread a chat is on: the latest marker in its replies. */
export function chatThread(model: Pick<IChatModel, "messages">): string | null {
  return markedThread(
    model.messages.map((m) => ({
      role: m.sender.bot ? "assistant" : "user",
      content: typeof m.body === "string" ? m.body : "",
    })),
  );
}

/** Each thread's ratings, read from the stored thread and written back to it. */
export class FeedbackStore {
  readonly changed = new Signal<FeedbackStore, string>(this);
  readonly #variants = new Map<string, unknown[]>();
  readonly #loading = new Map<string, Promise<void>>();
  /** Shown at once while a rating is being saved. */
  readonly #pending = new Map<string, Rating | null>();

  constructor(private readonly api: () => ClimateClawApi | null) {}

  rating(thread: string, reply: number): Rating | null {
    const key = `${thread}\u0000${reply}`;
    if (this.#pending.has(key)) return this.#pending.get(key)!;
    const variants = this.#variants.get(thread);
    return variants ? ratingOf(variants, reply) : null;
  }

  /** Reads the thread's ratings once (again with `force`, after a new reply). */
  load(thread: string, force = false): Promise<void> {
    if (!force && this.#variants.has(thread)) return Promise.resolve();
    let loading = this.#loading.get(thread);
    if (!loading) {
      const api = this.api();
      loading = (api ? api.thread(thread) : Promise.resolve([]))
        .then((variants) => {
          this.#variants.set(thread, variants);
          this.changed.emit(thread);
        })
        .catch(() => undefined)
        .finally(() => this.#loading.delete(thread));
      this.#loading.set(thread, loading);
    }
    return loading;
  }

  /** Rates a reply (null takes the rating back). Rejects with why it could not be saved. */
  async rate(thread: string, reply: number, value: Rating | null): Promise<void> {
    const api = this.api();
    if (!api) throw new Error("ClimateClaw is not configured for this site.");
    const key = `${thread}\u0000${reply}`;
    this.#pending.set(key, value);
    this.changed.emit(thread);
    try {
      const variants = await api.thread(thread);
      const index = feedbackIndex(variants, reply);
      if (index === null) throw new Error("This reply is not stored with ClimateClaw yet.");
      if (value !== null || ratingOf(variants, reply) !== null) {
        await api.feedback(thread, index, value ?? "remove");
      }
      const rated = variants.filter((v) => RATED.has(String((v as Variant | null)?.variant)));
      const target = rated[index] as Variant | undefined;
      if (target) {
        if (value) target.feedback = value;
        else delete target.feedback;
      }
      this.#variants.set(thread, variants);
    } finally {
      this.#pending.delete(key);
      this.changed.emit(thread);
    }
  }
}

interface BranchGroup {
  /** The user message (counted from 0) the versions differ at. */
  at: number;
  /** The threads, oldest version first. */
  threads: string[];
}

const BRANCHES_KEY = "climateclaw:branches";
const BRANCHES_LIMIT = 100;

/** The versions of edited messages, kept in this browser (thread ids only). */
export class BranchStore {
  readonly #groups: BranchGroup[];

  constructor(private readonly storage: Pick<Storage, "getItem" | "setItem"> | null) {
    let groups: BranchGroup[] = [];
    try {
      const raw = JSON.parse(storage?.getItem(BRANCHES_KEY) ?? "[]") as unknown;
      if (Array.isArray(raw)) {
        groups = raw.filter(
          (g): g is BranchGroup =>
            Number.isInteger(g?.at) &&
            Array.isArray(g?.threads) &&
            g.threads.every((t: unknown) => typeof t === "string"),
        );
      }
    } catch {
      groups = [];
    }
    this.#groups = groups;
  }

  /** `branch` is a new version of `source` at user message `at`. */
  add(source: string, at: number, branch: string): void {
    let group = this.#groups.find((g) => g.at === at && g.threads.includes(source));
    if (!group) {
      group = { at, threads: [source] };
      this.#groups.push(group);
    }
    if (!group.threads.includes(branch)) group.threads.push(branch);
    while (this.#groups.length > BRANCHES_LIMIT) this.#groups.shift();
    try {
      this.storage?.setItem(BRANCHES_KEY, JSON.stringify(this.#groups));
    } catch {
      // Unavailable storage: the versions are known for this page only.
    }
  }

  /** The versions at user message `at` of a chat on `thread`, and which one it shows. */
  versions(thread: string, at: number): { threads: string[]; index: number } | null {
    const group = this.#groups.find((g) => g.at === at && g.threads.includes(thread));
    if (!group || group.threads.length < 2) return null;
    return { threads: group.threads, index: group.threads.indexOf(thread) };
  }
}

const CHIP =
  /[ \t]*(?:<span class="jp-ClimateClaw-ran[^"]*"[^>]*>(?:<span[^>]*>[^<]*<\/span>|[^<])*<\/span>|<(span|a) class="jp-ClimateClaw-outcome[^"]*"[^>]*>[^<]*<\/\1>)/g;

/** A message as the user would paste it: markdown, without ClimateClaw's markers and chips. */
export function copyableText(body: string): string {
  // Code is copied as it is; outside it, comments (turn markers) and HTML (chips) go.
  return (
    body
      .split(/(```[\s\S]*?(?:```|$))/)
      .map((part, i) =>
        i % 2
          ? part
          : part
              .replace(/<!--[\s\S]*?-->/g, "")
              // The chips (which cell, how it ran, a figure) belong to the chat, not the text.
              .replace(CHIP, "")
              .replace(/<\/?[a-z][^>]*>/gi, "")
              .replace(/[ \t]+$/gm, ""),
      )
      .join("")
      // The scope note at the top of a first reply is ClimateClaw's, not the answer.
      .replace(/^\s*> \*\*Scope note\*\*.*\n(?:>.*(?:\n|$))*/, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/** A message's time: the clock today, "Yesterday" or the date before. */
export function messageTime(seconds: number, now: Date = new Date(), locale?: string): string {
  const date = new Date(seconds * 1000);
  const time = date.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(date)) / 86_400_000);
  if (days <= 0) return time;
  if (days === 1) return `Yesterday ${time}`;
  return `${date.toLocaleDateString(locale, { day: "numeric", month: "short" })}, ${time}`;
}

/** A message is still being written: its last bot message while a bot writes. */
function streaming(model: IChatModel, message: IMessageContent): boolean {
  const last = model.messages[model.messages.length - 1];
  return last?.id === message.id && (model.writers ?? []).some((w) => w.user.bot === true);
}

/** Re-renders on the model's message and writer changes. */
function useChatTick(model: IChatModel): void {
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    model.messagesUpdated.connect(bump);
    model.writersChanged?.connect(bump);
    return () => {
      model.messagesUpdated.disconnect(bump);
      model.writersChanged?.disconnect(bump);
    };
  }, [model]);
}

const THUMB =
  "M7 10v11H3V10h4zm2 11h8.5a2 2 0 0 0 2-1.6l1.4-7A2 2 0 0 0 19 10h-5.2l.8-4a1.6 1.6 0 0 0-2.9-1.2L9 10v11z";

function thumb(down: boolean): React.ReactElement {
  return React.createElement(
    "svg",
    {
      viewBox: "0 0 24 24",
      width: 14,
      height: 14,
      "aria-hidden": true,
      style: down ? { transform: "rotate(180deg)" } : undefined,
    },
    React.createElement("path", { d: THUMB, fill: "currentColor" }),
  );
}

function speaker(): React.ReactElement {
  return React.createElement(
    "svg",
    {
      viewBox: "0 0 24 24",
      width: 14,
      height: 14,
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.8,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": true,
    },
    React.createElement("path", {
      d: "M4 9.5h3.5L12 5.5v13l-4.5-4H4zM15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11",
    }),
  );
}

function strokeIcon(d: string): React.ReactElement {
  return React.createElement(
    "svg",
    {
      viewBox: "0 0 24 24",
      width: 14,
      height: 14,
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.8,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": true,
    },
    React.createElement("path", { d }),
  );
}

const COPY = "M9 9h10v11H9zM15 9V4H5v11h4";
const CHECK = "M5 12.5l4.5 4.5L19 7.5";
const PENCIL = "M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4";

/** Copies the message's text; a tick says it worked. */
function CopyButton(props: { text: () => string }): React.ReactElement {
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return React.createElement(
    "button",
    {
      type: "button",
      className: `jp-ClimateClaw-rate${copied ? " jp-mod-active" : ""}`,
      "aria-label": copied ? "Copied" : "Copy",
      title: copied ? "Copied" : "Copy",
      onClick: () => {
        navigator.clipboard?.writeText(props.text()).then(
          () => setCopied(true),
          () => undefined,
        );
      },
    },
    strokeIcon(copied ? CHECK : COPY),
  );
}

function bodyOf(message: IMessageContent): string {
  return copyableText(typeof message.body === "string" ? message.body : "");
}

/**
 * Edit opens @jupyter/chat's own editor of this message: its toolbar's Edit (hidden here; the
 * first button when the message can be edited) is clicked. ClimateClaw's own panel only.
 */
function startEdit(event: React.MouseEvent<HTMLElement>): void {
  const toolbar = event.currentTarget
    .closest(".jp-chat-message")
    ?.querySelector(".jp-chat-toolbar");
  toolbar?.querySelector<HTMLButtonElement>("button")?.click();
}

/** Under one of the user's messages: its time, Edit and Copy. */
function UserActions(props: {
  model: IChatModel;
  message: IMessageContent;
  activity?: ActivityStore;
}): React.ReactElement {
  const { model, message } = props;
  const busy = (model.writers ?? []).some((w) => w.user.bot === true);
  // Asked, and no reply yet: ClimateClaw's line goes where the reply will be.
  const waiting =
    busy && props.activity && model.messages[model.messages.length - 1]?.id === message.id;
  const editable =
    model.updateMessage !== undefined &&
    model.user?.username === message.sender.username &&
    typeof message.body === "string";
  return React.createElement(
    "span",
    { className: "jp-ClimateClaw-userActions" },
    React.createElement(
      "span",
      { className: "jp-ClimateClaw-messageTime" },
      messageTime(message.time),
    ),
    editable
      ? React.createElement(
          "button",
          {
            type: "button",
            className: "jp-ClimateClaw-rate",
            disabled: busy,
            "aria-label": "Edit",
            title: busy ? "Edit (once the reply has finished)" : "Edit",
            onClick: startEdit,
          },
          strokeIcon(PENCIL),
        )
      : null,
    React.createElement(CopyButton, { text: () => bodyOf(message) }),
    waiting
      ? React.createElement(
          "span",
          { className: "jp-ClimateClaw-replyActivity jp-mod-waiting" },
          React.createElement(ReplyActivity, {
            activity: props.activity!,
            thread: chatThread(model),
          }),
        )
      : null,
  );
}

export function feedbackFooter(
  store: FeedbackStore,
  onError: (message: string) => void,
  /** What ClimateClaw is doing, shown under the reply being written. */
  activity?: ActivityStore,
): React.FC<MessageFooterSectionProps> {
  return function FeedbackFooter({ model, message }) {
    useChatTick(model);
    const [, setTick] = React.useState(0);
    const turn = storedTurn(model.messages, message.id);
    const thread = turn?.thread ?? null;
    const reply = turn?.index ?? null;
    React.useEffect(() => {
      const bump = (_: unknown, changed: string) => {
        if (changed === thread) setTick((n) => n + 1);
      };
      store.changed.connect(bump);
      if (thread) void store.load(thread);
      return () => void store.changed.disconnect(bump);
    }, [thread]);
    if (!message.sender.bot) return React.createElement(UserActions, { model, message, activity });
    if (streaming(model, message)) {
      return activity
        ? React.createElement(
            "span",
            { className: "jp-ClimateClaw-replyActivity" },
            React.createElement(ReplyActivity, { activity, thread: chatThread(model) }),
          )
        : null;
    }
    const copy = React.createElement(CopyButton, { text: () => bodyOf(message) });
    const speak = canSpeak()
      ? React.createElement(
          "button",
          {
            type: "button",
            className: `jp-ClimateClaw-rate${isSpeaking(message.id) ? " jp-mod-active" : ""}`,
            "aria-pressed": isSpeaking(message.id),
            "aria-label": isSpeaking(message.id) ? "Stop reading" : "Read aloud",
            title: isSpeaking(message.id) ? "Stop reading" : "Read aloud",
            onClick: () => {
              toggleSpeech(
                message.id,
                speakableText(typeof message.body === "string" ? message.body : ""),
                () => setTick((n) => n + 1),
              );
              setTick((n) => n + 1);
            },
          },
          speaker(),
        )
      : null;
    if (!thread || reply === null) {
      return React.createElement("span", { className: "jp-ClimateClaw-rating" }, copy, speak);
    }
    const rating = store.rating(thread, reply);
    const rate = (value: Rating) => {
      store
        .rate(thread, reply, rating === value ? null : value)
        .catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)));
    };
    const one = (value: Rating, label: string) =>
      React.createElement(
        "button",
        {
          type: "button",
          className: `jp-ClimateClaw-rate${rating === value ? " jp-mod-active" : ""}`,
          "aria-pressed": rating === value,
          "aria-label": label,
          title: rating === value ? `${label} (click to take it back)` : label,
          onClick: () => rate(value),
        },
        thumb(value === "down"),
      );
    return React.createElement(
      "span",
      { className: "jp-ClimateClaw-rating" },
      copy,
      speak,
      one("up", "Good reply"),
      one("down", "Bad reply"),
    );
  };
}

export function branchFooter(
  store: BranchStore,
  onSwitch: (model: IChatModel, thread: string) => void,
): React.FC<MessageFooterSectionProps> {
  return function BranchFooter({ model, message }) {
    useChatTick(model);
    if (message.sender.bot) return null;
    const turn = storedTurn(model.messages, message.id);
    if (!turn) return null;
    const versions = store.versions(turn.thread, turn.index);
    if (!versions) return null;
    const { threads, index } = versions;
    const busy = (model.writers ?? []).some((w) => w.user.bot === true);
    const go = (to: number) => {
      const target = threads[to];
      if (target && !busy) onSwitch(model, target);
    };
    return React.createElement(
      "span",
      { className: "jp-ClimateClaw-versions", role: "group", "aria-label": "Versions" },
      React.createElement(
        "button",
        {
          type: "button",
          disabled: busy || index <= 0,
          "aria-label": "Previous version",
          title: "Previous version",
          onClick: () => go(index - 1),
        },
        "‹",
      ),
      React.createElement("span", null, `${index + 1}/${threads.length}`),
      React.createElement(
        "button",
        {
          type: "button",
          disabled: busy || index >= threads.length - 1,
          "aria-label": "Next version",
          title: "Next version",
          onClick: () => go(index + 1),
        },
        "›",
      ),
    );
  };
}
