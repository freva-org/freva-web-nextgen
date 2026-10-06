// The npm packages this extension builds against are the ones the pinned wheels ship: the site
// runs jupyterlite-ai's own shared modules, so the two must be the same releases. (The browser
// suites then run the wheel-built site in both hosts.)
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const pins = Object.fromEntries(
  readFileSync(new URL("../lite/jupyterlite-ai-requirements.txt", import.meta.url), "utf8")
    .split("\n")
    .map((line) => /^([a-z0-9-]+)==([^\s]+)/.exec(line.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => [m[1], m[2]]),
);
const installed = (name: string) => require(`${name}/package.json`).version as string;

describe("pinned versions", () => {
  it("builds against exactly the jupyterlite-ai and chat components the wheels carry", () => {
    expect(pkg.dependencies["@jupyterlite/ai"]).toBe(pins["jupyterlite-ai"]);
    expect(pkg.dependencies["jupyter-chat-components"]).toBe(pins["jupyter-chat-components"]);
    expect(installed("@jupyterlite/ai")).toBe(pins["jupyterlite-ai"]);
    expect(installed("jupyter-chat-components")).toBe(pins["jupyter-chat-components"]);
  });

  it("shares them as singletons and never bundles them (the site's own modules are used)", () => {
    const shared = pkg.jupyterlab.sharedPackages;
    for (const name of ["@jupyterlite/ai", "jupyter-chat-components", "@jupyter/chat"]) {
      expect(shared[name]).toEqual({ bundled: false, singleton: true });
    }
  });

  it("asks for the @jupyter/chat range jupyterlite-ai itself declares", () => {
    const ai = require("@jupyterlite/ai/package.json");
    expect(pkg.dependencies["@jupyter/chat"]).toBe(ai.dependencies["@jupyter/chat"]);
  });
});
