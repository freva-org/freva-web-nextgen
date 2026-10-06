// The extension's configuration, read from its plugin settings (operators set them through
// settings overrides). Every URL is derived from `host` unless given; nothing here is a secret.

import { PageConfig } from "@jupyterlab/coreutils";

export const PLUGIN_ID = "@freva-org/jupyterlite-climateclaw:plugin";
export const PROVIDER_ID = "climateclaw";
export const PROVIDER_NAME = "ClimateClaw (Freva)";
/** The name new ClimateClaw chats and model entries take: short, it is the chat header's title. */
export const CHAT_NAME = "ClimateClaw";
export const PACKAGE = "@freva-org/jupyterlite-climateclaw";
export const CALLBACK_FILE = "freva-login-callback.html";

export interface Example {
  title: string;
  prompt: string;
}

export interface ClimateClawConfig {
  /** Origin of the Freva host, e.g. `https://freva.example.org`; empty when unconfigured. */
  host: string;
  authBaseUrl: string;
  /** Absolute base of the ClimateClaw API, without a trailing slash. */
  apiBase: string;
  /** Absolute, same-origin URL of the sign-in callback (login and logout). */
  callbackUrl: string;
  expectedIssuer: string;
  defaultModel: string;
  runAndFixModel: string;
  scopeNote: string;
  examples: Example[];
  hideCodeByDefault: boolean;
  /** Code ClimateClaw runs goes into the open notebook as cells, not into the chat. */
  codeToNotebook: boolean;
  /** A short name for the host in the chat header ("DKRZ"); empty derives one from `host`. */
  hostLabel: string;
  /** Where a visitor without an account registers (shown on the chat's first page); "" hides it. */
  registerUrl: string;
  /**
   * The origin ClimateClaw's saved figures are served from (`preview_url`), which this page may
   * show pictures from (the notebook's policy allows it); default the host.
   */
  previewOrigin: string;
}

export const DEFAULT_REGISTER_URL = "https://luv.dkrz.de/register/";

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** An http(s) origin, or "" for anything else. */
export function originOf(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : "";
  } catch {
    return "";
  }
}

/**
 * Normalise raw settings. `pageBase` is this document's URL (for the callback), `defaultCallback`
 * the page shipped with the extension. `callbackPath` is resolved against this origin, so a
 * portal's `/auth/callback/` names no host and works on any port or staging origin.
 */
export function readConfig(
  raw: Record<string, unknown>,
  pageBase: string,
  defaultCallback: string,
): ClimateClawConfig {
  const host = originOf(str(raw.host));
  const authBaseUrl = (
    str(raw.authBaseUrl) || (host ? `${host}/api/freva-nextgen/auth/v2` : "")
  ).replace(/\/+$/, "");
  const apiPath = str(raw.apiPath) || "/api/chatbot";
  const apiBase = host ? `${host}/${apiPath.replace(/^\/+|\/+$/g, "")}` : "";
  let callbackUrl = "";
  try {
    const resolved = new URL(str(raw.callbackPath) || defaultCallback, pageBase);
    // The callback must be on this document's origin: it talks to this tab over BroadcastChannel.
    if (resolved.origin === new URL(pageBase).origin) {
      resolved.hash = "";
      callbackUrl = resolved.href;
    }
  } catch {
    callbackUrl = "";
  }
  const examples = Array.isArray(raw.examples)
    ? raw.examples
        .map((e) => ({ title: str((e as Example)?.title), prompt: str((e as Example)?.prompt) }))
        .filter((e) => e.title && e.prompt)
    : [];
  const defaultModel = str(raw.defaultModel);
  return {
    host,
    authBaseUrl,
    apiBase,
    callbackUrl,
    expectedIssuer: str(raw.expectedIssuer),
    defaultModel,
    runAndFixModel: str(raw.runAndFixModel) || defaultModel,
    scopeNote: str(raw.scopeNote),
    examples,
    hideCodeByDefault: raw.hideCodeByDefault === true,
    codeToNotebook: raw.codeToNotebook !== false,
    hostLabel: str(raw.hostLabel),
    previewOrigin: originOf(str(raw.previewOrigin)) || host,
    registerUrl:
      raw.registerUrl === undefined
        ? DEFAULT_REGISTER_URL
        : /^https:\/\//.test(str(raw.registerUrl))
          ? str(raw.registerUrl)
          : "",
  };
}

/** A slash-command name for an example: lowercase words joined by hyphens. */
export function exampleCommandName(example: Example, taken: Set<string>): string {
  const base =
    example.title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "example";
  let name = base;
  for (let i = 2; taken.has(name); i += 1) name = `${base}-${i}`;
  taken.add(name);
  return name;
}

/**
 * The site's settings overrides for a plugin (jupyter-lite.json `settingsOverrides`): what
 * configures it when the settings this browser saved for it no longer load.
 */
export function siteOverrides(
  plugin: string,
  all: unknown = PageConfig.getOption("settingsOverrides"),
): Record<string, unknown> {
  let value = all;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value || "{}");
    } catch {
      value = {};
    }
  }
  const mine = (value as Record<string, unknown> | null)?.[plugin];
  return mine && typeof mine === "object" ? (mine as Record<string, unknown>) : {};
}
