/**
 * The highlighter, and the invariant that decides whether it may be used at all. Highlighting is
 * purely visual, so a bug in it is not "the wrong colour" but a caret sitting one character away
 * from where the text says it is for the rest of the session, blamed on the terminal. Both entry
 * points refuse rather than approximate: if the tokens do not account for exactly `source.length`
 * characters, `highlightedElement` falls back to plain text and `tokenClassesPerCharacter`
 * returns null. These tests are mostly about that refusal, and about nothing here ever producing
 * markup.
 */
import { Window } from "happy-dom";
import { beforeEach, describe, expect, it } from "vitest";

import {
  appendHighlighted,
  highlightedElement,
  highlightingAvailable,
  tokenClassesPerCharacter,
} from "../../src/console/highlight.js";

let doc: Document;

beforeEach(() => {
  doc = new Window().document as unknown as Document;
});

describe("availability", () => {
  it("reports that the Python grammar loaded", () => {
    // Everything below is conditional on this; if the deep imports ever stop registering the
    // grammar, the console silently renders plain text and only this would say so.
    expect(highlightingAvailable()).toBe(true);
  });
});

describe("appendHighlighted", () => {
  it("emits exactly as many characters as it was given", () => {
    const source = "def f(x):\n    return x + 1  # comment\n";
    const target = doc.createElement("div");
    expect(appendHighlighted(target, source, doc)).toBe(source.length);
    expect(target.textContent).toBe(source);
  });

  it("emits NODES, never markup", () => {
    // The security property, and the reason `Prism.tokenize` is used rather than
    // `Prism.highlight`: the input is Python somebody typed at a prompt, and with the string form
    // the safety of this console would rest on a third party's escaping being complete for every
    // rule of a grammar this package does not own.
    const source = 'x = "<img src=x onerror=alert(1)>"';
    const target = doc.createElement("div");
    appendHighlighted(target, source, doc);
    expect(target.textContent).toBe(source);
    expect(target.querySelectorAll("img")).toHaveLength(0);
  });

  it("does nothing at all for an empty string", () => {
    const target = doc.createElement("div");
    expect(appendHighlighted(target, "", doc)).toBe(0);
    expect(target.childNodes).toHaveLength(0);
  });

  it("uses this package's own class names, not the tokeniser's", () => {
    // The theming contract: a consumer styles `bp-tok-*` and never learns what tokenised the text.
    const target = doc.createElement("div");
    appendHighlighted(target, "import os", doc);
    const classes = [...target.querySelectorAll("span")].map((s) => s.className);
    expect(classes.length).toBeGreaterThan(0);
    expect(classes.every((name) => name.startsWith("bp-tok-"))).toBe(true);
  });

  it("keeps every character of a string that contains a nested token", () => {
    // f-strings tokenise into nested content, which is the path where a naive walker loses or
    // duplicates characters.
    const source = 'name = f"hello {user!r} and {1 + 2}"';
    const target = doc.createElement("div");
    expect(appendHighlighted(target, source, doc)).toBe(source.length);
    expect(target.textContent).toBe(source);
  });

  it("survives a triple-quoted string spanning lines", () => {
    const source = 'doc = """line one\nline two\n"""\n';
    const target = doc.createElement("div");
    expect(appendHighlighted(target, source, doc)).toBe(source.length);
    expect(target.textContent).toBe(source);
  });
});

describe("highlightedElement", () => {
  it("wraps the source in one element whose text is exactly the command", () => {
    const source = "sorted({1, 2}, key=abs)";
    const element = highlightedElement(source, doc);
    // Assistive technology reads the concatenated text: the spans carry no roles and no labels, so
    // the accessible name is the command as typed.
    expect(element.textContent).toBe(source);
    expect(element.className).toBe("bp-python");
  });

  it("is a plain text node for an empty command", () => {
    expect(highlightedElement("", doc).textContent).toBe("");
  });
});

describe("tokenClassesPerCharacter", () => {
  it("returns one entry per character, or nothing", () => {
    const source = "x = 1 + 2  # two";
    const classes = tokenClassesPerCharacter(source);
    expect(classes).not.toBeNull();
    // The whole reason this returns null rather than a best effort: the caller paints one element
    // per character, and an off-by-one mapping colours the wrong character for the rest of the line.
    expect(classes).toHaveLength(source.length);
  });

  it("returns null for an empty source rather than an empty array", () => {
    expect(tokenClassesPerCharacter("")).toBeNull();
  });

  it("gives the innermost class to a character inside a nested token", () => {
    const source = 'f"{value}"';
    const classes = tokenClassesPerCharacter(source);
    expect(classes).not.toBeNull();
    expect(classes).toHaveLength(source.length);
    expect(classes?.every((entry) => entry === null || entry.startsWith("bp-tok-"))).toBe(true);
  });

  it("agrees, character for character, with what the DOM path produces", () => {
    // The two paths exist for different surfaces - one builds spans for the transcript, the other
    // colours the live command line in place - and they must not disagree. A character coloured
    // as a string in the transcript and as an operator while being typed is the kind of thing
    // nobody reports and everybody notices.
    const source = 'for i in range(3): print(f"{i}")';
    const element = highlightedElement(source, doc);
    const perCharacter = tokenClassesPerCharacter(source);
    expect(perCharacter).toHaveLength(source.length);

    const fromDom: Array<string | null> = [];
    const walk = (node: Node, inherited: string | null): void => {
      for (const child of [...node.childNodes]) {
        if (child.nodeType === 3) {
          for (let i = 0; i < (child.textContent ?? "").length; i += 1) fromDom.push(inherited);
        } else {
          walk(child, (child as HTMLElement).className || inherited);
        }
      }
    };
    walk(element, null);
    expect(fromDom).toEqual(perCharacter);
  });
});
