// Chats shown in jupyterlite-ai's own panel (JupyterLab or JupyterLite installed with pip, where
// that panel stays): models are made and shown by its commands, by name - a chat named after a
// backup is restored from it.

import type { CommandRegistry } from "@lumino/commands";
import type { IChatModel, IChatPanel, IChatTracker } from "@jupyter/chat";

import { replaceChat, type ChatPresenter, type OpenRequest } from "./chats.js";

export const AI_OPEN_CHAT = "@jupyterlite/ai:open-chat";
export const AI_OPEN_OR_REVEAL_CHAT = "@jupyterlite/ai:open-or-reveal-chat";
export const AI_MOVE_CHAT = "@jupyterlite/ai:move-chat";
export const AI_SAVE_CHAT = "@jupyterlite/ai:save-chat";

/**
 * jupyterlite-ai's side panel (`@jupyter/chat`'s MultiChatPanel), as far as its public API keeps
 * models: it holds every model it showed, by name, and shows that one again when asked for it.
 */
export interface LoadedModels {
  getLoadedModel(name: string): IChatModel | undefined;
  unsetLoadedModel(name: string, dispose?: boolean): void;
}

export const AI_CHAT_PANEL_ID = "@jupyterlite/ai:chat-panel";

export class LabPresenter implements ChatPresenter {
  constructor(
    private readonly commands: CommandRegistry,
    private readonly tracker: IChatTracker,
    private readonly provider: () => string,
    /** The side panel, once it is there. */
    private readonly sidePanel: () => LoadedModels | null = () => null,
  ) {}

  async open(request: OpenRequest): Promise<IChatPanel | null> {
    await this.commands.execute(AI_OPEN_OR_REVEAL_CHAT, {
      name: request.name,
      provider: this.provider(),
      area: request.area,
      focus: request.focus !== false,
      ...(typeof request.input === "string" ? { input: request.input } : {}),
      autoSend: request.send === true && !!request.input,
    });
    return this.tracker.find((panel) => panel.model.name === request.name) ?? null;
  }

  closeChat(model: IChatModel): void {
    this.tracker.forEach((panel) => {
      if (panel.model === model) panel.dispose();
    });
  }

  /**
   * Its views, and the side panel's hold on it: otherwise the side panel shows the disposed
   * model again the next time the chat is opened.
   */
  remove(model: IChatModel): void {
    this.closeChat(model);
    const side = this.sidePanel();
    if (side?.getLoadedModel(model.name) === model) side.unsetLoadedModel(model.name, false);
  }

  replace(old: IChatModel, request: OpenRequest): Promise<IChatModel | null> {
    return replaceChat(this, old, request);
  }

  current(): IChatPanel | null {
    return this.tracker.currentWidget;
  }
}
