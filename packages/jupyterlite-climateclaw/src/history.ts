// A stored ClimateClaw thread as a jupyterlite-ai chat file. Opening it goes through
// jupyterlite-ai's own restore path (a chat named after a `.chat` file in the backup directory is
// restored when it is created), so restored messages are history, not new questions. The first
// reply carries the thread marker, so continuing the chat continues the thread.

import { CLIMATECLAW_PERSONA } from "./persona.js";
import { threadToTurns } from "./stream.js";
import { threadMarker, turnMarker } from "./threads.js";

/** jupyterlite-ai's persona user (its username), shown as ClimateClaw. */
export const PERSONA_USER = CLIMATECLAW_PERSONA;
export const HUMAN_USER = { username: "user", display_name: "User" };

export interface ExportedChat {
  messages: Array<{
    body: string;
    sender: string;
    id: string;
    time: number;
    type: "msg";
    raw_time: boolean;
    attachments: string[];
  }>;
  users: Record<string, object>;
  attachments: Record<string, never>;
  metadata: { provider: string; autosave: boolean; title: string };
}

/**
 * The local name (and backup file name) of a chat opened from a stored thread: the thread's id,
 * never its topic - a title is shown, it never names a file. Opening the thread again writes the
 * server's conversation over the same backup.
 */
export function chatNameFor(threadId: string): string {
  return `ClimateClaw ${threadId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "thread"}`;
}

/**
 * A new chat's name, unique for good: jupyterlite-ai restores a chat from the backup file of the
 * same name, so a name used before - even by a chat since closed - would bring that chat (and its
 * thread) back. The time keeps it readable; the random part makes it the chat's own.
 */
export function newChatName(stamp: string, id: string): string {
  return `ClimateClaw ${stamp} ${id}`;
}

/** A contents error that says the file is not there (and nothing else). */
export function isNotFound(error: unknown): boolean {
  return (error as { response?: { status?: number } } | null)?.response?.status === 404;
}

/** A short random identifier (base 36). */
export function randomId(length = 6): string {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => (b % 36).toString(36)).join("");
}

export function threadToChat(
  variants: unknown[],
  options: {
    threadId: string;
    topic: string;
    provider: string;
    hideCode: boolean;
    now?: number;
    /** Saved again as it changes (ClimateClaw's own panel). */
    autosave?: boolean;
    /** A history with no reply yet stays empty (an edited first message). */
    allowEmpty?: boolean;
  },
): ExportedChat {
  const { turns } = threadToTurns(variants, { hideCode: options.hideCode });
  if (!options.allowEmpty && !turns.some((t) => t.role === "assistant")) {
    turns.push({
      role: "assistant",
      text: "_No reply was stored for this conversation._",
      user: -1,
    });
  }
  let marked = false;
  const base = options.now ?? Date.now() / 1000;
  const messages = turns.map((turn, index) => {
    let body = turn.text;
    if (turn.role === "assistant" && turn.user >= 0) {
      body = `${body}\n${turnMarker(options.threadId, turn.user)}`;
    }
    if (turn.role === "assistant" && !marked) {
      body = `${threadMarker(options.threadId)}\n${body}`;
      marked = true;
    }
    return {
      body,
      sender: turn.role === "assistant" ? PERSONA_USER.username : HUMAN_USER.username,
      id: `climateclaw-${options.threadId}-${index}`,
      time: base + index * 0.001,
      type: "msg" as const,
      raw_time: false,
      attachments: [],
    };
  });
  return {
    messages,
    users: { [PERSONA_USER.username]: PERSONA_USER, [HUMAN_USER.username]: HUMAN_USER },
    attachments: {},
    metadata: {
      provider: options.provider,
      autosave: options.autosave === true,
      title: options.topic,
    },
  };
}
