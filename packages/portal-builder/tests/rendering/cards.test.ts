// Card grids in portal-content-v1: `:::cards`, and Material for MkDocs' own
// `<div class="grid cards" markdown>`, recognized the way `!!!` and `/// caption` are.
//
// The Waterpark Examples gallery is the shape under test: one card per example, each with a
// linked thumbnail, a linked title and the example's first paragraph.

import { deflateSync, crc32 } from "node:zlib";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupFixtures, tempRoot, write, writeSite } from "../helpers/fixture.js";
import { buildFixture } from "../helpers/site.js";
import { errorCodes, renderOne } from "../helpers/render.js";
import { normalizeBlockSyntax } from "../../src/rendering/markdown/block-source.js";
import { loadProfile } from "../../src/rendering/profile.js";

afterAll(cleanupFixtures);

const md = (body: string): string => `---\ntitle: Examples\n---\n\n${body}\n`;
const LOGO = "../assets/logo.svg";
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><title>Mark</title><rect width="16" height="16" fill="#123456"/></svg>`;

/** A real PNG of the given size, one flat colour: what a matplotlib thumbnail is to a browser. */
export function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body) >>> 0, 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x5a)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const render = (body: string) =>
  renderOne("examples.md", md(body), { "assets/logo.svg": LOGO_SVG });

describe("recognizing the spellings", () => {
  const cards = loadProfile().profile.markdown.cardGrid;

  it("rewrites Material's grid into the profile's own directive, and nothing else", () => {
    const out = normalizeBlockSyntax(
      '<div class="grid cards" markdown>\n\n-   a\n-   b\n\n</div>\n',
      cards,
    );
    expect(out.problems).toEqual([]);
    expect(out.text).toContain(":::cards");
    expect(out.text).not.toContain("<div");
  });

  it('leaves `<div class="grid cards">` inside a code fence alone', () => {
    const source = '```markdown\n<div class="grid cards" markdown>\n- a\n</div>\n```\n';
    expect(normalizeBlockSyntax(source, cards).text).toBe(source);
  });

  it("does not end the grid at a `</div>` inside a card's code example", async () => {
    // A fenced `</div>` inside a card is code, not the grid's end (else the real `</div>` is left
    // over as raw HTML: PC1002).
    const source = [
      '<div class="grid cards" markdown>',
      "",
      "-   **[Embedding](https://example.org/embed)**",
      "",
      "    Close the wrapper yourself:",
      "",
      "    ```html",
      "    </div>",
      "    ```",
      "",
      "-   **[Second](https://example.org/two)**",
      "",
      "    ````markdown",
      '    <div class="grid cards" markdown>',
      "    ```",
      "    </div>",
      "    ````",
      "",
      "</div>",
      "",
    ].join("\n");
    const out = normalizeBlockSyntax(source, cards);
    expect(out.problems).toEqual([]);
    const outcome = await render(source);
    expect(errorCodes(outcome)).toEqual([]);
    expect(outcome.html.match(/<li class="portal-cardgrid-card">/g)).toHaveLength(2);
    // The examples are code, verbatim, inside their cards.
    expect(outcome.html).toContain("&lt;/div&gt;");
    expect(outcome.html).toContain("Close the wrapper yourself");
  });

  it("does not end the grid at a `</div>` in a card's indented code example", async () => {
    // Likewise indented code: eight columns in a card whose content starts at four is code, and its
    // `</div>` is text, not the grid's closing tag.
    const cardsBody = [
      "-   **[Embedding](https://example.org/embed)**",
      "",
      "    Close the wrapper yourself:",
      "",
      '        <div class="grid cards" markdown>',
      "        </div>",
      "",
      "    Then carry on.",
      "",
      "-   **[Second](https://example.org/two)**",
      "",
      "    ## Heading",
      "        </div>",
      "",
      "-   **[Third](https://example.org/three)**",
      "",
      "    Nested:",
      "",
      "    -   item",
      "",
      "            </div>",
    ];
    const material = ['<div class="grid cards" markdown>', "", ...cardsBody, "", "</div>", ""].join(
      "\n",
    );
    const native = [":::cards", ...cardsBody, ":::", ""].join("\n");
    expect(
      normalizeBlockSyntax(material, loadProfile().profile.markdown.cardGrid).problems,
    ).toEqual([]);
    const [fromMaterial, fromNative] = await Promise.all([render(material), render(native)]);
    for (const outcome of [fromMaterial, fromNative]) {
      expect(errorCodes(outcome)).toEqual([]);
      expect(outcome.html.match(/<li class="portal-cardgrid-card">/g)).toHaveLength(3);
      expect(outcome.html.match(/<pre/g)).toHaveLength(3);
      expect(outcome.html).toContain('&lt;div class="grid cards" markdown&gt;');
      expect(outcome.html).toContain("Then carry on.");
    }
    // The two spellings are one grid.
    expect(fromMaterial.html).toBe(fromNative.html);
  });

  it("does not end the grid at a `</div>` in top-level indented code inside it", () => {
    const source = [
      '<div class="grid cards" markdown>',
      "",
      "-   a",
      "",
      "Outside the list:",
      "",
      "    </div>",
      "",
      "</div>",
      "",
    ].join("\n");
    const out = normalizeBlockSyntax(source, loadProfile().profile.markdown.cardGrid);
    expect(out.problems).toEqual([]);
    expect(out.text).not.toMatch(/^<\/div>$/m);
    expect(out.text).toContain("    </div>");
  });

  it("names a near miss instead of printing it", () => {
    const out = normalizeBlockSyntax('<div class="grid" markdown>\n\n- a\n\n</div>\n', cards);
    expect(out.problems.map((p) => p.code)).toEqual(["PC1023"]);
    expect(out.problems[0]!.message).toContain('class="grid"');
  });

  it("leaves a div without `markdown` to the raw-HTML refusal", async () => {
    const outcome = await render('<div class="grid cards">\n\n- a\n\n</div>');
    expect(errorCodes(outcome)).toContain("PC1002");
  });
});

describe("the Material shape", () => {
  it("reads image, title and summary, in one paragraph or three", async () => {
    const outcome = await render(`<div class="grid cards" markdown>

-   [![](${LOGO})](https://example.org/one)
    **[A map of one month](https://example.org/one)**
    First paragraph of the example.

-   [![](${LOGO})](https://example.org/two)

    **[A zonal mean](https://example.org/two)**

    ---

    Second example, with [a link](https://example.org/data).

</div>`);
    expect(errorCodes(outcome)).toEqual([]);
    const html = outcome.html;
    expect(html).toContain('<ul class="portal-cardgrid" role="list">');
    expect(html.match(/<li class="portal-cardgrid-card">/g)).toHaveLength(2);
    // One link per destination: the image is unlinked because the title carries the link.
    expect(html.match(/href="https:\/\/example.org\/one"/g)).toHaveLength(1);
    expect(html).toMatch(
      /<div class="portal-cardgrid-media"><img src="\/assets\/logo.svg" alt="" loading="lazy" decoding="async"\s*\/?><\/div><p class="portal-cardgrid-title"><a href="https:\/\/example.org\/one"[^>]*>A map of one month<\/a><\/p><div class="portal-cardgrid-body"><p>First paragraph of the example.<\/p><\/div>/,
    );
    // The `---` between title and summary is a separator, not an <hr> in the card.
    expect(html).not.toContain("<hr");
    expect(html).toContain('href="https://example.org/data"');
    // No inline styles, no headings (a card title is not a TOC entry).
    expect(html).not.toMatch(/style=/);
    expect(outcome.headings).toEqual([]);
  });

  it("keeps an image link that goes somewhere else than the title", async () => {
    const outcome = await render(`:::cards
-   [![Preview](${LOGO})](https://example.org/image)
    **[Title](https://example.org/page)**
:::`);
    expect(errorCodes(outcome)).toEqual([]);
    expect(outcome.html).toContain('href="https://example.org/image"');
    expect(outcome.html).toContain('href="https://example.org/page"');
    expect(outcome.html).toContain('alt="Preview"');
  });

  it.each([
    ["a title linked elsewhere", "**[Title](https://example.org/page)**"],
    ["an unlinked title", "**Title**"],
  ])(
    "refuses a thumbnail with its own link and no alt text beside %s",
    async (_what, titleLine) => {
      // The title names its own destination, not the image's: `<a href="…/image"><img alt=""></a>`
      // would be a link with no accessible name.
      for (const open of ['<div class="grid cards" markdown>\n\n', ":::cards\n"]) {
        const close = open.startsWith("<div") ? "\n\n</div>" : "\n:::";
        const outcome = await render(
          `${open}-   [![](${LOGO})](https://example.org/image)\n    ${titleLine}${close}`,
        );
        expect(errorCodes(outcome)).toContain("PC1023");
        expect(outcome.diagnostics.map((d) => d.message).join(" ")).toMatch(/needs alt text/);
        expect(outcome.html).not.toMatch(/<a [^>]*><img [^>]*alt=""/);
      }
    },
  );

  it("still treats an unlinked thumbnail under a title as decorative", async () => {
    const outcome = await render(`:::cards
-   ![](${LOGO})
    **[Title](https://example.org/page)**
:::`);
    expect(errorCodes(outcome)).toEqual([]);
    expect(outcome.diagnostics.map((d) => d.code)).not.toContain("PC1014");
    expect(outcome.html).toContain(
      '<div class="portal-cardgrid-media"><img src="/assets/logo.svg" alt=""',
    );
  });
});

describe("the native directive", () => {
  it("accepts title-only and text-only cards", async () => {
    const outcome = await render(`:::cards
- **[Only a title](https://example.org/)**
- Just text in a card.
:::`);
    expect(errorCodes(outcome)).toEqual([]);
    expect(outcome.html).toContain(
      '<p class="portal-cardgrid-title"><a href="https://example.org/"',
    );
    expect(outcome.html).toContain('<div class="portal-cardgrid-body"><p>Just text in a card.</p>');
  });

  it("does not take emphasis inside a sentence for a title", async () => {
    const outcome = await render(":::cards\n- **Note** that this is a sentence.\n:::");
    expect(outcome.html).not.toContain("portal-cardgrid-title");
  });

  it.each([
    ["a body that is not one list", ":::cards\nA paragraph.\n:::", /one Markdown list/],
    ["a title on the directive", ":::cards[Examples]\n- a\n:::", /no title/],
    ["an attribute", ':::cards{cols="3"}\n- a\n:::', /no attribute but `columns`/],
    [
      "a linked image with no name",
      `:::cards\n- [![](${LOGO})](https://example.org/)\n:::`,
      /needs alt text/,
    ],
    ["a task item", ":::cards\n- [x] done\n:::", /task-list/],
  ])("refuses %s with PC1023", async (_what, body, message) => {
    const outcome = await render(body);
    expect(errorCodes(outcome)).toContain("PC1023");
    expect(outcome.diagnostics.map((d) => d.message).join(" ")).toMatch(message);
  });
});

describe("a column hint", () => {
  it.each([
    [":::cards{columns=2}", 2],
    [':::cards{columns="3"}', 3],
    [":::cards{columns=4}", 4],
  ])("`%s` becomes a class, the most columns the grid may use", async (open, n) => {
    const outcome = await render(`${open}\n- **[A](https://example.org/)**\n:::`);
    expect(errorCodes(outcome)).toEqual([]);
    expect(outcome.html).toContain(
      `<ul class="portal-cardgrid portal-cardgrid-max-${n}" role="list">`,
    );
    // A class, never a style: the page's policy has no `style-src 'unsafe-inline'` to spend.
    expect(outcome.html).not.toMatch(/style=/);
  });

  it("is spelled as a class in Material's form", async () => {
    const outcome = await render(
      '<div class="grid cards cols-3" markdown>\n\n-   **[A](https://example.org/)**\n\n</div>',
    );
    expect(errorCodes(outcome)).toEqual([]);
    expect(outcome.html).toContain('<ul class="portal-cardgrid portal-cardgrid-max-3"');
  });

  it("without a hint, the grid has none", async () => {
    const outcome = await render(":::cards\n- **[A](https://example.org/)**\n:::");
    expect(outcome.html).toContain('<ul class="portal-cardgrid" role="list">');
  });

  it.each([
    ["columns=5", ":::cards{columns=5}\n- a\n:::", /columns=5.*not a column hint/],
    ["columns=two", ":::cards{columns=two}\n- a\n:::", /not a column hint/],
    ["an empty columns=", ":::cards{columns}\n- a\n:::", /not a column hint/],
    [
      "cols-5",
      '<div class="grid cards cols-5" markdown>\n\n-   a\n\n</div>',
      /cols-5.*not a column hint/,
    ],
    [
      "two hints",
      '<div class="grid cards cols-2 cols-3" markdown>\n\n-   a\n\n</div>',
      /not a column hint/,
    ],
  ])("refuses %s with PC1023", async (_what, body, message) => {
    const outcome = await render(body);
    expect(errorCodes(outcome)).toContain("PC1023");
    expect(outcome.diagnostics.map((d) => d.message).join(" ")).toMatch(message);
  });
});

describe("the Waterpark Examples gallery", () => {
  it("builds 8 cards with 520px PNG thumbnails, linked to their pages", async () => {
    const root = tempRoot("cards-gallery-");
    const titles = [
      "A map of one month",
      "A zonal mean",
      "A time series",
      "Regridding",
      "Healpix levels",
      "Comparing runs",
      "Precipitation",
      "Ocean heat",
    ];
    const content: Record<string, string> = {};
    const items: string[] = [];
    titles.forEach((title, index) => {
      const name = `${String(index + 1).padStart(2, "0")}_example`;
      content[`content/examples/${name}.md`] = `---\ntitle: ${title}\n---\n\n# ${title}\n\nText.\n`;
      items.push(
        `-   [![](${name}.png)](${name}.md)\n` +
          `    **[${title}](${name}.md)**\n` +
          `    The first paragraph of ${title.toLowerCase()}.\n`,
      );
    });
    content["content/examples/index.md"] =
      `---\ntitle: Examples\n---\n\n<div class="grid cards" markdown>\n\n${items.join("\n")}\n</div>\n`;
    writeSite(root, {
      content,
      extra: `rendering:
  profile: portal-content-v1
  sources:
    - root: ./content
      mount: /docs/
  assets:
    - root: ./content/examples
      mount: /docs/examples/
      files:
        include: ["*.png"]
`,
    });
    titles.forEach((_title, index) =>
      write(root, `content/examples/${String(index + 1).padStart(2, "0")}_example.png`, ""),
    );
    // Real PNG bytes, written after `write` created the directory.
    const { writeFileSync } = await import("node:fs");
    titles.forEach((_title, index) =>
      writeFileSync(
        join(root, "content", "examples", `${String(index + 1).padStart(2, "0")}_example.png`),
        png(520, 325),
      ),
    );

    const out = join(tempRoot("cards-gallery-out-"), "site");
    const result = await buildFixture(root, out);
    expect(result.diagnostics.errors).toEqual([]);
    const html = readFileSync(join(out, "docs", "examples", "index.html"), "utf8");
    expect(html.match(/<li class="portal-cardgrid-card">/g)).toHaveLength(8);
    expect(html).toContain('<img src="/docs/examples/01_example.png" alt=""');
    expect(html).toContain('<a href="/docs/examples/01_example/"');
    // Each destination is linked once per card. (The section rail links it too, outside the grid.)
    const grid = html.slice(
      html.indexOf('<ul class="portal-cardgrid"'),
      html.indexOf("</ul>", html.indexOf('<ul class="portal-cardgrid"')),
    );
    expect(grid.match(/href="\/docs\/examples\/01_example\/"/g)).toHaveLength(1);
    expect(html).not.toContain("&lt;div");
  }, 300_000);
});
