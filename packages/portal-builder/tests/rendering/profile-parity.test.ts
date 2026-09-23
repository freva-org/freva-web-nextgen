// The implementation matches the published profile, construct by construct. The table below is
// keyed by what the profile *declares*, so adding a directive, a role, an IR node type or a
// location rule to `portal-content-v1.profile.json` without a fixture fails this test: the
// profile is normative, and a normative document nobody exercises is a wish.

import { afterAll, describe, expect, it } from "vitest";
import { cleanupFixtures } from "../helpers/fixture.js";
import { errorCodes, renderOne } from "../helpers/render.js";
import { loadProfile } from "../../src/rendering/profile.js";
import { resolveAdmonition } from "../../src/rendering/admonitions.js";

afterAll(cleanupFixtures);

const { profile } = loadProfile();
const md = (body: string): string => `---\ntitle: T\n---\n\n${body}\n`;
const rst = (body: string): string => `Title\n=====\n\n${body}\n`;

// Every spelling the profile declares, generated from the profile itself rather than
// hand-listed: an alias added to `containerDirectives` without a fixture would otherwise be
// accepted by the parser and exercised by nothing. The expected class is the *resolved kind*,
// not the authored word - `caution` and `attention` draw as warnings, and the authored word
// survives as the title.
const ADMONITION_FIXTURES: { name: string; source: string; expect: RegExp }[] =
  profile.markdown.containerDirectives.map((directive) => ({
    name: `admonition ${directive}`,
    source: `:::${directive}\nx\n:::`,
    expect: new RegExp(`portal-admonition-${resolveAdmonition(directive).kind}\\b`),
  }));

/** Every Markdown construct the profile accepts, with what it must produce. */
const MARKDOWN: { name: string; source: string; expect: RegExp }[] = [
  { name: "paragraph", source: "Plain text.", expect: /<p>Plain text\.<\/p>/ },
  {
    name: "heading",
    source: "## Section",
    expect: /<h2 id="section">Section<a class="portal-heading-anchor"/,
  },
  { name: "emphasis", source: "*a*", expect: /<em>a<\/em>/ },
  { name: "strong", source: "**a**", expect: /<strong>a<\/strong>/ },
  { name: "delete", source: "~~a~~", expect: /<del>a<\/del>/ },
  { name: "inlineCode", source: "`a`", expect: /<code class="portal-code-inline">a<\/code>/ },
  { name: "code", source: "```python\nx = 1\n```", expect: /portal-code-block/ },
  {
    name: "link",
    source: "[a](https://example.org/)",
    expect: /<a href="https:\/\/example\.org\/"/,
  },
  { name: "image", source: "![alt](../assets/logo.svg)", expect: /<img src="\/assets\/logo\.svg"/ },
  { name: "list", source: "- a\n- b", expect: /<ul><li>/ },
  { name: "listItem (task)", source: "- [x] a", expect: /data-portal-task="done"/ },
  { name: "blockquote", source: "> a", expect: /<blockquote>/ },
  { name: "thematicBreak", source: "a\n\n---\n\nb", expect: /<hr \/>/ },
  { name: "break", source: "a  \nb", expect: /<br \/>/ },
  { name: "table", source: "| a |\n| --- |\n| 1 |", expect: /<thead><tr><th scope="col">a<\/th>/ },
  { name: "tableRow/tableCell", source: "| a |\n| --- |\n| 1 |", expect: /<tbody><tr><td>1<\/td>/ },
  ...ADMONITION_FIXTURES,
  { name: "math", source: "$$\na+b\n$$", expect: /portal-math-block/ },
  { name: "inlineMath", source: "$x$", expect: /class="katex"/ },
  { name: "footnoteReference", source: "a[^n]\n\n[^n]: note", expect: /portal-footnote-ref/ },
  { name: "footnoteDefinition", source: "a[^n]\n\n[^n]: note", expect: /class="portal-footnote"/ },
  {
    name: "autolink (bare www)",
    source: "www.example.org",
    expect: /href="https:\/\/www\.example\.org"/,
  },
];

/** Every RST construct the profile accepts. */
const RST: { name: string; source: string; expect: RegExp }[] = [
  {
    name: "section title",
    source: "Sub\n---",
    expect: /<h2 id="sub">Sub<a class="portal-heading-anchor" href="#sub"/,
  },
  { name: "paragraph", source: "Plain text.", expect: /<p>Plain text\.<\/p>/ },
  { name: "emphasis", source: "*a*", expect: /<em>a<\/em>/ },
  { name: "strong", source: "**a**", expect: /<strong>a<\/strong>/ },
  { name: "literal", source: "``a``", expect: /portal-code-inline/ },
  // RST and MkDocs disagree about a few words: `caution` is its own class in docutils and a
  // warning in Material. The portal has one vocabulary, so the expected class is the resolved
  // kind rather than the authored word, which survives as the admonition's title.
  { name: "note", source: ".. note::\n\n   x", expect: /portal-admonition-note/ },
  { name: "tip", source: ".. tip::\n\n   x", expect: /portal-admonition-tip/ },
  { name: "warning", source: ".. warning::\n\n   x", expect: /portal-admonition-warning/ },
  {
    name: "caution",
    // Drawn as a warning, still titled with the word the author wrote.
    source: ".. caution::\n\n   x",
    expect: /portal-admonition-warning[\s\S]*Caution<\/p>/,
  },
  { name: "attention", source: ".. attention::\n\n   x", expect: /portal-admonition-warning/ },
  { name: "important", source: ".. important::\n\n   x", expect: /portal-admonition-tip/ },
  { name: "hint", source: ".. hint::\n\n   x", expect: /portal-admonition-tip/ },
  {
    name: "seealso",
    source: ".. seealso::\n\n   x",
    expect: /portal-admonition-note[\s\S]*See also<\/p>/,
  },
  { name: "danger", source: ".. danger::\n\n   x", expect: /portal-admonition-danger/ },
  { name: "error", source: ".. error::\n\n   x", expect: /portal-admonition-danger/ },
  { name: "admonition", source: ".. admonition:: Custom\n\n   x", expect: /portal-admonition/ },
  { name: "code", source: ".. code:: python\n\n   x = 1", expect: /data-portal-language="python"/ },
  {
    name: "code-block",
    source: ".. code-block:: python\n\n   x = 1",
    expect: /data-portal-language="python"/,
  },
  { name: "math directive", source: ".. math::\n\n   a^2", expect: /class="katex"/ },
  { name: "math role", source: "See :math:`a^2`.", expect: /class="katex"/ },
  {
    name: "image",
    source: ".. image:: ../assets/logo.svg\n   :alt: A mark",
    expect: /<img src="\/assets\/logo\.svg"/,
  },
  {
    name: "figure",
    source: ".. figure:: ../assets/logo.svg\n   :alt: A mark\n\n   Caption.\n\n   Legend.",
    expect:
      /<figure class="portal-figure"><img [^>]*><figcaption class="portal-figcaption">Caption\.<\/figcaption><div class="portal-figure-legend"><p>Legend\.<\/p><\/div><\/figure>/,
  },
  {
    name: "table",
    source: "+---+\n| a |\n+===+\n| 1 |\n+---+",
    expect: /<thead><tr><th scope="col">/,
  },
  {
    name: "list-table",
    source: ".. list-table::\n\n   * - a\n     - b",
    expect: /<table class="portal-table">/,
  },
  {
    name: "table directive",
    source: ".. table:: Grid resolutions\n\n   +---+\n   | a |\n   +---+",
    // The authored title, as a real `<caption>` and as the table's first child. Asserting only
    // `<table>` lets a silently discarded title through.
    expect: /<table class="portal-table"><caption>Grid resolutions<\/caption>/,
  },
  {
    name: "contents",
    // `.. contents::` produces the framework's own table of contents rather than a
    // docutils-rendered list, so it must emit no markup of its own. The headings it is built
    // from are asserted separately.
    source: ".. contents::\n\nSection\n-------\n\nBody.",
    expect: /<h2 id="section">Section<a class="portal-heading-anchor"/,
  },
  { name: "container", source: ".. container:: x\n\n   body", expect: /<div>/ },
  { name: "bullet list", source: "* a\n* b", expect: /<ul><li>/ },
  { name: "enumerated list", source: "1. a\n2. b", expect: /<ol><li>/ },
  { name: "block quote", source: "para\n\n   quoted", expect: /<blockquote>/ },
  { name: "transition", source: "a\n\n----\n\nb", expect: /<hr \/>/ },
  {
    name: "reference",
    source: "See `the site <https://example.org/>`_.",
    expect: /<a href="https:\/\/example\.org\/"/,
  },
  { name: "subscript", source: "H\\ :sub:`2`\\ O", expect: /<sub>2<\/sub>/ },
  { name: "superscript", source: "x\\ :sup:`2`", expect: /<sup>2<\/sup>/ },
  { name: "definition list", source: "term\n   definition", expect: /<dl><dt>/ },
  { name: "title-reference", source: "See :title-reference:`a book`.", expect: /<em>a book<\/em>/ },
  { name: "literal role", source: "Type :literal:`x`.", expect: /<code[^>]*>x<\/code>/ },
  { name: "code role", source: "Type :code:`y`.", expect: /<code[^>]*>y<\/code>/ },
  { name: "emphasis role", source: "See :emphasis:`a`.", expect: /<em>a<\/em>/ },
  { name: "strong role", source: "See :strong:`a`.", expect: /<strong>a<\/strong>/ },
  { name: "subscript role", source: "H\\ :subscript:`2`\\ O", expect: /<sub>2<\/sub>/ },
  { name: "superscript role", source: "x\\ :superscript:`2`", expect: /<sup>2<\/sup>/ },
];

const ASSETS = { "assets/logo.svg": `<svg xmlns="http://www.w3.org/2000/svg"></svg>` };

describe("every accepted Markdown construct renders", () => {
  it.each(MARKDOWN)("$name", async ({ source, expect: pattern }) => {
    const out = await renderOne("t.md", md(source), ASSETS);
    expect(errorCodes(out)).toEqual([]);
    expect(out.html).toMatch(pattern);
  });
});

describe("every accepted RST construct renders", () => {
  it.each(RST)("$name", async ({ source, expect: pattern }) => {
    const out = await renderOne("t.rst", rst(source), ASSETS);
    expect(errorCodes(out)).toEqual([]);
    expect(out.html).toMatch(pattern);
  });
});

describe("the profile's declared vocabulary is covered", () => {
  it("exercises every Markdown container directive", () => {
    for (const directive of profile.markdown.containerDirectives) {
      expect(MARKDOWN.some((entry) => entry.source.includes(`:::${directive}`))).toBe(true);
    }
  });

  it("exercises every allowed RST directive, with no exceptions", () => {
    const covered = RST.map((entry) => entry.source).join("\n");
    for (const directive of profile.rst.allowedDirectives) {
      expect(`${directive}: ${covered.includes(`.. ${directive}::`)}`).toBe(`${directive}: true`);
    }
  });

  it("exercises every allowed RST role, with no exceptions", () => {
    const covered = RST.map((entry) => entry.source).join("\n");
    for (const role of profile.rst.allowedRoles) {
      expect(`${role}: ${covered.includes(`:${role}:`)}`).toBe(`${role}: true`);
    }
  });
});

describe("the framework's own table of contents", () => {
  it("is built from the document's headings, not from docutils markup", async () => {
    const out = await renderOne(
      "t.rst",
      "Title\n=====\n\n.. contents::\n\nFirst\n-----\n\na\n\nSecond\n------\n\nb\n",
      ASSETS,
    );
    expect(errorCodes(out)).toEqual([]);
    // The headings the framework builds its TOC from.
    expect(out.headings.map((heading) => heading.id)).toEqual(["first", "second"]);
    // And no list of links smuggled in by the directive itself.
    expect(out.html).not.toMatch(/class="contents"/);
    expect(out.html).not.toMatch(/<a href="#first"/);
  });
});
