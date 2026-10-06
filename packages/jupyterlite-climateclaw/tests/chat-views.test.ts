// @vitest-environment jsdom
// A chat's views: a view made while a reply runs shows Stop from the start.
import { Signal } from "@lumino/signaling";
import { describe, expect, it } from "vitest";

import { OWN_STOP, signInLeadsToNewChat, watchStop } from "../src/chat-views.js";

function view(writers: Array<{ user: { bot?: boolean } }>) {
  const shown = new Set<string>();
  const touched: string[] = [];
  const items = new Set<string>(["stop"]);
  const itemsChanged = new Signal<object, void>({});
  const model = {
    writers,
    writersChanged: new Signal<object, Array<{ user: { bot?: boolean } }>>({}),
  };
  const registry = {
    itemsChanged,
    get: (name: string) => (items.has(name) ? {} : undefined),
    show: (name: string) => {
      touched.push(`show ${name}`);
      shown.add(name);
      itemsChanged.emit();
    },
    hide: (name: string) => {
      touched.push(`hide ${name}`);
      shown.delete(name);
      itemsChanged.emit();
    },
  };
  const addOwnStop = () => {
    items.add(OWN_STOP);
    itemsChanged.emit();
  };
  return {
    widget: { model, inputToolbarRegistry: registry } as never,
    model,
    shown,
    touched,
    addOwnStop,
  };
}

describe("Stop", () => {
  it("shows at once in a view made mid-reply (a chat moved to a tab)", () => {
    const { widget, shown, model } = view([{ user: { bot: true } }]);
    const unwatch = watchStop(widget);
    expect(shown.has("stop")).toBe(true);
    model.writersChanged.emit([]);
    expect(shown.has("stop")).toBe(false);
    unwatch();
  });

  it("stays hidden in a view of an idle chat", () => {
    const { widget, shown } = view([]);
    watchStop(widget);
    expect(shown.has("stop")).toBe(false);
  });

  it("with ClimateClaw's own Stop, jupyterlite-ai's shared one is never touched", () => {
    const { widget, model, touched, addOwnStop } = view([]);
    addOwnStop();
    const unwatch = watchStop(widget);
    model.writersChanged.emit([{ user: { bot: true } }]);
    model.writersChanged.emit([]);
    // Another chat's panel may be showing it.
    expect(touched).toEqual([]);
    unwatch();
  });

  it("the own Stop arriving mid-reply hides the shared one this view showed, once", () => {
    const { widget, model, shown, touched, addOwnStop } = view([{ user: { bot: true } }]);
    const unwatch = watchStop(widget);
    expect(shown.has("stop")).toBe(true);
    addOwnStop();
    expect(shown.has("stop")).toBe(false);
    model.writersChanged.emit([]);
    expect(touched).toEqual(["show stop", "hide stop"]);
    unwatch();
  });
});

describe("after a sign-in", () => {
  it("the welcome gives way to a new chat, wherever the sign-in started", () => {
    const after = signInLeadsToNewChat(false);
    // From the header's Sign in, while the welcome shows.
    expect(after({ signedIn: true, view: "welcome", fromWelcome: false })).toBe(true);
    // A token refresh later changes nothing.
    expect(after({ signedIn: true, view: "welcome", fromWelcome: false })).toBe(false);
  });

  it("a chat or the history in front stays", () => {
    expect(signInLeadsToNewChat(false)({ signedIn: true, view: "chat", fromWelcome: false })).toBe(
      false,
    );
    expect(
      signInLeadsToNewChat(false)({ signedIn: true, view: "history", fromWelcome: false }),
    ).toBe(false);
  });

  it("the welcome's own button always leads to a new chat; a sign-out never does", () => {
    const after = signInLeadsToNewChat(true);
    expect(after({ signedIn: false, view: "welcome", fromWelcome: false })).toBe(false);
    expect(after({ signedIn: true, view: "chat", fromWelcome: true })).toBe(true);
  });
});
