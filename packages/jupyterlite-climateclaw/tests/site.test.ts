// The site helper: what a JupyterLite site carries for ClimateClaw, the same for every builder.
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  AI_DISABLED_EXTENSIONS,
  CLIMATECLAW_PLUGIN,
  climateClawAssets,
  climateClawSite,
} from "../src/site.js";

describe("climateClawSite", () => {
  it("writes the plugin's settings, jupyterlite-ai's provider and the chats directory", () => {
    const site = climateClawSite({
      host: "https://freva.example.org/",
      callbackPath: "/auth/callback/",
      defaultModel: "gpt-4.1",
      examples: [{ title: "Map", prompt: "Draw a map" }],
    });
    expect(site.overrides[CLIMATECLAW_PLUGIN]).toEqual({
      host: "https://freva.example.org",
      authBaseUrl: "https://freva.example.org/api/freva-nextgen/auth/v2",
      callbackPath: "/auth/callback/",
      defaultModel: "gpt-4.1",
      runAndFixModel: "gpt-4.1",
      scopeNote: "",
      examples: [{ title: "Map", prompt: "Draw a map" }],
      hideCodeByDefault: false,
    });
    expect(site.overrides["@jupyternaut/persona:settings-model"]).toMatchObject({
      defaultProvider: "climateclaw",
      providers: [{ id: "climateclaw", model: "gpt-4.1" }],
    });
    expect(site.disabledExtensions).toEqual([...AI_DISABLED_EXTENSIONS]);
    expect(site.disabledExtensions).toContain("@jupyterlite/ai:chat");
    expect(site.files.map((f) => f.path)).toEqual(["api/contents/chats/all.json"]);
  });

  it("finds the package's own files", () => {
    const assets = climateClawAssets();
    expect(existsSync(assets.requirements)).toBe(true);
    expect(assets.callback.page).toContain('src="./freva-login-callback.js"');
    expect(assets.callback.script).toContain("freva-auth:relay");
  });
});
