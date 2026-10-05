// JupyterLab's setting registry without `unsafe-eval`.
//
// The stock registry validates every plugin's settings with Ajv, which compiles each JSON schema
// into JavaScript with `new Function`: under a policy without `'unsafe-eval'` the settings plugin
// fails to activate and the notebook never starts. This plugin provides the same registry with an
// interpreting validator - `@cfworker/json-schema`, which evaluates no code - and fills in schema
// defaults the way Ajv's `useDefaults` does, which is how a plugin's `composite` settings get them.
// `prepare-notebook` disables `@jupyterlab/apputils-extension:settings` so this one is used.

import type { JupyterFrontEnd, JupyterFrontEndPlugin } from "@jupyterlab/application";
import { PageConfig } from "@jupyterlab/coreutils";
import { ISettingConnector, ISettingRegistry, SettingRegistry } from "@jupyterlab/settingregistry";
import type { IDataConnector } from "@jupyterlab/statedb";

import { InterpretingSchemaValidator } from "./schema.js";

export { InterpretingSchemaValidator, applyDefaults } from "./schema.js";

/** The stock plugin's behaviour, with the validator swapped. */
export const settingsPlugin: JupyterFrontEndPlugin<ISettingRegistry> = {
  id: "@freva-org/jupyterlite-freva-kernel:settings",
  description: "Provides the setting registry, validated without eval.",
  autoStart: true,
  provides: ISettingRegistry,
  requires: [ISettingConnector],
  activate: async (
    app: JupyterFrontEnd,
    connector: IDataConnector<ISettingRegistry.IPlugin, string, string, string>,
  ): Promise<ISettingRegistry> => {
    const { isDisabled } = PageConfig.Extension;
    const listed = (await connector.list("active")) as {
      values: ISettingRegistry.IPlugin[];
    };
    const registry = new SettingRegistry({
      connector,
      plugins: listed.values.filter((value) => app.hasPlugin(value.id)),
      validator: new InterpretingSchemaValidator(),
    });
    void app.restored.then(async () => {
      const plugins = (await connector.list("ids")) as { ids: string[] };
      for (const id of plugins.ids) {
        if (!app.hasPlugin(id) || isDisabled(id) || id in registry.plugins) continue;
        registry.load(id).catch((error: unknown) => {
          console.warn(`Settings failed to load for (${id})`, error);
        });
      }
    });
    return registry;
  },
};
