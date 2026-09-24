// Every value in `profile.ir.nodeTypes` is produced by a real fixture. The parity suite covers
// declared directives and roles; this covers the other half of the vocabulary, the IR itself. A
// node type nobody produces is either dead weight in a normative document or a construct the
// parser emits and nothing downstream was written for.
//
// Each fixture below is parsed to IR, the union of the node types it produced is taken, and that
// union must cover the profile's list exactly. There is no skip list: a node type no document
// can produce has no business being declared.

import { afterAll, describe, expect, it } from "vitest";
import { cleanupFixtures } from "../helpers/fixture.js";
import { loadProfile } from "../../src/rendering/profile.js";
import { parseMarkdown } from "../../src/rendering/markdown/parse.js";
import { RstHelper } from "../../src/rendering/rst/client.js";
import { visitIr, type IrDocument } from "../../src/rendering/ir.js";

afterAll(cleanupFixtures);

const { profile } = loadProfile();

/**
 * One Markdown document exercising every construct the Markdown lane produces. A single document,
 * because several node types only appear in context.
 */
const MARKDOWN_FIXTURE = [
  "---",
  "title: Coverage",
  "---",
  "",
  "# Heading",
  "",
  "Plain *emphasis*, **strong**, ~~deleted~~ and `inline code`, with a break  ",
  "on the next line, a [link](https://example.org/), an ![image](../assets/logo.svg),",
  "a footnote[^a].",
  "",
  "> A quote.",
  "",
  "- item",
  "- [x] done",
  "",
  "1. first",
  "",
  "```python",
  "x = 1",
  "```",
  "",
  "```mermaid",
  "graph TD; a-->b;",
  "```",
  "",
  "| a | b |",
  "| - | - |",
  "| 1 | 2 |",
  "",
  "$$",
  "x^2",
  "$$",
  "",
  "Inline $x$ mathematics.",
  "",
  ":::note",
  "An admonition.",
  ":::",
  "",
  "---",
  "",
  "[^a]: The footnote.",
  "",
].join("\n");

/**
 * One RST document for the constructs only the RST lane produces: definition lists, containers,
 * figures with captions and legends, and the framework table of contents.
 */
const RST_FIXTURE = [
  "Coverage",
  "========",
  "",
  ".. contents::",
  "",
  "Section",
  "-------",
  "",
  "H\\ :sub:`2`\\ O and x\\ :sup:`2`.",
  "",
  "term",
  "   definition",
  "",
  ".. container:: aside",
  "",
  "   Contained.",
  "",
  ".. figure:: /assets/logo.svg",
  "",
  "   A figure caption.",
  "",
  "   And the legend, which is every paragraph after the first.",
  "",
  ".. table:: A table caption",
  "",
  "   +---+",
  "   | a |",
  "   +---+",
  "",
].join("\n");

function typesOf(document: IrDocument | undefined): Set<string> {
  const seen = new Set<string>();
  if (!document) return seen;
  seen.add("root");
  visitIr(document, (node) => seen.add(node.type));
  return seen;
}

describe("the profile's IR vocabulary", () => {
  it("is produced in full by real documents", async () => {
    const markdown = parseMarkdown(MARKDOWN_FIXTURE, "coverage.md", profile);
    expect(markdown.diagnostics.filter((d) => d.severity === "error")).toEqual([]);

    const helper = new RstHelper(profile);
    let rst: { document?: IrDocument };
    try {
      rst = (await helper.render(RST_FIXTURE, "coverage.rst")) as { document?: IrDocument };
    } finally {
      helper.stop();
    }

    const produced = new Set([...typesOf(markdown.document), ...typesOf(rst.document)]);
    const declared = new Set(profile.ir.nodeTypes);

    const missing = [...declared].filter((type) => !produced.has(type)).sort();
    const undeclared = [...produced].filter((type) => !declared.has(type)).sort();

    expect(missing, "declared IR node types that no fixture produces").toEqual([]);
    expect(undeclared, "IR node types produced but not declared in the profile").toEqual([]);
  }, 60_000);
});
