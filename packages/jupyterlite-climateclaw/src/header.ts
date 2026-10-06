// The chat header's model chip ("DKRZ · gpt-4.1 ▾"): where this chat's questions go, and a menu
// to switch this chat to another model the server serves. It is a "Chat" toolbar item made by
// jupyterlite-ai's own toolbar factory; switching sets the chat's active provider, as
// jupyterlite-ai's model picker does. Hidden in chats with another provider.

import type { IChatPanel } from "@jupyter/chat";
import type { IAISettingsModel, IAgentManager, IProviderConfig } from "@jupyternaut/agent";
import type { CommandRegistry } from "@lumino/commands";
import type { Message } from "@lumino/messaging";
import { Menu, Widget } from "@lumino/widgets";

import { PROVIDER_ID } from "./config.js";
import { LOGO_DATA_URL } from "./logo.js";
import { chipTierFor, type ChipTier } from "./tiers.js";

export const SELECT_MODEL = "climateclaw:select-model";

/** jupyterlite-ai's chat model carries its agent once the persona is attached. */
export function agentOf(panel: IChatPanel): IAgentManager | null {
  return (panel.model as { agentManager?: IAgentManager | null }).agentManager ?? null;
}

/** Calls `fn` with the chat's agent manager once it exists (the persona attaches it soon after). */
export function whenAgent(
  panel: IChatPanel,
  fn: (agent: IAgentManager) => void,
  timeoutMs = 15_000,
): void {
  const deadline = Date.now() + timeoutMs;
  const tick = () => {
    if (panel.isDisposed) return;
    const agent = agentOf(panel);
    if (agent) fn(agent);
    else if (Date.now() < deadline) setTimeout(tick, 100);
  };
  tick();
}

export function climateClawEntries(settings: IAISettingsModel): IProviderConfig[] {
  return settings.providers.filter((p) => p.provider === PROVIDER_ID);
}

export function isClimateClawChat(panel: IChatPanel, settings: IAISettingsModel): boolean {
  const id = agentOf(panel)?.activeProvider;
  return !!id && settings.getProvider(id)?.provider === PROVIDER_ID;
}

export class ModelChip extends Widget {
  readonly #button = document.createElement("button");
  readonly #text = document.createElement("span");
  #observer: ResizeObserver | null = null;
  #tier: ChipTier = "full";

  constructor(
    private readonly panel: IChatPanel,
    private readonly settings: IAISettingsModel,
    private readonly commands: CommandRegistry,
    private readonly host: string,
  ) {
    super();
    this.addClass("jp-ClimateClaw-modelChip");
    this.#button.type = "button";
    this.#button.className = "jp-ClimateClaw-modelChip-button";
    const icon = document.createElement("img");
    icon.className = "jp-ClimateClaw-modelChip-logo";
    icon.src = LOGO_DATA_URL;
    icon.alt = "";
    const caret = document.createElement("span");
    caret.className = "jp-ClimateClaw-caret";
    caret.textContent = "▾";
    this.#text.className = "jp-ClimateClaw-modelChip-text";
    this.#button.append(icon, this.#text, caret);
    this.#button.addEventListener("click", () => this.#open());
    this.node.append(this.#button);
    settings.stateChanged.connect(this.#update);
    whenAgent(panel, (agent) => {
      agent.activeProviderChanged.connect(this.#update);
      this.#update();
    });
    this.#update();
  }

  protected onAfterAttach(msg: Message): void {
    super.onAfterAttach(msg);
    this.#observe();
  }

  protected onBeforeDetach(msg: Message): void {
    this.#observer?.disconnect();
    this.#observer = null;
    super.onBeforeDetach(msg);
  }

  /** Watches the toolbar it sits in (the header, or the popup it folds into). */
  #observe(): void {
    this.#observer?.disconnect();
    const host = this.node.parentElement;
    if (!host || typeof ResizeObserver === "undefined") return;
    this.#observer = new ResizeObserver(() => {
      const tier = chipTierFor(host.clientWidth, !!host.closest(".jp-Toolbar-responsive-popup"));
      if (tier !== this.#tier) {
        this.#tier = tier;
        this.#update();
      }
    });
    this.#observer.observe(host);
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.#observer?.disconnect();
    this.settings.stateChanged.disconnect(this.#update);
    agentOf(this.panel)?.activeProviderChanged.disconnect(this.#update);
    super.dispose();
  }

  readonly #update = () => {
    const config = this.settings.getProvider(agentOf(this.panel)?.activeProvider ?? "");
    const ours = config?.provider === PROVIDER_ID;
    this.setHidden(!ours);
    if (!ours || !config) return;
    this.#text.textContent =
      this.#tier === "full"
        ? [this.host, config.model].filter(Boolean).join(" · ")
        : this.#tier === "model"
          ? config.model
          : "";
    this.#text.hidden = this.#tier === "logo";
    this.node.dataset.tier = this.#tier;
    this.#button.title = `ClimateClaw at ${this.host || "the Freva host"}, model ${config.model}. Switch model…`;
    this.#button.setAttribute("aria-label", this.#button.title);
    this.#button.dataset.model = config.model;
  };

  #open(): void {
    const menu = new Menu({ commands: this.commands });
    menu.addClass("jp-ClimateClaw-modelMenu");
    for (const entry of climateClawEntries(this.settings)) {
      menu.addItem({
        command: SELECT_MODEL,
        args: { chatId: this.panel.id, providerId: entry.id },
      });
    }
    const rect = this.#button.getBoundingClientRect();
    menu.open(rect.left, rect.bottom);
  }
}

/** The command behind each model menu entry: switches one chat. */
export function addSelectModelCommand(
  commands: CommandRegistry,
  settings: IAISettingsModel,
  find: (chatId: string) => IChatPanel | undefined,
): void {
  commands.addCommand(SELECT_MODEL, {
    label: (args) => settings.getProvider(String(args.providerId ?? ""))?.model ?? "Model",
    isToggled: (args) => {
      const panel = find(String(args.chatId ?? ""));
      return !!panel && agentOf(panel)?.activeProvider === args.providerId;
    },
    execute: (args) => {
      const panel = find(String(args.chatId ?? ""));
      const agent = panel ? agentOf(panel) : null;
      const id = String(args.providerId ?? "");
      if (agent && settings.getProvider(id)?.provider === PROVIDER_ID) agent.activeProvider = id;
    },
  });
}
