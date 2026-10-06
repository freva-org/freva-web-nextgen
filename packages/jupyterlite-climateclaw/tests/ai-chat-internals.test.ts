/**
 * The one jupyterlite-ai internal ClimateClaw relies on, checked against the installed (pinned)
 * package's own chat model: it saves and restores its backup through `_contentsManager`, and
 * routing that field sends both through the contents ClimateClaw gives it. Its base class is
 * @jupyter/chat's own chat model, loaded without the package's widgets.
 */
import { createRequire } from "node:module";

import { Signal } from "@lumino/signaling";
import { describe, expect, it, vi } from "vitest";

// The chat model alone: the package entry loads every widget, which the model does not need.
vi.mock("@jupyter/chat", async () => ({
  AbstractChatModel: (await import("@jupyter/chat/lib/model.js")).AbstractChatModel,
}));

import { AIChatModel } from "@jupyterlite/ai/lib/chat-model.js";

import { routeChatContents } from "../src/ai-chat-internals.js";
import { FakeContents } from "./fake-contents.js";

function realModel(contents: object) {
  const personaAdded = new Signal<object, unknown>({});
  const model = new AIChatModel({
    settingsModel: { stateChanged: new Signal({}), getProvider: () => null },
    settings: { composite: { chatBackupDirectory: "chats" }, changed: new Signal({}) },
    user: { username: "me" },
    contentsManager: contents,
    personaRegistry: { personaAdded },
  } as never);
  personaAdded.emit({
    model,
    agentManager: {
      activeProvider: "climateclaw",
      activeProviderChanged: new Signal({}),
      clearHistory: async () => undefined,
      stopStreaming: () => undefined,
    },
    busyChanged: new Signal({}),
    rebuildHistory: async () => undefined,
  });
  return model;
}

describe("jupyterlite-ai's chat model (the pinned package)", () => {
  it("is the version this was checked against", () => {
    const require = createRequire(import.meta.url);
    expect(require("@jupyterlite/ai/package.json").version).toBe("0.20.1");
  });

  it("saves and restores through the contents it is routed to", async () => {
    const original = new FakeContents();
    const routed = new FakeContents();
    routed.dirs.add("chats");
    const model = realModel(original);
    model.name = "c1";
    original.get.mockClear();
    expect(routeChatContents(model, routed)).toBe(true);
    await model.save();
    expect(routed.files.has("chats/c1.chat")).toBe(true);
    expect(original.save).not.toHaveBeenCalled();
    routed.get.mockClear();
    expect(await model.restore("chats/c1.chat", true)).toBe(true);
    expect(routed.get).toHaveBeenCalledWith("chats/c1.chat", expect.anything());
    expect(original.get).not.toHaveBeenCalled();
  });

  it("a model without the field is reported, not routed", () => {
    expect(routeChatContents({}, new FakeContents())).toBe(false);
  });
});
