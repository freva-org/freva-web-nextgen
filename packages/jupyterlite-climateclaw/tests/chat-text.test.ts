/** The panel's chat strings: English as @jupyter/chat has them, ClimateClaw's placeholder. */
import { describe, expect, it } from "vitest";

import { chatTranslator, format, INPUT_PLACEHOLDER } from "../src/chat-text.js";

describe("chat strings", () => {
  it("replaces only the input's placeholder", () => {
    const trans = chatTranslator().load("jupyter-chat");
    expect(trans.__("Type a chat message, @ to mention...")).toBe(INPUT_PLACEHOLDER);
    expect(trans.__("Send")).toBe("Send");
    expect(trans.__("%1 is typing...", "ClimateClaw")).toBe("ClimateClaw is typing...");
    expect(trans._n("%1 message", "%1 messages", 3)).toBe("3 messages");
  });

  it("formats like gettext", () => {
    expect(format("%1 and %2, 100%%", "a", "b")).toBe("a and b, 100%");
  });
});
