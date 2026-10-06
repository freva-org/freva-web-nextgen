// @vitest-environment jsdom
// Settings saved by an earlier version still load, and the site's own configure the rest.
import { SettingRegistry } from "@jupyterlab/settingregistry";
import { describe, expect, it } from "vitest";

import schema from "../schema/plugin.json";
import { PLUGIN_ID, siteOverrides } from "../src/config.js";

function registryWith(raw: string, saved: string[] = []): SettingRegistry {
  const connector = {
    fetch: async (id: string) => ({ id, raw, schema, version: "1" }),
    list: async () => ({ ids: [], values: [] }),
    save: async (_id: string, value: string) => void saved.push(value),
    remove: async () => undefined,
  } as unknown as ConstructorParameters<typeof SettingRegistry>[0]["connector"];
  return new SettingRegistry({ connector });
}

describe("settings", () => {
  it("loads settings saved with round 7's codeDisplay", async () => {
    const registry = registryWith('{"codeDisplay": "hidden", "runModel": "gpt-4.1"}');
    const settings = await registry.load(PLUGIN_ID);
    expect(settings.user.codeDisplay).toBe("hidden");
    expect(settings.composite.runModel).toBe("gpt-4.1");
  });

  it("still refuses keys it never had", async () => {
    await expect(registryWith('{"nonsense": 1}').load(PLUGIN_ID)).rejects.toBeTruthy();
  });

  it("reads the site's overrides, as an object or as JSON", () => {
    const all = { [PLUGIN_ID]: { host: "https://freva.example.org" }, other: { x: 1 } };
    expect(siteOverrides(PLUGIN_ID, all)).toEqual({ host: "https://freva.example.org" });
    expect(siteOverrides(PLUGIN_ID, JSON.stringify(all)).host).toBe("https://freva.example.org");
    expect(siteOverrides(PLUGIN_ID, "not json")).toEqual({});
    expect(siteOverrides(PLUGIN_ID, "")).toEqual({});
  });
});
