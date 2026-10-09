// The "Freva Python" JupyterLite extension: one kernel spec per operator-declared setup, each
// kernel owning exactly one `BrowserPython` engine, and an interrupt that reaches the engine.

import { createBrowserPython } from "@freva-org/browser-python";
import { createSlotBroker } from "@freva-org/browser-python/session";
import {
  NOTICE_CARD_STYLES,
  adoptDisplayStyles,
  adoptStyles,
} from "@freva-org/browser-python/display";
import type { JupyterFrontEnd, JupyterFrontEndPlugin } from "@jupyterlab/application";
import { Dialog, showDialog } from "@jupyterlab/apputils";
import { PageConfig, URLExt } from "@jupyterlab/coreutils";
import { IKernelClient, IKernelSpecs } from "@jupyterlite/services";

import {
  SETTINGS_KEY,
  kernelName,
  portalBaseSource,
  readSettings,
  type KernelSettings,
} from "./config.js";
import { FrevaKernel } from "./kernel.js";
import { filesPlugin } from "./files.js";
import { settingsPlugin } from "./settings.js";
import { frameEscapePlugin, framedScrollPlugin, themePlugin } from "./theme.js";

export { FrevaKernel, STATE_LOST } from "./kernel.js";
export { readSettings, kernelName, SETTINGS_KEY } from "./config.js";
export type { KernelSettings, KernelSetup } from "./config.js";

const PACKAGE = "@freva-org/jupyterlite-freva-kernel";
const VERSION = "2610.0.0";

/** Where the engine's worker module is served: shipped beside this extension. */
export function workerUrl(): string {
  return URLExt.join(
    PageConfig.getOption("fullLabextensionsUrl"),
    PACKAGE,
    "static/browser-python/worker/browser-python.worker.js",
  );
}

/** The plugin settings, from `litePluginSettings` in jupyter-lite.json. */
export function pageSettings(): KernelSettings {
  let all: Record<string, unknown> = {};
  try {
    all = JSON.parse(PageConfig.getOption("litePluginSettings") || "{}") as Record<string, unknown>;
  } catch {
    all = {};
  }
  return readSettings(all[SETTINGS_KEY]);
}

async function confirmHardRestart(): Promise<boolean> {
  const result = await showDialog({
    title: "The cell did not stop",
    body:
      "Python is busy in code that cannot be interrupted, such as a loop that never waits. " +
      "Restarting Python stops it, and loses Python's state: variables, imports, installed " +
      "packages and files in /workspace. The notebook itself is kept.",
    buttons: [
      Dialog.cancelButton({ label: "Keep waiting" }),
      Dialog.warnButton({ label: "Restart Python" }),
    ],
  });
  return result.button.accept;
}

const kernelPlugin: JupyterFrontEndPlugin<void> = {
  id: SETTINGS_KEY,
  description: "Registers the Freva Python kernel.",
  autoStart: true,
  requires: [IKernelSpecs],
  optional: [IKernelClient],
  activate: (_app: JupyterFrontEnd, specs: IKernelSpecs, client: IKernelClient | null): void => {
    const settings = pageSettings();
    // One page, one set of slots: every kernel the page creates holds one while it lives.
    const slots = createSlotBroker({ capacity: settings.maxLiveInterpreters });
    adoptDisplayStyles(document);
    adoptStyles(document, NOTICE_CARD_STYLES);
    settings.setups.forEach((setup, index) => {
      const name = kernelName(setup, index);
      specs.register({
        spec: {
          name,
          display_name:
            settings.setups.length > 1 ? `Freva Python (${setup.label})` : "Freva Python",
          language: "python",
          argv: [],
          resources: {},
        },
        create: async (options) =>
          new FrevaKernel({
            ...options,
            slots,
            ...(setup.runStarter && settings.starter ? { starter: settings.starter } : {}),
            interruptGraceMs: settings.interruptGraceMs,
            confirmHardRestart,
            implementationVersion: VERSION,
            createEngine: () =>
              createBrowserPython({
                profile: setup.profile,
                addons: setup.addons,
                optionalAddons: setup.optionalAddons,
                workerURL: workerUrl(),
                ...(settings.runtimeIndexUrl
                  ? { pyodide: { indexURL: settings.runtimeIndexUrl } }
                  : {}),
                ...(settings.wheelhouseUrl ? { wheelhouseURL: settings.wheelhouseUrl } : {}),
                ...(settings.addonBaseUrl ? { addonBaseURL: settings.addonBaseUrl } : {}),
                ...(settings.workspaceMaxFiles
                  ? { workspaceMaxFiles: settings.workspaceMaxFiles }
                  : {}),
                // Defined unseen at every start, so the starter runs exactly as written.
                ...(settings.portalBaseUrl
                  ? { startupSource: portalBaseSource(settings.portalBaseUrl) }
                  : {}),
              }),
          }),
      });
    });
    if (client) hookInterrupt(client);
  },
};

/**
 * Lite's own interrupt only cancels requests waiting in its per-kernel queue (which our kernels
 * empty at once into their own) and never reaches a kernel. Wrapped here so that, for our
 * kernels, the kernel aborts its queued cells and the engine is interrupted as well.
 */
export function hookInterrupt(client: IKernelClient): void {
  const original = client.interrupt.bind(client);
  client.interrupt = async (kernelId: string): Promise<void> => {
    const kernel = await client.getModel(kernelId).catch(() => undefined);
    await original(kernelId);
    if (kernel instanceof FrevaKernel) await kernel.interrupt();
  };
}

export { InterpretingSchemaValidator, applyDefaults } from "./settings.js";

export { MAX_NOTEBOOK_BYTES, notebookProblems, parseNotebook } from "./ipynb.js";
export { guardNotebookUploads, SAVE_TO_WORKSPACE } from "./files.js";

export { themeFromMessage, themeFromUrl } from "./theme-sync.js";
export { alignment, containScrolling, scrollDelta, scrollWithin } from "./framed-scroll.js";

const plugins: JupyterFrontEndPlugin<unknown>[] = [
  settingsPlugin,
  kernelPlugin,
  filesPlugin,
  themePlugin,
  framedScrollPlugin,
  frameEscapePlugin,
];
export default plugins;
