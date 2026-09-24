// Every `perNodeType` location rule, and the helper's failure modes. The rule is narrow and easy
// to get wrong: a location may only claim a rule it actually followed. Recording whichever
// `originRule` the profile lists while always walking to the nearest positioned ancestor lets an
// inherited caption position claim `parent-figure` with no figure anywhere in the tree.

import { afterAll, describe, expect, it } from "vitest";
import { cleanupFixtures } from "../helpers/fixture.js";
import { renderOne } from "../helpers/render.js";
import { loadProfile } from "../../src/rendering/profile.js";
import { locationFor, ruleFor, type OriginNode } from "../../src/rendering/location.js";
import { parseMarkdown } from "../../src/rendering/markdown/parse.js";
import {
  visitIr,
  type IrDocument,
  type IrNode,
  type SourceLocation,
} from "../../src/rendering/ir.js";
import { RstHelper, RstHelperError } from "../../src/rendering/rst/client.js";

afterAll(cleanupFixtures);

const { profile } = loadProfile();

function locations(source: string): { type: string; loc: SourceLocation }[] {
  const result = parseMarkdown(source, "docs/t.md", profile);
  const out: { type: string; loc: SourceLocation }[] = [];
  if (!result.document) return out;
  visitIr(result.document as unknown as IrNode, (node) =>
    out.push({ type: node.type, loc: node.loc }),
  );
  return out;
}

const AT_LINE_12: OriginNode = { loc: { kind: "parser", file: "t.md", line: 12 }, type: "figure" };

describe("each named origin rule", () => {
  it("resolves nearest-ancestor-with-position from that ancestor", () => {
    const derived = locationFor(profile, "text", "t.md", undefined, {
      "nearest-ancestor-with-position": { ...AT_LINE_12, type: "paragraph" },
    });
    expect(derived).toEqual({
      kind: "inherited",
      file: "t.md",
      line: 12,
      originRule: "nearest-ancestor-with-position",
      originType: "paragraph",
    });
  });

  it("resolves parent-figure only when a figure is offered", () => {
    expect(ruleFor(profile, "caption").originRule).toBe("parent-figure");
    const withFigure = locationFor(profile, "caption", "t.md", undefined, {
      "parent-figure": AT_LINE_12,
    });
    expect(withFigure).toMatchObject({ kind: "inherited", originRule: "parent-figure", line: 12 });

    // The rule names a figure. Without one the honest answer is `generated`, not the nearest
    // ancestor wearing the figure's label.
    const withoutFigure = locationFor(profile, "caption", "t.md", undefined, {
      "nearest-ancestor-with-position": { ...AT_LINE_12, type: "paragraph" },
    });
    expect(withoutFigure).toEqual({
      kind: "generated",
      file: "t.md",
      transform: "parser-position-unavailable",
    });
  });

  it("resolves parent-document-first-child only from the document's first child", () => {
    expect(ruleFor(profile, "footnoteDefinition").originRule).toBe("parent-document-first-child");
    const derived = locationFor(profile, "footnoteDefinition", "t.md", undefined, {
      "parent-document-first-child": { ...AT_LINE_12, type: "paragraph" },
    });
    expect(derived).toMatchObject({
      kind: "inherited",
      originRule: "parent-document-first-child",
      originType: "paragraph",
    });
    const unavailable = locationFor(profile, "footnoteDefinition", "t.md", undefined, {
      "nearest-ancestor-with-position": { ...AT_LINE_12, type: "paragraph" },
    });
    expect(unavailable.kind).toBe("generated");
  });

  it("resolves origin-code-node for a generated diagram", () => {
    expect(ruleFor(profile, "diagram").originRule).toBe("origin-code-node");
    const derived = locationFor(profile, "diagram", "t.md", undefined, {
      "origin-code-node": { ...AT_LINE_12, type: "code" },
    });
    expect(derived).toMatchObject({ kind: "generated", transform: "mermaid", originType: "code" });
  });

  it("marks a node with nothing to inherit from as generated", () => {
    expect(locationFor(profile, "text", "t.md", undefined, undefined)).toEqual({
      kind: "generated",
      file: "t.md",
      transform: "parser-position-unavailable",
    });
  });

  it("names a rule for every node type the profile lists", () => {
    const known = new Set([
      "nearest-ancestor-with-position",
      "parent-figure",
      "parent-document-first-child",
      "origin-code-node",
    ]);
    for (const [type, rule] of Object.entries(profile.ir.locationProvenance.perNodeType)) {
      if (!rule.originRule) continue;
      expect(`${type}: ${known.has(rule.originRule)}`).toBe(`${type}: true`);
    }
  });
});

describe("provenance in real documents", () => {
  it("labels a parser position as parser and keeps its line", () => {
    const nodes = locations("---\ntitle: T\n---\n\nFirst.\n\nSecond.\n");
    const paragraphs = nodes.filter((n) => n.type === "paragraph");
    expect(paragraphs[0]!.loc).toMatchObject({ kind: "parser", line: 5 });
    expect(paragraphs[1]!.loc).toMatchObject({ kind: "parser", line: 7 });
  });

  it("inherits an inline node's position from its positioned ancestor", () => {
    const nodes = locations("---\ntitle: T\n---\n\nSome *emphasis*.\n");
    const text = nodes.find((n) => n.type === "text")!;
    expect(text.loc.kind === "parser" || text.loc.kind === "inherited").toBe(true);
    if (text.loc.kind === "inherited") {
      expect(text.loc.originRule).toBe("nearest-ancestor-with-position");
    }
  });

  it("never labels a derived position as parser-provided", () => {
    const nodes = locations("---\ntitle: T\n---\n\n| a |\n| --- |\n| 1 |\n");
    for (const node of nodes) {
      if (node.loc.kind !== "inherited") continue;
      expect(node.loc.originRule).toBeTruthy();
      expect(node.loc.originType).toBeTruthy();
    }
  });

  it("marks the document root as generated with no invented line", () => {
    const result = parseMarkdown("---\ntitle: T\n---\n\nBody.\n", "docs/t.md", profile);
    const document = result.document as IrDocument;
    expect(document.loc).toEqual({
      kind: "generated",
      file: "docs/t.md",
      transform: "document",
    });
  });
});

describe("helper failure modes", () => {
  it("refuses a helper whose handshake does not match the profile", async () => {
    const wrong = { ...profile, rst: { ...profile.rst, protocol: "not-the-protocol" } };
    const helper = new RstHelper(wrong);
    await expect(helper.start()).rejects.toBeInstanceOf(RstHelperError);
  });

  it("refuses a helper that cannot be started at all", async () => {
    const previous = process.env.FREVA_PORTAL_RST;
    const previousPython = process.env.PYTHON;
    process.env.FREVA_PORTAL_RST = "/nonexistent/freva-portal-rst";
    process.env.PYTHON = "/nonexistent/python3";
    try {
      const helper = new RstHelper(profile);
      await expect(helper.start()).rejects.toBeInstanceOf(RstHelperError);
    } finally {
      if (previous === undefined) delete process.env.FREVA_PORTAL_RST;
      else process.env.FREVA_PORTAL_RST = previous;
      if (previousPython === undefined) delete process.env.PYTHON;
      else process.env.PYTHON = previousPython;
    }
  });

  it("rejects an in-flight request when the helper dies instead of hanging", async () => {
    const helper = new RstHelper(profile);
    await helper.start();
    // Kill the process, then ask it for a document: without the exit handler this promise
    // never settles and the build hangs.
    helper.stop();
    await expect(helper.render("Title\n=====\n", "t.rst")).rejects.toBeTruthy();
  }, 30_000);

  it("keeps working across many documents, so the handshake timer is not still armed", async () => {
    const helper = new RstHelper(profile);
    await helper.start();
    for (let i = 0; i < 5; i++) {
      const result = await helper.render(`Title ${i}\n=======\n\nBody.\n`, `t${i}.rst`);
      expect(result.document).toBeDefined();
    }
    helper.stop();
  }, 60_000);

  it("reports a helper crash as a diagnostic rather than as an empty document", async () => {
    // A construct the helper refuses: the document must not come back "clean".
    const out = await renderOne("t.rst", "Title\n=====\n\n.. raw:: html\n\n   <b>x</b>\n");
    expect(out.diagnostics.some((d) => d.severity === "error")).toBe(true);
    expect(out.html).toBe("");
  });
});
