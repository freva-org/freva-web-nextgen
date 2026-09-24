// RST through the pinned Docutils helper. RST and Markdown meet at one IR: the same anchors,
// the same sanitizer, the same serializer. And the helper's identity is checked rather than
// assumed, so a near-miss helper is refused.

import { afterAll, describe, expect, it } from "vitest";
import { cleanupFixtures } from "../helpers/fixture.js";
import { errorCodes, renderOne } from "../helpers/render.js";
import { RstHelper, RstHelperError } from "../../src/rendering/rst/client.js";
import { loadProfile } from "../../src/rendering/profile.js";

afterAll(cleanupFixtures);

describe("accepted RST", () => {
  it("renders sections, emphasis and literals into the same markup as Markdown", async () => {
    const out = await renderOne("t.rst", "Title\n=====\n\nSome *emphasis* and a ``literal``.\n");
    expect(errorCodes(out)).toEqual([]);
    expect(out.html).toBe(
      '<p>Some <em>emphasis</em> and a <code class="portal-code-inline">literal</code>.</p>',
    );
  });

  it("gives an RST heading the same anchor a Markdown heading would get", async () => {
    const md = await renderOne("a.md", "---\ntitle: T\n---\n\n## Grüße aus Köln\n");
    const rst = await renderOne("b.rst", "T\n=\n\nGrüße aus Köln\n--------------\n");
    expect(rst.headings.map((h) => h.id)).toEqual(md.headings.map((h) => h.id));
  });

  it("renders admonitions, code, mathematics and lists", async () => {
    const out = await renderOne(
      "t.rst",
      `Title
=====

.. note::

   Careful.

.. code:: python

   x = 1

.. math::

   a^2 + b^2 = c^2

* one
* two
`,
    );
    expect(errorCodes(out)).toEqual([]);
    expect(out.html).toContain('class="portal-admonition portal-admonition-note"');
    expect(out.html).toContain('data-portal-language="python"');
    expect(out.html).toContain('class="katex"');
    expect(out.html).toContain("<ul><li><p>one</p></li>");
  });

  it("renders a grid table", async () => {
    const out = await renderOne(
      "t.rst",
      `Title
=====

+-----+-----+
| a   | b   |
+=====+=====+
| 1   | 2   |
+-----+-----+
`,
    );
    expect(errorCodes(out)).toEqual([]);
    expect(out.html).toContain('<table class="portal-table">');
  });
});

describe("rejected RST", () => {
  it.each([
    ["raw", ".. raw:: html\n\n   <script>x</script>\n", "PC1003"],
    ["include", ".. include:: /etc/passwd\n", "PC1003"],
    ["a file-backed csv-table", ".. csv-table::\n   :file: /etc/passwd\n", "PC1003"],
    ["a Sphinx-only directive", ".. toctree::\n\n   other\n", "PC1003"],
    ["a Sphinx domain role", "See :py:func:`x`.\n", "PC1004"],
    ["a download role", "See :download:`x`.\n", "PC1004"],
  ])("rejects %s", async (_name, body, code) => {
    const out = await renderOne("t.rst", `Title\n=====\n\n${body}`);
    expect(errorCodes(out)).toContain(code);
  });

  it("does not treat a directive name inside a literal block as markup", async () => {
    const out = await renderOne("t.rst", "Title\n=====\n\n.. code:: text\n\n   .. raw:: html\n");
    expect(errorCodes(out)).toEqual([]);
  });
});

describe("helper identity", () => {
  it("starts a helper whose whole handshake matches the profile", async () => {
    const { profile } = loadProfile();
    const helper = new RstHelper(profile);
    await helper.start();
    expect(helper.handshake).toEqual({
      protocol: profile.rst.protocol,
      package: profile.rst.helper.package,
      version: profile.rst.helper.version,
      docutils: profile.rst.docutilsVersion,
    });
    helper.stop();
  });

  it("refuses a helper that merely implements a compatible protocol", async () => {
    const { profile } = loadProfile();
    const wrong = {
      ...profile,
      rst: { ...profile.rst, docutilsVersion: "0.0.0-not-the-pin" },
    };
    const helper = new RstHelper(wrong);
    await expect(helper.start()).rejects.toBeInstanceOf(RstHelperError);
  });

  it("reports a source position for an RST diagnostic", async () => {
    const out = await renderOne("t.rst", "Title\n=====\n\n.. raw:: html\n\n   <b>x</b>\n");
    const error = out.diagnostics.find((d) => d.code === "PC1003");
    expect(error?.position?.line).toBe(4);
    expect(error?.file).toBe("content/t.rst");
  });
});
