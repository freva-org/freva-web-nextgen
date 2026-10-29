// What a JupyterLite site needs to carry ClimateClaw: the settings overrides, the plugins to turn
// off, the files, the pinned jupyterlite-ai wheels and the sign-in callback page.
//
// One implementation for every site that prepares a notebook with the assistant - the portal
// builder's `prepare-notebook` and a documentation site's own small script - so the settings shape
// and the list of jupyterlite-ai plugins a JupyterLite cannot use cannot drift between them. Hand
// the result to `@freva-org/jupyterlite-freva-kernel/prepare`'s `prepareNotebookSite({ lab })`.
//
// No DOM, no JupyterLab: this module runs in Node at build time and never reaches the network. It
// is not part of the extension's browser bundle.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { trimTrailing } from "./trim.js";

/** The settings id the extension reads (`overrides.json`). */
export const CLIMATECLAW_PLUGIN = "@freva-org/jupyterlite-climateclaw:plugin";

/** The callback page this package ships, and its script (no inline code: a strict policy holds). */
export const CALLBACK_PAGE = "freva-login-callback.html";
export const CALLBACK_SCRIPT = "freva-login-callback.js";

/** What jupyterlite-ai brings that a JupyterLite with ClimateClaw does not use. */
export const AI_DISABLED_EXTENSIONS: readonly string[] = [
  // The AI settings panel: the provider and model are the site's (settings overrides).
  "@jupyternaut/persona:settings-panel",
  // MCP servers need a Jupyter server; JupyterLite has none (it would fetch /jupyter-mcp-manager).
  "jupyter-mcp-manager:manager",
  // Diffs in the file editor, whose tracker a trimmed Lab disables.
  "jupyterlab-diff:unified-file-diff-plugin",
  // jupyterlite-ai's chat panel: ClimateClaw shows chats in its own panel (with the chat tracker
  // and the chat commands this plugin would otherwise provide), on jupyterlite-ai's chat models.
  "@jupyterlite/ai:chat",
  // "@jupyternaut-frontend" offered on "@": jupyterlite-ai's chats answer without a mention.
  "@jupyternaut/persona:mention",
];

export interface ClimateClawSiteInput {
  /** The Freva host's origin, e.g. `https://freva.example.org`. */
  host: string;
  /** Default `{host}/api/freva-nextgen/auth/v2`. */
  authBaseUrl?: string;
  /** The sign-in callback on the notebook's origin, origin-relative (`/auth/callback/`). */
  callbackPath: string;
  expectedIssuer?: string;
  defaultModel: string;
  runAndFixModel?: string;
  scopeNote?: string;
  examples?: readonly { title: string; prompt: string }[];
  hideCodeByDefault?: boolean;
  previewOrigin?: string;
}

export interface ClimateClawSite {
  /** Settings overrides, by plugin id: ClimateClaw's own and jupyterlite-ai's. */
  overrides: Record<string, Record<string, unknown>>;
  disabledExtensions: string[];
  /** Files for the notebook site: the chat backup directory. */
  files: { path: string; text: string }[];
}

/** The package's own files a site build reads: the wheels' pins, the extension, the callback. */
export interface ClimateClawAssets {
  /** The pinned jupyterlite-ai wheels (`prepareNotebookSite`'s `lab.requirements`). */
  requirements: string;
  /** This package's prebuilt extension (`prepareNotebookSite`'s `lab.extensions`). */
  labextension: string;
  /**
   * The sign-in callback page and its script (`CALLBACK_SCRIPT`, loaded by a relative URL), for the
   * site to serve at `callbackPath`. It hands the response to the tab that opened the popup; the
   * page itself never exchanges the code. A site may also keep it in the notebook site as
   * `CALLBACK_PAGE`, for sign-ins started by a ClimateClaw configured without `callbackPath`.
   */
  callback: { page: string; script: string };
}

const packageFile = (path: string): string => fileURLToPath(new URL(`../${path}`, import.meta.url));

export function climateClawSite(input: ClimateClawSiteInput): ClimateClawSite {
  const host = trimTrailing(input.host, "/");
  return {
    overrides: {
      "@jupyternaut/persona:settings-model": {
        providers: [
          {
            id: "climateclaw",
            name: "ClimateClaw",
            provider: "climateclaw",
            model: input.defaultModel,
          },
        ],
        defaultProvider: "climateclaw",
        useSameProviderForChatAndCompleter: false,
        useSecretsManager: false,
        toolsEnabled: false,
      },
      "@jupyterlite/ai:chat": { chatBackupDirectory: "chats" },
      [CLIMATECLAW_PLUGIN]: {
        host,
        authBaseUrl: trimTrailing(input.authBaseUrl ?? `${host}/api/freva-nextgen/auth/v2`, "/"),
        // Origin-relative: the notebook resolves it against its own origin, so no host name is in
        // the site's settings.
        callbackPath: input.callbackPath,
        ...(input.expectedIssuer ? { expectedIssuer: input.expectedIssuer } : {}),
        defaultModel: input.defaultModel,
        runAndFixModel: input.runAndFixModel ?? input.defaultModel,
        scopeNote: input.scopeNote ?? "",
        examples: input.examples ?? [],
        hideCodeByDefault: input.hideCodeByDefault ?? false,
        // Where saved figures come from: the notebook's policy lets it show pictures from there.
        ...(input.previewOrigin ? { previewOrigin: input.previewOrigin } : {}),
      },
    },
    disabledExtensions: [...AI_DISABLED_EXTENSIONS],
    files: [
      // The (empty) backup directory exists in the site, so listing it does not ask the server.
      {
        path: "api/contents/chats/all.json",
        text: `${JSON.stringify({
          content: [],
          created: "2025-10-01T00:00:00.000Z",
          format: "json",
          hash: null,
          hash_algorithm: null,
          last_modified: "2025-10-01T00:00:00.000Z",
          mimetype: null,
          name: "chats",
          path: "chats",
          size: null,
          type: "directory",
          writable: true,
        })}\n`,
      },
    ],
  };
}

export function climateClawAssets(): ClimateClawAssets {
  return {
    requirements: packageFile("lite/jupyterlite-ai-requirements.txt"),
    labextension: packageFile("labextension"),
    callback: {
      page: readFileSync(packageFile(`callback/${CALLBACK_PAGE}`), "utf8"),
      script: readFileSync(packageFile(`callback/${CALLBACK_SCRIPT}`), "utf8"),
    },
  };
}
