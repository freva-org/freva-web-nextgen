// @vitest-environment jsdom
// Dictation writes only into text it still owns: a manual edit stops it and is kept.
import { afterEach, describe, expect, it } from "vitest";

import { Dictation } from "../src/voice.js";

class FakeRecognition extends EventTarget {
  static last: FakeRecognition | null = null;
  lang = "";
  continuous = false;
  interimResults = false;
  stopped = false;
  constructor() {
    super();
    FakeRecognition.last = this;
  }
  start() {}
  stop() {
    this.stopped = true;
  }
  abort() {}
  /** A recognition result: `[text, final]` per result. */
  say(results: Array<[string, boolean]>) {
    const event = Object.assign(new Event("result"), {
      resultIndex: 0,
      results: results.map(([transcript, isFinal]) => Object.assign([{ transcript }], { isFinal })),
    });
    this.dispatchEvent(event);
  }
}

afterEach(() => {
  delete (globalThis as { SpeechRecognition?: unknown }).SpeechRecognition;
});

describe("dictation", () => {
  it("appends what is said to the draft", () => {
    (globalThis as { SpeechRecognition?: unknown }).SpeechRecognition = FakeRecognition;
    let text = "Plot";
    const dictation = new Dictation(
      (value) => (text = value),
      () => undefined,
      () => text,
    );
    dictation.start(text, "en", false);
    FakeRecognition.last!.say([["the global", false]]);
    expect(text).toBe("Plot the global");
    FakeRecognition.last!.say([["the global mean", true]]);
    expect(text).toBe("Plot the global mean");
  });

  it("stops at a manual edit and keeps it", () => {
    (globalThis as { SpeechRecognition?: unknown }).SpeechRecognition = FakeRecognition;
    let text = "Plot";
    const dictation = new Dictation(
      (value) => (text = value),
      () => undefined,
      () => text,
    );
    dictation.start(text, "en", false);
    FakeRecognition.last!.say([["the global", false]]);
    // The user corrects the text while still dictating.
    text = "Map the global";
    FakeRecognition.last!.say([["the global mean", true]]);
    expect(text).toBe("Map the global");
    expect(FakeRecognition.last!.stopped).toBe(true);
  });
});
