// @vitest-environment jsdom
// The JupyterLab presenter's lifecycle: a replaced model is let go everywhere jupyterlite-ai keeps
// it - its views and its side panel's cache of loaded models - so the chat opens again on a new
// model, never the disposed one. The open command below does what jupyterlite-ai 0.20.1's
// `open-or-reveal-chat` does: a shown chat, else the side panel's loaded model, else a new one.
import { describe, expect, it, vi } from "vitest";
import { CommandRegistry } from "@lumino/commands";

import type { LoadedModels } from "../src/lab-presenter.js";

// What jsdom lacks and the upstream modules read when loaded.
vi.hoisted(() => {
  const g = globalThis as { DragEvent?: unknown; MouseEvent: typeof MouseEvent };
  g.DragEvent ??= class extends g.MouseEvent {};
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as never;
});

const { AI_OPEN_OR_REVEAL_CHAT, LabPresenter } = await import("../src/lab-presenter.js");

class Model {
  isDisposed = false;
  constructor(readonly name: string) {}
  dispose() {
    this.isDisposed = true;
  }
}

function lab(evict = true) {
  const loaded = new Map<string, Model>();
  const panels: Array<{ model: Model; dispose(): void }> = [];
  const side: LoadedModels = {
    getLoadedModel: (name) => loaded.get(name) as never,
    unsetLoadedModel: (name, dispose = true) => {
      if (dispose) loaded.get(name)?.dispose();
      loaded.delete(name);
    },
  };
  const tracker = {
    find: (fn: (p: { model: Model }) => boolean) => panels.find(fn),
    forEach: (fn: (p: { model: Model; dispose(): void }) => void) => [...panels].forEach(fn),
    currentWidget: null,
  };
  const show = (model: Model) => {
    const panel = {
      model,
      dispose: () => void panels.splice(panels.indexOf(panel), 1),
    };
    panels.push(panel);
  };
  const commands = new CommandRegistry();
  let made = 0;
  commands.addCommand(AI_OPEN_OR_REVEAL_CHAT, {
    execute: (args) => {
      const name = String(args.name);
      if (panels.some((p) => p.model.name === name)) return;
      const cached = loaded.get(name);
      if (cached) return show(cached);
      made += 1;
      const model = new Model(name);
      loaded.set(name, model);
      show(model);
    },
  });
  const presenter = new LabPresenter(
    commands,
    tracker as never,
    () => "climateclaw",
    evict ? () => side : () => null,
  );
  return { presenter, loaded, panels, made: () => made };
}

describe("the JupyterLab presenter", () => {
  it("replace: the old model is let go everywhere, disposed, and a new one is shown", async () => {
    const { presenter, loaded, made } = lab();
    const first = (await presenter.open({ name: "chat-1", area: "sidebar" }))!.model as never;
    const next = await presenter.replace(first, { name: "chat-1", area: "sidebar" });
    expect((first as Model).isDisposed).toBe(true);
    expect(next).not.toBe(first);
    expect((next as unknown as Model).isDisposed).toBe(false);
    expect(loaded.get("chat-1")).toBe(next);
    expect(made()).toBe(2);
  });

  it("(why: the side panel kept the disposed model and showed it again)", async () => {
    const { presenter } = lab(false);
    const first = (await presenter.open({ name: "chat-1", area: "sidebar" }))!.model as never;
    await expect(presenter.replace(first, { name: "chat-1", area: "sidebar" })).rejects.toThrow(
      /old model was shown again/,
    );
  });

  it("closeChat keeps the model (the chat opens on it again); remove lets go of it", async () => {
    const { presenter, loaded, panels } = lab();
    const model = (await presenter.open({ name: "chat-1", area: "sidebar" }))!.model;
    presenter.closeChat(model);
    expect(panels).toHaveLength(0);
    expect(loaded.get("chat-1")).toBe(model);
    expect((await presenter.open({ name: "chat-1", area: "sidebar" }))!.model).toBe(model);
    presenter.remove(model);
    expect(panels).toHaveLength(0);
    expect(loaded.has("chat-1")).toBe(false);
    // The caller disposes it; remove does not.
    expect((model as unknown as Model).isDisposed).toBe(false);
  });
});
