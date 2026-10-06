// The extension's shared state: configuration, sign-in, API client, thread table, the Hide code
// choice and what each thread is doing. One instance per application, behind a private token.

import type { ISettingRegistry } from "@jupyterlab/settingregistry";
import { Token } from "@lumino/coreutils";
import { Signal } from "@lumino/signaling";

import { ActivityStore } from "./activity.js";
import { ClimateClawApi } from "./api.js";
import { FrevaPopupAuth } from "./auth.js";
import type { ClimateClawConfig } from "./config.js";
import { ThreadGate } from "./thread-gate.js";
import type { IFrevaAuth } from "./token.js";

export interface IClimateClaw {
  readonly config: ClimateClawConfig;
  /** Null when no Freva host is configured. */
  readonly auth: FrevaPopupAuth | null;
  readonly api: ClimateClawApi | null;
  /** The models the server serves, once known (after sign-in); empty before. */
  servedModels: string[];
  /** Each thread's current activity and the cells its reply wrote. */
  readonly activity: ActivityStore;
  /** Remote threads still busy ending a stream (chat and Run & fix). */
  readonly gate: ThreadGate;
  /** Code is left out of the chat (it still goes into its notebook cell). */
  readonly hideCode: boolean;
  setHideCode(value: boolean): Promise<void>;
  /** The model "Run at DKRZ" asks for (the user's choice, else the site's). */
  readonly runModel: string;
  setRunModel(model: string): Promise<void>;
  readonly changed: Signal<IClimateClaw, void>;
  /** Null when ready to send; otherwise why not. */
  signInProblem(): string | null;
  /** The title of the chat on `thread` (its notebook is named after it); set by the chats. */
  chatTitleOf: (thread: string) => string | null;
}

export const IClimateClaw = new Token<IClimateClaw>(
  "@freva-org/jupyterlite-climateclaw:IClimateClaw",
  "ClimateClaw's configuration, sign-in and API (private to this extension).",
);

export class ClimateClawCore implements IClimateClaw {
  readonly auth: FrevaPopupAuth | null;
  readonly api: ClimateClawApi | null;
  servedModels: string[] = [];
  readonly activity = new ActivityStore();
  readonly gate = new ThreadGate();
  chatTitleOf: (thread: string) => string | null = () => null;
  readonly changed: Signal<IClimateClaw, void> = new Signal<IClimateClaw, void>(this);

  constructor(
    readonly config: ClimateClawConfig,
    private readonly settings: ISettingRegistry.ISettings | null,
    ui: { onBlocked(retry: () => void): void; onError(message: string): void },
  ) {
    const ready = Boolean(config.host && config.authBaseUrl && config.callbackUrl);
    this.auth = ready
      ? new FrevaPopupAuth({
          host: config.host,
          authBaseUrl: config.authBaseUrl,
          callbackUrl: config.callbackUrl,
          ...(config.expectedIssuer ? { expectedIssuer: config.expectedIssuer } : {}),
          onBlocked: (retry) => ui.onBlocked(retry),
          onError: (message) => ui.onError(message),
        })
      : null;
    const auth = this.auth;
    this.api = auth
      ? new ClimateClawApi(config.apiBase, (input, init) => auth.fetch(input, init))
      : null;
    auth?.changed.connect(() => this.changed.emit());
    settings?.changed.connect(() => this.changed.emit());
  }

  get hideCode(): boolean {
    const value = this.settings?.get("hideCode").composite;
    if (typeof value === "boolean") return value;
    // Code going into notebook cells is not repeated in the chat, unless asked for.
    return this.config.codeToNotebook || this.config.hideCodeByDefault;
  }

  async setHideCode(value: boolean): Promise<void> {
    if (this.settings) await this.settings.set("hideCode", value);
    this.changed.emit();
  }

  get runModel(): string {
    const chosen = this.settings?.get("runModel").composite;
    return typeof chosen === "string" && chosen ? chosen : this.config.runAndFixModel;
  }

  async setRunModel(model: string): Promise<void> {
    if (this.settings) await this.settings.set("runModel", model);
    this.changed.emit();
  }

  signInProblem(): string | null {
    if (!this.auth) return "ClimateClaw is not configured for this site (no Freva host).";
    if (!this.auth.signedIn) {
      return 'Sign in with Freva to use ClimateClaw: use "Sign in with Freva" in the chat toolbar.';
    }
    return null;
  }
}

/** The IFrevaAuth given to other extensions when this site has no Freva host. */
export class UnconfiguredAuth implements IFrevaAuth {
  readonly host = "";
  readonly signedIn = false;
  readonly username = null;
  readonly changed: Signal<IFrevaAuth, void> = new Signal<IFrevaAuth, void>(this);
  fetch(): Promise<Response> {
    return Promise.reject(new Error("No Freva host is configured for this site."));
  }
  async accessToken(): Promise<string | null> {
    return null;
  }
  login(): void {
    // Nothing to sign in to.
  }
  async logout(): Promise<void> {
    // Nothing to sign out of.
  }
}
