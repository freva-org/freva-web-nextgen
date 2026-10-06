// Stop where Send is: in its place while the box is empty, beside it once the visitor types.
import { describe, expect, it } from "vitest";

import { hasInput, placeSend, stopPlace } from "../src/stop-place.js";

function registry(sendHidden = false) {
  const items = new Map<string, { hidden?: boolean }>([["send", { hidden: sendHidden }]]);
  const calls: string[] = [];
  return {
    calls,
    items,
    get: (name: string) => items.get(name) as never,
    show: (name: string) => {
      calls.push(`show ${name}`);
      items.get(name)!.hidden = false;
    },
    hide: (name: string) => {
      calls.push(`hide ${name}`);
      items.get(name)!.hidden = true;
    },
  };
}

describe("where Stop is", () => {
  it("nowhere while nothing streams; in Send's place with an empty box; beside Send once typing", () => {
    expect(stopPlace(false, false)).toBe("none");
    expect(stopPlace(false, true)).toBe("none");
    expect(stopPlace(true, false)).toBe("send");
    expect(stopPlace(true, true)).toBe("beside");
  });

  it("typing is text or an attachment, as Send decides; spaces are not", () => {
    expect(hasInput({ value: "  \n" })).toBe(false);
    expect(hasInput({ value: "next question" })).toBe(true);
    expect(hasInput({ value: "", attachments: [{}] })).toBe(true);
    expect(hasInput({ value: "", attachments: [] })).toBe(false);
  });
});

describe("Send, around Stop", () => {
  it("is hidden only while Stop takes its place, and comes back", () => {
    const r = registry();
    placeSend(r, "send");
    expect(r.items.get("send")!.hidden).toBe(true);
    placeSend(r, "beside");
    expect(r.items.get("send")!.hidden).toBe(false);
    placeSend(r, "send");
    placeSend(r, "none");
    expect(r.items.get("send")!.hidden).toBe(false);
    expect(r.calls).toEqual(["hide send", "show send", "hide send", "show send"]);
  });

  it("is touched only on a change: each call re-renders the toolbar", () => {
    const r = registry();
    placeSend(r, "none");
    placeSend(r, "beside");
    expect(r.calls).toEqual([]);
    placeSend(r, "send");
    placeSend(r, "send");
    expect(r.calls).toEqual(["hide send"]);
  });

  it("a chat without Send is left alone", () => {
    const r = registry();
    r.items.delete("send");
    expect(() => placeSend(r, "send")).not.toThrow();
    expect(r.calls).toEqual([]);
  });
});
