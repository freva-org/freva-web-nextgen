// Golden Markdown behaviour for `portal-content-v1`. These assert the *exact* markup, not "a
// browser draws it the same": two conforming implementations must produce the same bytes from
// the same IR, and an assertion on rendered appearance would not catch the day that stops being
// true.

import { afterAll, describe, expect, it } from "vitest";
import { cleanupFixtures } from "../helpers/fixture.js";
import { errorCodes, renderOne } from "../helpers/render.js";

afterAll(cleanupFixtures);

const page = (body: string): string => `---\ntitle: Test\n---\n\n${body}\n`;

describe("accepted constructs", () => {
  it("renders paragraphs, emphasis and inline code", async () => {
    const out = await renderOne("t.md", page("A *b* **c** `d` ~~e~~."));
    expect(out.html).toBe(
      '<p>A <em>b</em> <strong>c</strong> <code class="portal-code-inline">d</code> <del>e</del>.</p>',
    );
  });

  it("gives headings stable, Unicode-aware anchors", async () => {
    const out = await renderOne("t.md", page("## Grüße aus Köln\n\n## Grüße aus Köln\n\n## ---"));
    expect(out.headings.map((h) => h.id)).toEqual([
      "gruße-aus-koln",
      "gruße-aus-koln-2",
      "section",
    ]);
  });

  it("renders a named admonition into the theme's own structure", async () => {
    const out = await renderOne("t.md", page(":::warning[Careful]\nBody.\n:::"));
    expect(out.html).toBe(
      '<aside class="portal-admonition portal-admonition-warning" role="note">' +
        '<p class="portal-admonition-title">' +
        '<span class="portal-admonition-icon" aria-hidden="true"></span>Careful</p>' +
        '<div class="portal-admonition-body"><p>Body.</p></div></aside>',
    );
  });

  it("renders an unknown but safe admonition through the neutral fallback", async () => {
    // Losing the content, dropping it to plain text or failing the build are all worse than
    // rendering it as a note and saying so.
    const out = await renderOne("t.md", page(":::musing[On reflection]\nBody.\n:::"));
    expect(errorCodes(out)).toEqual([]);
    expect(out.diagnostics.map((d) => d.code)).toContain("PC1017");
    expect(out.html).toContain('class="portal-admonition portal-admonition-note"');
    expect(out.html).toContain("On reflection");
    expect(out.html).toContain("<p>Body.</p>");
  });

  it("titles an untitled admonition from its own kind", async () => {
    const out = await renderOne("t.md", page(":::danger\nBody.\n:::"));
    expect(errorCodes(out)).toEqual([]);
    expect(out.html).toContain('class="portal-admonition portal-admonition-danger"');
    expect(out.html).toContain("Danger</p>");
  });

  it("renders a collapsible admonition as a real disclosure", async () => {
    const out = await renderOne("t.md", page('??? tip "Later"\n    Body.'));
    expect(errorCodes(out)).toEqual([]);
    expect(out.html).toContain(
      '<details class="portal-admonition portal-admonition-tip portal-admonition-collapsible">',
    );
    expect(out.html).toContain('<summary class="portal-admonition-title">');
    expect(out.html).not.toContain("<details open");

    const open = await renderOne("t.md", page('???+ tip "Later"\n    Body.'));
    expect(open.html).toContain(" open>");
  });

  it("nests an admonition inside another without stranding a fence", async () => {
    // The outer fence has to be the longer one: a container directive is closed by the first
    // fence at least as long as its opener, so an inner `::::` closes the outer block and leaves
    // its real closer as literal text.
    const source = '!!! question "Outer"\n    Body.\n\n    !!! info "Inner"\n        Nested body.';
    const out = await renderOne("t.md", page(source));
    expect(errorCodes(out)).toEqual([]);
    expect(out.html).not.toContain(":::");
    const outer = out.html.indexOf("portal-admonition-question");
    const inner = out.html.indexOf("portal-admonition-info");
    expect(outer).toBeGreaterThanOrEqual(0);
    expect(inner).toBeGreaterThan(outer);
    expect(out.html).toContain("Nested body.");
  });

  it("accepts the MkDocs, MyST and GitHub spellings as the same thing", async () => {
    const sources = [
      '!!! warning "Careful"\n    Body.',
      ":::{warning}\nBody.\n:::",
      "> [!WARNING]\n> Body.",
    ];
    for (const source of sources) {
      const out = await renderOne("t.md", page(source));
      expect(errorCodes(out)).toEqual([]);
      expect(out.html).toContain("portal-admonition-warning");
      expect(out.html).toContain("Body.");
    }
  });

  it("emits a passive task list with no form control", async () => {
    const out = await renderOne("t.md", page("- [x] done\n- [ ] todo"));
    expect(out.html).not.toContain("<input");
    expect(out.html).toContain('<li data-portal-task="done">');
    expect(out.html).toContain('<span class="portal-visually-hidden">Completed:</span>');
    expect(out.html).toContain('<li data-portal-task="todo">');
  });

  it("renders GFM tables with alignment, a real head and a real body", async () => {
    const out = await renderOne("t.md", page("| a | b |\n| :-- | --: |\n| 1 | 2 |"));
    expect(out.html).toContain("<thead><tr>");
    expect(out.html).toContain('<th align="left" scope="col">a</th>');
    expect(out.html).toContain("<tbody><tr>");
    expect(out.html).toContain('<td align="right">2</td>');
  });

  it("normalizes a bare www autolink to HTTPS before validating it", async () => {
    const out = await renderOne("t.md", page("See www.example.org for more."));
    expect(errorCodes(out)).toEqual([]);
    expect(out.html).toContain('href="https://www.example.org"');
    expect(out.html).not.toContain("http://www.");
  });

  it("refuses an explicitly authored http:// link that merely looks like one", async () => {
    // The profile normalizes the *bare autolink* form only: an author who wrote `http://`
    // meant `http://`, and plain HTTP is not an accepted scheme.
    const out = await renderOne("t.md", page("[site](http://www.example.org/)"));
    expect(errorCodes(out)).toContain("PC1007");
  });

  it("refuses an authored http:// autolink in angle brackets", async () => {
    const out = await renderOne("t.md", page("<http://www.example.org/>"));
    expect(errorCodes(out)).toContain("PC1007");
  });

  it("adds the profile's rel policy to external links only", async () => {
    const out = await renderOne(
      "t.md",
      page("[x](https://example.org/) and [y](/assets/logo.svg)"),
    );
    expect(out.html).toContain('<a href="https://example.org/" rel="noopener noreferrer">x</a>');
    expect(out.html).toContain('<a href="/assets/logo.svg">y</a>');
  });

  it("highlights a known language into classes, never inline styles", async () => {
    const out = await renderOne("t.md", page("```python\nx = 1\n```"));
    expect(out.html).toContain('<pre class="portal-code-block" data-portal-language="python">');
    expect(out.html).not.toContain("style=");
    // One class per light/dark colour pair, so a theme switch repaints the code without a
    // second tokenization at runtime.
    expect(out.codeCss).toMatch(/\.portal-code-c[0-9a-f]+\{color:#[0-9a-f]{6}\}/);
    expect(out.codeCss).toMatch(
      /:root\[data-theme="dark"\] \.portal-code-c[0-9a-f]+\{color:#[0-9a-f]{6}\}/,
    );
  });

  it("names the language beside the code", async () => {
    // The name is written from the language the highlighter resolved, so it cannot disagree
    // with the colours - `sh` is labelled Bash.
    const out = await renderOne("t.md", page("```sh\necho hi\n```"));
    expect(out.html).toContain('<div class="portal-code-head">');
    expect(out.html).toContain('<span class="portal-code-lang">Bash</span>');
    const typescript = await renderOne("t.md", page("```ts\nconst a = 1;\n```"));
    expect(typescript.html).toContain('<span class="portal-code-lang">TypeScript</span>');
    // A fence with no language says so rather than guessing one.
    const bare = await renderOne("t.md", page("```\nplain\n```"));
    expect(bare.html).toContain('<span class="portal-code-lang">Text</span>');
  });

  it("gives every heading its own permalink", async () => {
    const out = await renderOne("t.md", page("## A section"));
    expect(out.html).toContain(
      '<h2 id="a-section">A section' +
        '<a class="portal-heading-anchor" href="#a-section" ' +
        'aria-label="Permanent link to A section">#</a></h2>',
    );
  });

  it("wraps a block snippet in a copy control that carries the raw source", async () => {
    const out = await renderOne("t.md", page("```python\nx = 1\n```"));
    expect(out.html).toContain('<div class="portal-code-figure" data-portal-code="python">');
    expect(out.html).toContain('class="portal-code-copy"');
    expect(out.html).toContain('data-portal-copy="x = 1"');
    expect(out.html).toContain('aria-label="Copy code"');
    // Hidden until the client can copy: a control that cannot work is worse than none.
    expect(out.html).toContain("hidden>");
  });

  it("resolves a language alias without inventing a language", async () => {
    const alias = await renderOne("t.md", page("```py\nx = 1\n```"));
    expect(alias.html).toContain('data-portal-language="python"');
    const shell = await renderOne("t.md", page("```sh\necho hi\n```"));
    expect(shell.html).toContain('data-portal-language="bash"');
  });

  it("warns about an unknown language and escapes the code", async () => {
    const out = await renderOne("t.md", page("```nosuchlang\n<script>x</script>\n```"));
    expect(out.diagnostics.map((d) => d.code)).toContain("PC1013");
    expect(out.html).toContain("&lt;script&gt;");
  });

  it("renders mathematics at build time", async () => {
    const out = await renderOne("t.md", page("Inline $x^2$ and\n\n$$\na+b\n$$"));
    expect(errorCodes(out)).toEqual([]);
    expect(out.html).toContain('class="katex"');
    expect(out.html).toContain('<div class="portal-math-block">');
  });

  it("renders footnotes", async () => {
    const out = await renderOne("t.md", page("Text.[^a]\n\n[^a]: Note."));
    expect(errorCodes(out)).toEqual([]);
    expect(out.html).toContain('class="portal-footnote-ref"');
  });

  it("resolves a relative link to another page's route", async () => {
    const out = await renderOne("guide.md", page("[ref](./reference.md)"), {
      "content/reference.md": "---\ntitle: Reference\n---\n",
    });
    expect(errorCodes(out)).toEqual([]);
    expect(out.html).toContain('href="/docs/reference/"');
  });

  it("resolves a relative image to its published asset URL", async () => {
    const out = await renderOne("t.md", page("![Mark](../assets/logo.svg)"), {
      "assets/logo.svg": "<svg xmlns='http://www.w3.org/2000/svg'></svg>",
    });
    expect(errorCodes(out)).toEqual([]);
    expect(out.html).toContain(
      '<img src="/assets/logo.svg" alt="Mark" loading="lazy" decoding="async" />',
    );
  });

  it("produces identical bytes for the same source twice", async () => {
    const source = page("## Heading\n\n```python\nx = 1\n```\n\n$$a+b$$");
    const first = await renderOne("t.md", source);
    const second = await renderOne("t.md", source);
    expect(first.html).toBe(second.html);
  });
});

describe("rejected constructs", () => {
  it.each([
    ["raw HTML", "<div>nope</div>", "PC1002"],
    ["a leaf directive", "::video[x]", "PC1001"],
    ["a javascript: URL", "[x](javascript:alert(1))", "PC1007"],
    ["a vbscript: URL", "[x](vbscript:msgbox)", "PC1007"],
    ["a file: URL", "[x](file:///etc/passwd)", "PC1007"],
    ["an unapproved data: URL", "[x](data:text/html;base64,PHNjcmlwdD4=)", "PC1007"],
    ["a missing internal page", "[x](./nope.md)", "PC1008"],
    ["a missing asset", "![x](../assets/nope.png)", "PC1010"],
    ["a remote image", "![x](https://cdn.example.org/x.png)", "PC1010"],
    ["a missing fragment", "[x](#nowhere)", "PC1009"],
    ["invalid mathematics", "$\\nosuchcommand{x}$", "PC1011"],
  ])("rejects %s", async (_name, body, code) => {
    const out = await renderOne("t.md", page(body));
    expect(errorCodes(out)).toContain(code);
  });

  it("rejects a page with neither frontmatter title nor level-one heading", async () => {
    const out = await renderOne("t.md", "Just a paragraph.\n");
    expect(errorCodes(out)).toContain("PC1006");
  });

  it("rejects an unknown frontmatter key", async () => {
    const out = await renderOne("t.md", "---\ntitle: T\nauthor: nobody\n---\n");
    expect(errorCodes(out)).toContain("PC1005");
  });

  it("warns about an image with no alternative text", async () => {
    const out = await renderOne("t.md", page("![](../assets/logo.svg)"), {
      "assets/logo.svg": "<svg xmlns='http://www.w3.org/2000/svg'></svg>",
    });
    expect(out.diagnostics.map((d) => d.code)).toContain("PC1014");
  });
});
