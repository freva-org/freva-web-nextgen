// Captions, figures and code titles, under two rules. A caption marker is never printed at the
// reader: it either becomes a caption or becomes a diagnostic carrying the author's own line
// number. And the markup is asserted exactly - "there is a caption somewhere in there" passes
// for a `<figcaption>` outside its `<figure>`, which an accessibility tree does not read as a
// caption at all.

import { afterAll, describe, expect, it } from "vitest";
import { cleanupFixtures } from "../helpers/fixture.js";
import { errorCodes, renderOne, type RenderOutcome } from "../helpers/render.js";

afterAll(cleanupFixtures);

const md = (body: string): string => `---\ntitle: Test\n---\n\n${body}\n`;
const rst = (body: string): string => `Test\n====\n\n${body}\n`;

/** Every diagnostic, as `code@line`, so an assertion can name the line. */
const codesAt = (out: RenderOutcome): string[] =>
  out.diagnostics.map((d) => `${d.code}@${d.position?.line ?? "?"}`);

const count = (html: string, needle: string): number => html.split(needle).length - 1;

describe("1. a caption attaches to the block before it", () => {
  it("1.1 makes an image and its caption one figure", async () => {
    const out = await renderOne(
      "t.md",
      md("![Equal area](../assets/logo.svg)\n/// caption\nCells coloured by area.\n///"),
    );
    expect(errorCodes(out)).toEqual([]);
    expect(out.html).toBe(
      '<figure class="portal-figure">' +
        '<img src="/assets/logo.svg" alt="Equal area" loading="lazy" decoding="async" />' +
        '<figcaption class="portal-figcaption"><p>Cells coloured by area.</p></figcaption>' +
        "</figure>",
    );
    expect(out.html).not.toContain("///");
  });

  it("1.2 keeps an image-only paragraph in one figure with one caption", async () => {
    const out = await renderOne(
      "t.md",
      md("![One](../assets/logo.svg)\n![Two](../assets/logo.svg)\n/// caption\nTwo panels.\n///"),
    );
    expect(errorCodes(out)).toEqual([]);
    expect(count(out.html, "<figure")).toBe(1);
    expect(count(out.html, "<figcaption")).toBe(1);
    expect(count(out.html, "<img ")).toBe(2);
    // Unwrapped: the images are the figure's own children, not a paragraph in it.
    expect(out.html).not.toContain('<figure class="portal-figure"><p>');
  });

  it("1.3 puts a table's caption inside the table, not in a card around it", async () => {
    const out = await renderOne(
      "t.md",
      md("| a | b |\n| - | - |\n| 1 | 2 |\n/// caption\nDataset availability.\n///"),
    );
    expect(errorCodes(out)).toEqual([]);
    expect(out.html).toContain(
      '<table class="portal-table"><caption><p>Dataset availability.</p></caption><thead>',
    );
    expect(out.html).not.toContain("<figure");
  });

  it("1.4 captions a fenced code block without disturbing its highlighting", async () => {
    const out = await renderOne("t.md", md("```python\nx = 1\n```\n/// caption\nThe remap.\n///"));
    expect(errorCodes(out)).toEqual([]);
    expect(
      out.html.startsWith('<figure class="portal-figure"><div class="portal-code-figure"'),
    ).toBe(true);
    expect(out.html).toContain('<span class="portal-code-line">');
    expect(out.html).toContain(
      '<figcaption class="portal-figcaption"><p>The remap.</p></figcaption>',
    );
    expect(count(out.html, "<figcaption")).toBe(1);
  });

  it("1.5 captions a Mermaid diagram as one figure, not a figure inside a figure", async () => {
    const out = await renderOne(
      "t.md",
      md("```mermaid\ngraph TD; A-->B;\n```\n/// caption\nThe flow.\n///"),
    );
    expect(errorCodes(out)).toEqual([]);
    expect(count(out.html, "<figure")).toBe(1);
    expect(out.html.startsWith('<figure class="portal-figure portal-diagram">')).toBe(true);
    expect(out.html).toContain(
      '<figcaption class="portal-figcaption"><p>The flow.</p></figcaption>',
    );
  });

  it("1.6 captions a blockquote", async () => {
    const out = await renderOne("t.md", md("> Quoted.\n/// caption\nThe source.\n///"));
    expect(errorCodes(out)).toEqual([]);
    expect(out.html).toBe(
      '<figure class="portal-figure"><blockquote><p>Quoted.</p></blockquote>' +
        '<figcaption class="portal-figcaption"><p>The source.</p></figcaption></figure>',
    );
  });

  it("1.7 attaches inside an admonition instead of ending it", async () => {
    const out = await renderOne(
      "t.md",
      md(":::note[Note]\n![a](../assets/logo.svg)\n/// caption\nInside.\n///\n:::"),
    );
    expect(errorCodes(out)).toEqual([]);
    expect(out.html).toContain(
      '<div class="portal-admonition-body"><figure class="portal-figure">',
    );
    // The admonition's own closing fence must not have been stranded as prose.
    expect(out.html).not.toContain("<p>:::</p>");
  });

  it("1.8 attaches inside a list item", async () => {
    const out = await renderOne(
      "t.md",
      md("- ![a](../assets/logo.svg)\n  /// caption\n  In a list.\n  ///"),
    );
    expect(errorCodes(out)).toEqual([]);
    expect(out.html).toContain('<li><figure class="portal-figure">');
  });
});

describe("2. a caption that cannot attach is refused, never printed", () => {
  it("2.1 refuses a caption with nothing before it", async () => {
    const out = await renderOne("t.md", md("/// caption\nNothing.\n///"));
    expect(codesAt(out)).toEqual(["PC1020@5"]);
    expect(out.html).not.toContain("///");
    expect(out.html).not.toContain("Nothing.");
  });

  it("2.2 refuses a caption after a heading and says what it followed", async () => {
    const out = await renderOne("t.md", md("## Section\n/// caption\nNope.\n///"));
    expect(codesAt(out)).toEqual(["PC1020@6"]);
    expect(out.diagnostics[0]?.message).toContain("heading");
    expect(out.html).not.toContain("Nope.");
  });

  it("2.3 refuses a second caption on one figure", async () => {
    const out = await renderOne(
      "t.md",
      md("![a](../assets/logo.svg)\n/// caption\nOne.\n///\n/// caption\nTwo.\n///"),
    );
    expect(codesAt(out)).toEqual(["PC1020@9"]);
    expect(count(out.html, "<figcaption")).toBe(1);
    expect(out.html).toContain("<p>One.</p>");
    expect(out.html).not.toContain("Two.");
  });

  it("2.4 refuses a second caption on one table", async () => {
    const out = await renderOne(
      "t.md",
      md("| a |\n| - |\n| 1 |\n/// caption\nOne.\n///\n/// caption\nTwo.\n///"),
    );
    expect(errorCodes(out)).toEqual(["PC1020"]);
    expect(count(out.html, "<caption>")).toBe(1);
  });

  it("2.5 refuses an unclosed caption block", async () => {
    const out = await renderOne("t.md", md("![a](../assets/logo.svg)\n/// caption\nNever closed."));
    expect(errorCodes(out)).toEqual(["PC1020"]);
    expect(out.diagnostics[0]?.message).toContain("never closed");
    expect(out.html).not.toContain("///");
  });

  it("2.6 refuses an empty caption block", async () => {
    const out = await renderOne("t.md", md("![a](../assets/logo.svg)\n/// caption\n///"));
    expect(errorCodes(out)).toEqual(["PC1020"]);
    expect(out.html).not.toContain("<figcaption");
  });

  it("2.7 refuses a PyMdown block this profile does not implement", async () => {
    const out = await renderOne("t.md", md("/// tab | One\nBody.\n///"));
    expect(errorCodes(out)).toEqual(["PC1020"]);
    expect(out.diagnostics[0]?.message).toContain("/// tab");
    expect(out.html).not.toContain("///");
  });

  it("2.8 refuses arguments on a caption block", async () => {
    const out = await renderOne(
      "t.md",
      md("![a](../assets/logo.svg)\n/// caption | Title\nBody.\n///"),
    );
    expect(errorCodes(out)).toEqual(["PC1020"]);
    expect(out.html).not.toContain("///");
  });
});

describe("3. the marker is only a marker where a block can start", () => {
  it("3.1 leaves it alone inside a fenced code block", async () => {
    const out = await renderOne("t.md", md("````\n/// caption\nliteral\n///\n````"));
    expect(errorCodes(out)).toEqual([]);
    expect(out.html).toContain("/// caption\nliteral\n///");
  });

  it("3.2 leaves it alone inside an indented code block", async () => {
    const out = await renderOne("t.md", md("    /// caption\n    literal"));
    expect(errorCodes(out)).toEqual([]);
    expect(out.html).toContain('<pre class="portal-code-block"');
    expect(out.html).toContain("/// caption");
  });

  it("3.3 leaves it alone inside inline code", async () => {
    const out = await renderOne("t.md", md("Write `/// caption` under the image."));
    expect(errorCodes(out)).toEqual([]);
    expect(out.html).toBe(
      '<p>Write <code class="portal-code-inline">/// caption</code> under the image.</p>',
    );
  });

  it("3.4 leaves a documented example of the syntax intact", async () => {
    // The page that explains captions has to survive being rendered by the thing it explains.
    const source = [
      "````markdown",
      "![Equal area](example.png)",
      "/// caption",
      "Cells coloured by area.",
      "///",
      "````",
    ].join("\n");
    const out = await renderOne("t.md", md(source));
    expect(errorCodes(out)).toEqual([]);
    expect(out.html).toContain("/// caption");
    expect(count(out.html, "<figcaption")).toBe(0);
  });
});

describe("4. light and dark image pairs", () => {
  const source =
    "![Equal area](../assets/logo.svg#only-light)\n" +
    "![Equal area](../assets/logo.svg#only-dark)\n" +
    "/// caption\nBoth modes.\n///";

  it("4.1 resolves the asset with the display fragment stripped", async () => {
    const out = await renderOne("t.md", md(source));
    // PC1010 is "asset not found": the fragment must not reach the lookup.
    expect(errorCodes(out)).toEqual([]);
  });

  it("4.2 keeps both variants in one figure under one caption", async () => {
    const out = await renderOne("t.md", md(source));
    expect(count(out.html, "<figure")).toBe(1);
    expect(count(out.html, "<figcaption")).toBe(1);
    expect(out.html).toContain('src="/assets/logo.svg#only-light" alt="Equal area"');
    expect(out.html).toContain('src="/assets/logo.svg#only-dark" alt="Equal area"');
  });

  it("4.3 keeps the theme selection in the emitted markup", async () => {
    const out = await renderOne("t.md", md(source));
    expect(out.html).toContain('data-portal-only="light"');
    expect(out.html).toContain('data-portal-only="dark"');
  });

  it("4.4 marks a themed image that has no caption too", async () => {
    const out = await renderOne("t.md", md("![a](../assets/logo.svg#only-dark)"));
    expect(errorCodes(out)).toEqual([]);
    expect(out.html).toContain('data-portal-only="dark"');
  });
});

describe("5. the closed MyST subset", () => {
  it("5.1 renders a figure with every supported option", async () => {
    const source = [
      ":::{figure} ../assets/logo.svg",
      ":alt: A mark",
      ":width: 300px",
      ":align: center",
      ":name: fig-mark",
      "",
      "The caption.",
      "",
      "The legend.",
      ":::",
    ].join("\n");
    const out = await renderOne("t.md", md(source));
    expect(errorCodes(out)).toEqual([]);
    expect(out.html).toBe(
      '<figure class="portal-figure" id="fig-mark" data-portal-align="center">' +
        '<img src="/assets/logo.svg" alt="A mark" loading="lazy" decoding="async" width="300px" />' +
        '<figcaption class="portal-figcaption"><p>The caption.</p></figcaption>' +
        '<div class="portal-figure-legend"><p>The legend.</p></div>' +
        "</figure>",
    );
  });

  it("5.2 reads the backtick-fenced spelling the same way", async () => {
    const out = await renderOne(
      "t.md",
      md("```{figure} ../assets/logo.svg\n:alt: A mark\n\nThe caption.\n```"),
    );
    expect(errorCodes(out)).toEqual([]);
    expect(out.html).toBe(
      '<figure class="portal-figure">' +
        '<img src="/assets/logo.svg" alt="A mark" loading="lazy" decoding="async" />' +
        '<figcaption class="portal-figcaption"><p>The caption.</p></figcaption>' +
        "</figure>",
    );
  });

  it("5.3 refuses an option outside the subset, at its own line", async () => {
    const out = await renderOne(
      "t.md",
      md(":::{figure} ../assets/logo.svg\n:figwidth: 80%\n\nCaption.\n:::"),
    );
    expect(codesAt(out)).toEqual(["PC1020@6"]);
    expect(out.diagnostics[0]?.message).toContain(":figwidth:");
    expect(out.html).not.toContain("figwidth");
  });

  it("5.4 refuses an align value the theme has no meaning for", async () => {
    const out = await renderOne(
      "t.md",
      md(":::{figure} ../assets/logo.svg\n:align: default\n\nCaption.\n:::"),
    );
    expect(errorCodes(out)).toEqual(["PC1020"]);
  });

  it("5.5 refuses a name that would not be a safe id", async () => {
    const out = await renderOne(
      "t.md",
      md(":::{figure} ../assets/logo.svg\n:name: not an id\n\nCaption.\n:::"),
    );
    expect(errorCodes(out)).toEqual(["PC1020"]);
    expect(out.html).not.toContain("id=");
  });

  it("5.6 gives a MyST table a native caption", async () => {
    const out = await renderOne(
      "t.md",
      md(":::{table} Dataset availability\n| a | b |\n| - | - |\n| 1 | 2 |\n:::"),
    );
    expect(errorCodes(out)).toEqual([]);
    expect(out.html).toContain(
      '<table class="portal-table"><caption><p>Dataset availability</p></caption>',
    );
    expect(out.html).not.toContain("<figure");
  });

  it("5.7 refuses a MyST table with no caption on the opening line", async () => {
    const out = await renderOne("t.md", md(":::{table}\n| a |\n| - |\n| 1 |\n:::"));
    expect(errorCodes(out)).toEqual(["PC1020"]);
  });

  it("5.8 refuses an unclosed MyST figure", async () => {
    const out = await renderOne("t.md", md(":::{figure} ../assets/logo.svg\n\nCaption."));
    expect(errorCodes(out)).toEqual(["PC1020"]);
  });
});

describe("6. code block titles", () => {
  it("6.1 puts the title above the code with the copy button", async () => {
    const out = await renderOne("t.md", md('```python title="remap.py"\nx = 1\n```'));
    expect(errorCodes(out)).toEqual([]);
    expect(out.html).toContain(
      '<div class="portal-code-head"><span class="portal-code-title">remap.py</span>' +
        '<span class="portal-code-lang portal-code-lang-secondary">Python</span>' +
        '<button type="button" class="portal-code-copy"',
    );
  });

  it("6.2 copies the author's unmodified source, not the title", async () => {
    const out = await renderOne("t.md", md('```python title="remap.py"\nx = 1\n```'));
    expect(out.html).toContain('data-portal-copy="x = 1"');
  });

  it("6.3 keeps the highlighting a titled block would have had", async () => {
    const plain = await renderOne("t.md", md("```python\nx = 1\n```"));
    const titled = await renderOne("t.md", md('```python title="remap.py"\nx = 1\n```'));
    const tokens = (html: string): string => html.slice(html.indexOf("<pre"));
    expect(tokens(titled.html)).toBe(tokens(plain.html));
  });

  it("6.4 escapes the title text", async () => {
    const out = await renderOne("t.md", md('```python title="a<b>&c.py"\nx = 1\n```'));
    expect(errorCodes(out)).toEqual([]);
    expect(out.html).toContain('<span class="portal-code-title">a&lt;b&gt;&amp;c.py</span>');
  });

  it("6.5 refuses malformed title metadata", async () => {
    const out = await renderOne("t.md", md("```python title=\nx = 1\n```"));
    expect(errorCodes(out)).toEqual(["PC1021"]);
    expect(out.html).not.toContain("portal-code-title");
  });

  it("6.6 refuses a duplicate title", async () => {
    const out = await renderOne("t.md", md('```python title="a.py" title="b.py"\nx = 1\n```'));
    expect(errorCodes(out)).toEqual(["PC1021"]);
  });

  it("6.7 refuses fence metadata that is not a title", async () => {
    const out = await renderOne("t.md", md('```python linenums="1"\nx = 1\n```'));
    expect(errorCodes(out)).toEqual(["PC1021"]);
  });

  it("6.8 lets a title and a caption coexist, as different things", async () => {
    const out = await renderOne(
      "t.md",
      md('```python title="remap.py"\nx = 1\n```\n/// caption\nThe remap step.\n///'),
    );
    expect(errorCodes(out)).toEqual([]);
    expect(out.html).toContain('<span class="portal-code-title">remap.py</span>');
    expect(out.html).toContain(
      '<figcaption class="portal-figcaption"><p>The remap step.</p></figcaption>',
    );
    // The title lives inside the code block; the caption is the figure's.
    expect(out.html.indexOf("portal-code-title")).toBeLessThan(out.html.indexOf("figcaption"));
  });
});

describe("7. RST figures and table titles", () => {
  it("7.1 makes the first paragraph the caption and the rest the legend", async () => {
    const source = [
      ".. figure:: ../assets/logo.svg",
      "   :alt: A mark",
      "   :width: 300px",
      "   :align: center",
      "",
      "   The caption.",
      "",
      "   The legend, paragraph one.",
      "",
      "   And two.",
    ].join("\n");
    const out = await renderOne("t.rst", rst(source));
    expect(errorCodes(out)).toEqual([]);
    expect(out.html).toBe(
      '<figure class="portal-figure" data-portal-align="center">' +
        '<img src="/assets/logo.svg" alt="A mark" loading="lazy" decoding="async" width="300px" />' +
        '<figcaption class="portal-figcaption">The caption.</figcaption>' +
        '<div class="portal-figure-legend"><p>The legend, paragraph one.</p><p>And two.</p></div>' +
        "</figure>",
    );
  });

  it("7.2 leaves an uncaptioned figure without an empty figcaption", async () => {
    const out = await renderOne("t.rst", rst(".. figure:: ../assets/logo.svg\n   :alt: A mark"));
    expect(errorCodes(out)).toEqual([]);
    expect(out.html).not.toContain("<figcaption");
  });

  it("7.3 gives `.. table::` a native caption", async () => {
    const out = await renderOne(
      "t.rst",
      rst(".. table:: Dataset availability\n\n   +---+\n   | a |\n   +---+"),
    );
    expect(errorCodes(out)).toEqual([]);
    expect(out.html).toContain(
      '<table class="portal-table"><caption>Dataset availability</caption>',
    );
    expect(out.html).not.toContain("<figure");
  });

  it("7.4 gives `.. list-table::` a native caption", async () => {
    const out = await renderOne(
      "t.rst",
      rst(
        ".. list-table:: A list table\n   :header-rows: 1\n\n   * - a\n     - b\n   * - 1\n     - 2",
      ),
    );
    expect(errorCodes(out)).toEqual([]);
    expect(out.html).toContain(
      '<table class="portal-table"><caption>A list table</caption><thead>',
    );
  });
});

describe("8. accessibility", () => {
  it("8.1 does not invent a caption from alt text", async () => {
    const out = await renderOne("t.md", md("![Alt text only](../assets/logo.svg)"));
    expect(out.html).toBe(
      '<p><img src="/assets/logo.svg" alt="Alt text only" loading="lazy" decoding="async" /></p>',
    );
  });

  it("8.2 does not invent alt text from a caption", async () => {
    const out = await renderOne(
      "t.md",
      md("![](../assets/logo.svg)\n/// caption\nA caption.\n///"),
    );
    expect(out.html).toContain('alt=""');
    expect(out.html).not.toContain('alt="A caption."');
  });

  it("8.3 does not treat an image title as a caption", async () => {
    const out = await renderOne("t.md", md('![Alt](../assets/logo.svg "A title")'));
    expect(out.html).not.toContain("<figcaption");
  });

  it("8.4 does not treat a code title as a caption", async () => {
    const out = await renderOne("t.md", md('```python title="remap.py"\nx = 1\n```'));
    expect(out.html).not.toContain("<figure");
    expect(out.html).not.toContain("<figcaption");
  });

  it("8.5 associates a caption by containment, and a table caption natively", async () => {
    const image = await renderOne("t.md", md("![a](../assets/logo.svg)\n/// caption\nC.\n///"));
    expect(image.html).toMatch(/^<figure class="portal-figure">.*<figcaption[^>]*>.*<\/figure>$/s);
    const table = await renderOne("t.md", md("| a |\n| - |\n| 1 |\n/// caption\nC.\n///"));
    expect(table.html).toMatch(/^<table[^>]*><caption>/);
  });

  it("8.6 rewrites a link inside a caption like any other link", async () => {
    const out = await renderOne(
      "t.md",
      md("![a](../assets/logo.svg)\n/// caption\nSee [the site](https://example.org/).\n///"),
    );
    expect(errorCodes(out)).toEqual([]);
    expect(out.html).toContain(
      '<a href="https://example.org/" rel="noopener noreferrer">the site</a>',
    );
  });
});

describe("9. the image attribute list", () => {
  it("9.1 sizes and centres a captioned image, and prints no braces", async () => {
    const out = await renderOne(
      "t.md",
      md('![MODIS](../assets/logo.svg){ width="600" .img-center }\n/// caption\nSST.\n///'),
    );
    expect(errorCodes(out)).toEqual([]);
    expect(out.html).toBe(
      '<figure class="portal-figure" data-portal-align="center">' +
        '<img src="/assets/logo.svg" alt="MODIS" loading="lazy" decoding="async" width="600" />' +
        '<figcaption class="portal-figcaption"><p>SST.</p></figcaption>' +
        "</figure>",
    );
  });

  it("9.2 sizes an image that has no caption", async () => {
    const out = await renderOne("t.md", md('![MODIS](../assets/logo.svg){ width="600" }'));
    expect(errorCodes(out)).toEqual([]);
    expect(out.html).toContain('width="600"');
    expect(out.html).not.toContain("{");
  });

  it("9.3 refuses an attribute outside the subset", async () => {
    const out = await renderOne("t.md", md('![a](../assets/logo.svg){ loading="eager" }'));
    expect(errorCodes(out)).toEqual(["PC1020"]);
    expect(out.diagnostics[0]?.message).toContain("loading");
    expect(out.html).not.toContain("{");
  });

  it("9.4 refuses a width that is not a length", async () => {
    const out = await renderOne("t.md", md('![a](../assets/logo.svg){ width="calc(100% - 1px)" }'));
    expect(errorCodes(out)).toEqual(["PC1020"]);
  });

  it("9.5 consumes only the list, keeping the prose after it", async () => {
    const out = await renderOne(
      "t.md",
      md('![a](../assets/logo.svg){ width="600" } and then prose.'),
    );
    expect(errorCodes(out)).toEqual([]);
    expect(out.html).toContain("/> and then prose.</p>");
  });

  it("9.6 leaves braces that are not an attribute list alone", async () => {
    const out = await renderOne("t.md", md("A set like {a, b} in prose."));
    expect(errorCodes(out)).toEqual([]);
    expect(out.html).toBe("<p>A set like {a, b} in prose.</p>");
  });
});
