// A chat's backup, written by ClimateClaw: the same JSON jupyterlite-ai 0.20.1 writes and reads
// (`_serializeModel`, `restore`), so a chat saved here opens in either. Made from the chat's
// public model (its messages and their `content`), at the moment it is written.

import type { IChatModel, IMessageContent, IUser } from "@jupyter/chat";

/** The message-queue placeholder jupyterlite-ai shows while questions wait: not a message. */
const QUEUE_MIME = "application/vnd.jupyter.chat.components";

export interface ChatBackup {
  messages: Array<Record<string, unknown>>;
  users: Record<string, IUser>;
  attachments: Record<string, unknown>;
  metadata: { provider: string; autosave: boolean; title?: string };
}

export function serializeChat(
  model: Pick<IChatModel, "messages"> & { title?: string | null },
  provider: string,
  autosave: boolean,
): ChatBackup {
  const messages: ChatBackup["messages"] = [];
  const users: ChatBackup["users"] = {};
  const byJson = new Map<string, number>();
  const attachments: unknown[] = [];
  for (const message of model.messages) {
    const content = ((message as { content?: IMessageContent }).content ??
      message) as IMessageContent & {
      mime_model?: { data?: Record<string, unknown> };
    };
    if (content.mime_model?.data?.[QUEUE_MIME] === "message-queue") continue;
    const indexes = (message.attachments ?? []).map((attachment) => {
      const json = JSON.stringify(attachment);
      let index = byJson.get(json);
      if (index === undefined) {
        index = attachments.length;
        byJson.set(json, index);
        attachments.push(attachment);
      }
      return String(index);
    });
    messages.push({
      ...content,
      sender: message.sender.username,
      mentions: message.mentions?.map((user) => user.username),
      attachments: indexes,
    });
    users[message.sender.username] ??= message.sender;
  }
  return {
    messages,
    users,
    attachments: Object.fromEntries(attachments.map((item, index) => [index, item])),
    metadata: { provider, autosave, ...(model.title ? { title: model.title } : {}) },
  };
}
