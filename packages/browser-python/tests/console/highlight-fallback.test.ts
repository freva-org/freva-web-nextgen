/**
 * What the highlighter does when the tokeniser is missing or wrong. A separate file because it
 * mocks Prism, and mocking it for the whole suite would leave the real grammar unexercised. Three
 * failures, one required outcome: the command still renders, exactly, as plain text.
 */
import { Window } from "happy-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const grammar = { python: {} };
const tokenize = vi.fn();

vi.mock("prismjs/components/prism-core.js", () => ({
  default: {
    get languages() {
      return grammar;
    },
    tokenize: (...args: unknown[]) => tokenize(...args),
  },
}));
vi.mock("prismjs/components/prism-clike.js", () => ({}));
vi.mock("prismjs/components/prism-python.js", () => ({}));

const { appendHighlighted, highlightedElement, highlightingAvailable, tokenClassesPerCharacter } =
  await import("../../src/console/highlight.js");

let doc: Document;

beforeEach(() => {
  doc = new Window().document as unknown as Document;
  tokenize.mockReset();
  grammar.python = {};
});

describe("no Python grammar", () => {
  it("renders plain text rather than nothing", () => {
    // A deep import that stops registering the grammar is a plausible upgrade accident, and the
    // console must degrade to an uncoloured prompt rather than to an empty one.
    delete (grammar as { python?: unknown }).python;
    expect(highlightingAvailable()).toBe(false);

    const target = doc.createElement("div");
    expect(appendHighlighted(target, "x = 1", doc)).toBe(5);
    expect(target.textContent).toBe("x = 1");
    expect(tokenClassesPerCharacter("x = 1")).toBeNull();
  });
});

describe("a tokeniser that throws", () => {
  it("falls back to plain text with every character intact", () => {
    tokenize.mockImplementation(() => {
      throw new Error("grammar exploded");
    });
    const target = doc.createElement("div");
    expect(appendHighlighted(target, "def f():", doc)).toBe(8);
    expect(target.textContent).toBe("def f():");
    expect(tokenClassesPerCharacter("def f():")).toBeNull();
  });
});

describe("a tokeniser that loses characters", () => {
  it("discards the highlighting rather than render text that does not match the source", () => {
    // The invariant, tested at the only place it can be: a tokeniser that returns fewer characters
    // than it was given. Rendering that puts the caret one character away from where the text says
    // it is, for the rest of the session.
    tokenize.mockImplementation(() => ["def"]); // "def f():" minus five characters
    const element = highlightedElement("def f():", doc);
    expect(element.textContent).toBe("def f():");
    expect(element.querySelectorAll("span")).toHaveLength(0);
    expect(tokenClassesPerCharacter("def f():")).toBeNull();
  });

  it("maps an unrecognised token type to the catch-all class rather than dropping it", () => {
    // Prism's categories are Prism's to rename. A type this package has no mapping for still has
    // to render, and still has to be styleable.
    tokenize.mockImplementation(() => [{ type: "brand-new-category", content: "spam" }]);
    const target = doc.createElement("div");
    expect(appendHighlighted(target, "spam", doc)).toBe(4);
    expect(target.querySelector("span")?.className).toBe("bp-tok-other");
  });

  it("follows a token's `alias` when its type is unmapped", () => {
    tokenize.mockImplementation(() => [
      { type: "unmapped", alias: ["keyword"], content: "lambda" },
    ]);
    const target = doc.createElement("div");
    appendHighlighted(target, "lambda", doc);
    expect(target.querySelector("span")?.className).toBe("bp-tok-keyword");
  });

  it("ignores content that is neither string, array nor token", () => {
    // Defensive, and cheap: a grammar returning something unexpected must not throw inside a
    // render pass. The character count then disagrees with the source, so the caller falls back.
    tokenize.mockImplementation(() => [{ type: "string", content: 42 }]);
    const target = doc.createElement("div");
    expect(appendHighlighted(target, "42", doc)).toBe(0);
  });
});
