// Which ClimateClaw thread a chat belongs to.
//
// jupyterlite-ai gives a provider's model the chat's whole history and nothing that names the
// chat, so the thread travels in the history itself: the first reply of a thread starts with an
// HTML comment, `<!-- climateclaw:thread=ID -->`, which the chat's Markdown sanitiser drops from
// view and which survives in the chat's messages, its saved `.chat` file and every history
// rebuild. A new chat, or a cleared one, has no marker and so starts a new thread.
//
// A reply stopped before any of it was kept leaves no marker in the history, so the thread is also
// remembered in memory under the sequence of user messages that led to it - in a table that
// belongs to one chat (one per model instance), never shared: two chats that begin with the same
// words are not the same conversation. Without a marker and without this chat's memory, the
// answer is a new thread, never a guess.

const MARKER = /<!-- climateclaw:thread=([A-Za-z0-9_.:-]{1,128}) -->/g;

export function threadMarker(threadId: string): string {
  return `<!-- climateclaw:thread=${threadId} -->`;
}

/**
 * Where a reply is stored: its thread and the user message it answers there (counted from 0, as
 * ClimateClaw counts User variants). Written into the reply once the server has stored it, so
 * rating the reply or editing its question names server positions, not positions in this chat.
 */
const TURN = /<!-- climateclaw:turn=([A-Za-z0-9_.:-]{1,128})\/(\d{1,6}) -->/g;

export function turnMarker(threadId: string, userIndex: number): string {
  return `<!-- climateclaw:turn=${threadId}/${userIndex} -->`;
}

/** The last turn a reply's text carries, or null. */
export function turnOf(text: string): { thread: string; index: number } | null {
  let found: { thread: string; index: number } | null = null;
  for (const match of text.matchAll(TURN)) {
    found = { thread: match[1]!, index: Number(match[2]) };
  }
  return found;
}

/**
 * An edited question names the branch it is sent to: the server made the branch for this chat, and
 * a branch with no reply yet leaves no thread marker in the chat's history. Carried by the
 * question itself (not by its words, which another chat may share), until its reply has ended.
 */
const BRANCH = /\n?<!-- climateclaw:branch=([A-Za-z0-9_.:-]{1,128}) -->/g;

export function branchMarker(threadId: string): string {
  return `<!-- climateclaw:branch=${threadId} -->`;
}

/** The branch a question names, or null. */
export function branchOf(text: string): string | null {
  let found: string | null = null;
  for (const match of text.matchAll(BRANCH)) found = match[1] ?? found;
  return found;
}

/** The question without its branch marker. */
export function stripBranch(text: string): string {
  return text.replace(BRANCH, "");
}

/** Remove markers (for text shown or sent elsewhere). */
export function stripMarkers(text: string): string {
  return text
    .replace(MARKER, "")
    .replace(TURN, "")
    .replace(BRANCH, "")
    .replace(/^\s*\n/, "");
}

/** The minimal prompt shape this module reads (the AI SDK's LanguageModelV4Prompt fits it). */
export type PromptLike = ReadonlyArray<{
  role: string;
  content: string | ReadonlyArray<{ type: string; text?: string }>;
}>;

export function messageText(message: PromptLike[number]): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("");
}

/** The newest user message's text. */
export function latestUserText(prompt: PromptLike): string {
  for (let i = prompt.length - 1; i >= 0; i -= 1) {
    const message = prompt[i];
    if (message && message.role === "user") return messageText(message).trim();
  }
  return "";
}

/** The latest marker in the assistant messages, or null. */
export function markedThread(prompt: PromptLike): string | null {
  let found: string | null = null;
  for (const message of prompt) {
    if (message.role !== "assistant") continue;
    for (const match of messageText(message).matchAll(MARKER)) found = match[1] ?? found;
  }
  return found;
}

/** The user messages, in order, as one key. */
export function userKey(prompt: PromptLike, includeLast: boolean): string {
  const users = prompt.filter((m) => m.role === "user").map((m) => messageText(m).trim());
  if (!includeLast) users.pop();
  return users.join("\u0000");
}

/** In-memory fallback: user-message sequence -> thread. */
export class ThreadTable {
  private readonly table = new Map<string, string>();

  constructor(private readonly limit = 500) {}

  remember(prompt: PromptLike, threadId: string): void {
    const key = userKey(prompt, true);
    this.table.delete(key);
    this.table.set(key, threadId);
    while (this.table.size > this.limit) {
      const oldest = this.table.keys().next().value;
      if (oldest === undefined) break;
      this.table.delete(oldest);
    }
  }

  /** The thread for this prompt: the marker first, then the remembered sequence. */
  resolve(prompt: PromptLike): string | null {
    const marked = markedThread(prompt);
    if (marked) return marked;
    if (prompt.filter((m) => m.role === "user").length < 2) return null;
    return this.table.get(userKey(prompt, false)) ?? null;
  }
}

/** A short title from the first user message, for jupyterlite-ai's title requests. */
export function localTitle(prompt: PromptLike): string {
  const text = prompt
    .filter((m) => m.role === "user")
    .map((m) => messageText(m))
    .join("\n");
  // A title request carries the conversation as "user: ...\nassistant: ..." lines.
  const firstUser = /(?:^|\n)user: ([^\n]+)/.exec(text)?.[1] ?? text.split("\n")[0] ?? "";
  const words = stripMarkers(firstUser)
    .replace(/[`*_#>[\]()!]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 10);
  return words.join(" ") || "ClimateClaw";
}
