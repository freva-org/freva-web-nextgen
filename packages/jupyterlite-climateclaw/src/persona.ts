// ClimateClaw's own name and face on its replies. jupyterlite-ai 0.20.1 has one persona
// ("Jupyternaut") and no setting for it, so a ClimateClaw chat rewrites that persona's sender on
// its messages and in its writer list - through the chat model's public API (message updates,
// `updateWriters`), never its DOM. The username stays the persona's, so jupyterlite-ai still knows
// the replies as its own (history, saved chats).

import type { IChatModel, IUser } from "@jupyter/chat";
import type { ISignal } from "@lumino/signaling";

import { LOGO_DATA_URL } from "./logo.js";

/** jupyterlite-ai's persona, as its messages name it. */
export const PERSONA_USERNAME = "jupyternaut-frontend";

export const CLIMATECLAW_PERSONA: IUser = {
  username: PERSONA_USERNAME,
  display_name: "ClimateClaw",
  initials: "CC",
  color: "#1f5aa6",
  avatar_url: LOGO_DATA_URL,
  bot: true,
  mention_name: PERSONA_USERNAME,
};

const isPersona = (user: IUser | undefined): boolean =>
  !!user && user.username === PERSONA_USERNAME && user.display_name !== "ClimateClaw";

/** The chat model's parts this uses. */
export type PersonaChat = Pick<
  IChatModel,
  "messages" | "messagesUpdated" | "writers" | "updateWriters"
> & {
  readonly writersChanged?: IChatModel["writersChanged"];
};

/**
 * Shows this chat's persona replies as ClimateClaw's while `active()` (the chat talks to
 * ClimateClaw). A reply is decided once, when first seen: switching the chat to another provider
 * later does not rename replies that were ClimateClaw's, nor the reverse. Returns the disconnect.
 */
export function presentAsClimateClaw(
  model: PersonaChat,
  active: () => boolean,
  /** What ClimateClaw is doing now ("is thinking…"), for its line in the writers list. */
  doing?: { text(): string | null; changed: ISignal<unknown, unknown> },
): () => void {
  const decided = new Set<string>();
  const renamed = new Set<string>();
  const onMessages = () => {
    for (const message of model.messages) {
      if (decided.has(message.id)) {
        // Ours, but its sender was reset by an update: rename it again.
        if (isPersona(message.sender) && renamed.has(message.id)) {
          message.update({ sender: CLIMATECLAW_PERSONA });
        }
        continue;
      }
      if (!isPersona(message.sender) && message.sender.username !== PERSONA_USERNAME) continue;
      decided.add(message.id);
      if (!active()) continue;
      renamed.add(message.id);
      if (isPersona(message.sender)) message.update({ sender: CLIMATECLAW_PERSONA });
    }
  };
  // After the emission that brought the persona: renaming inside it would reach the listeners
  // still to be called after the renamed list, and they would keep the persona's. Its line says
  // what it is doing ("ClimateClaw is running code at DKRZ…"), through the writer's own
  // `typingIndicator`.
  let pending = false;
  const ours = (w: IChatModel.IWriter) =>
    isPersona(w.user) || w.user.display_name === CLIMATECLAW_PERSONA.display_name;
  const indicator = () => doing?.text() ?? undefined;
  const stale = (w: IChatModel.IWriter) =>
    isPersona(w.user) || (ours(w) && w.typingIndicator !== indicator());
  const refresh = () => {
    if (pending || !active() || !model.writers.some(stale)) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      if (!connected || !active()) return;
      const now = model.writers;
      if (!now.some(stale)) return;
      const text = indicator();
      model.updateWriters(
        now.map((w) => {
          if (!ours(w)) return w;
          const next: IChatModel.IWriter = { ...w, user: CLIMATECLAW_PERSONA };
          if (text) next.typingIndicator = text;
          else delete next.typingIndicator;
          return next;
        }),
      );
    });
  };
  const onWriters = () => refresh();
  let connected = true;
  model.messagesUpdated.connect(onMessages);
  model.writersChanged?.connect(onWriters);
  doing?.changed.connect(refresh);
  onMessages();
  return () => {
    connected = false;
    model.messagesUpdated.disconnect(onMessages);
    model.writersChanged?.disconnect(onWriters);
    doing?.changed.disconnect(refresh);
  };
}

/** What ClimateClaw is doing, as its writer line says it: "is thinking…", "is running code…". */
export function doingText(phase: string | null, label = ""): string | null {
  switch (phase) {
    case null:
      return null;
    case "thinking":
      return "is thinking…";
    case "writing":
      return "is writing…";
    case "coding":
      return "is writing code…";
    case "running":
      return "is running code at DKRZ…";
    case "figure":
      return "is drawing a figure…";
    default:
      return label ? `is ${label.charAt(0).toLowerCase()}${label.slice(1)}…` : null;
  }
}
