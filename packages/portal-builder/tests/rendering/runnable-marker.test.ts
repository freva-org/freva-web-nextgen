// `try-in-python`: what it marks, what it refuses, and what it leaves alone. The last matters
// most: a portal that never asked for the playground must emit plain code-block HTML - not
// "equivalent markup", not "the same plus an empty wrapper" - so several checks compare bytes.
import { describe, expect, it } from "vitest";
import { errorCodes, renderOne } from "../helpers/render.js";

const RUNNABLE = [
  "```python try-in-python",
  "import xarray as xr",
  "print(xr.__version__)",
  "```",
].join("\n");

describe("1. the Markdown marker", () => {
  it("draws Copy first and Try in Python second, on a marked block", async () => {
    const out = await renderOne("guide.md", `# Guide\n\n${RUNNABLE}\n`, {}, { runnable: true });
    expect(errorCodes(out)).toEqual([]);
    expect(out.html).toContain('class="portal-code-actions"');
    const copy = out.html.indexOf("portal-code-copy");
    const run = out.html.indexOf("portal-code-run");
    expect(copy).toBeGreaterThan(-1);
    expect(run).toBeGreaterThan(copy);
    // Hidden, exactly as Copy is: with no script there is nothing behind either of them.
    expect(out.html).toMatch(/class="portal-code-run"[^>]*hidden>/);
    expect(out.html).toContain('aria-label="Try this code in Python"');
  });

  it("sends a name and a digest, and never the source, on the run control", async () => {
    const out = await renderOne("guide.md", `# Guide\n\n${RUNNABLE}\n`, {}, { runnable: true });
    expect(out.html).toContain('data-portal-example="content:content/guide.md#1"');
    expect(out.html).toMatch(/data-portal-digest="[0-9a-f]{64}"/);
    // The exact source is in the copy control, where the author put it, and nowhere else.
    expect(out.html.match(/data-portal-copy="/g)).toHaveLength(1);
  });

  it("computes a lowercase SHA-256 over the exact authored bytes", async () => {
    const out = await renderOne("guide.md", `# Guide\n\n${RUNNABLE}\n`, {}, { runnable: true });
    const source = "import xarray as xr\nprint(xr.__version__)";
    const { createHash } = await import("node:crypto");
    const expected = createHash("sha256").update(source, "utf8").digest("hex");
    expect(out.runnable?.[0]?.sha256).toBe(expected);
    expect(expected).toBe(expected.toLowerCase());
    expect(out.html).toContain(`data-portal-digest="${expected}"`);
  });

  it("accepts a title and the marker in either order, and keeps both meanings", async () => {
    const first = await renderOne(
      "guide.md",
      '# Guide\n\n```python try-in-python title="quickstart.py"\nx = 1\n```\n',
      {},
      { runnable: true },
    );
    const second = await renderOne(
      "guide.md",
      '# Guide\n\n```python title="quickstart.py" try-in-python\nx = 1\n```\n',
      {},
      { runnable: true },
    );
    expect(errorCodes(first)).toEqual([]);
    expect(errorCodes(second)).toEqual([]);
    expect(first.html).toBe(second.html);
    expect(first.html).toContain('<span class="portal-code-title">quickstart.py</span>');
    expect(first.html).toContain("data-portal-run");
    // The author's title becomes the terminal's divider, rather than a derived one.
    expect(first.runnable?.[0]?.title).toBe("quickstart.py");
  });

  it("derives a deterministic readable title when the author gave none", async () => {
    const out = await renderOne(
      "reference/api.md",
      `# API\n\n${RUNNABLE}\n`,
      {},
      { runnable: true },
    );
    expect(out.runnable?.[0]?.title).toBe("api.md · block 1");
  });

  it("numbers ids by code-block occurrence, so an unmarked block still counts", async () => {
    const source = [
      "# Guide",
      "",
      "```text",
      "not python",
      "```",
      "",
      RUNNABLE,
      "",
      "```python try-in-python",
      "y = 2",
      "```",
    ].join("\n");
    const out = await renderOne("guide.md", `${source}\n`, {}, { runnable: true });
    expect(out.runnable?.map((example) => example.id)).toEqual([
      "content:content/guide.md#2",
      "content:content/guide.md#3",
    ]);
  });

  it("escapes a path so two sources cannot compose into one id", async () => {
    const out = await renderOne("odd%name.md", `# Odd\n\n${RUNNABLE}\n`, {}, { runnable: true });
    expect(out.runnable?.[0]?.id).toBe("content:content/odd%25name.md#1");
  });
});

describe("2. the marker's refusals", () => {
  it("refuses the marker on a language that is not Python", async () => {
    const out = await renderOne(
      "guide.md",
      "# Guide\n\n```bash try-in-python\nls\n```\n",
      {},
      { runnable: true },
    );
    expect(errorCodes(out)).toEqual(["PC1022"]);
    expect(out.html).not.toContain("data-portal-run");
  });

  it("refuses a duplicated marker rather than ignoring the second one", async () => {
    const out = await renderOne(
      "guide.md",
      "# Guide\n\n```python try-in-python try-in-python\nx = 1\n```\n",
      {},
      { runnable: true },
    );
    expect(errorCodes(out)).toEqual(["PC1022"]);
  });

  it("refuses an empty runnable block", async () => {
    const out = await renderOne(
      "guide.md",
      "# Guide\n\n```python try-in-python\n\n```\n",
      {},
      { runnable: true },
    );
    expect(errorCodes(out)).toEqual(["PC1022"]);
  });

  it("still refuses fence metadata that is neither a title nor the marker", async () => {
    const out = await renderOne(
      "guide.md",
      '# Guide\n\n```python linenums="1"\nx = 1\n```\n',
      {},
      { runnable: true },
    );
    expect(errorCodes(out)).toEqual(["PC1021"]);
  });

  it("names both accepted spellings in the refusal, so the message is actionable", async () => {
    const out = await renderOne(
      "guide.md",
      "# Guide\n\n```python nonsense\nx = 1\n```\n",
      {},
      { runnable: true },
    );
    const message = out.diagnostics.find((d) => d.code === "PC1021");
    expect(message?.hint).toContain("try-in-python");
  });
});

describe("3. what an unmarked block still is", () => {
  const PLAIN = "# Guide\n\n```python\nx = 1\n```\n";

  it("is byte-for-byte what it was before the capability existed", async () => {
    const off = await renderOne("guide.md", PLAIN);
    const on = await renderOne("guide.md", PLAIN, {}, { runnable: true });
    expect(on.html).toBe(off.html);
    expect(on.html).toContain(
      '<div class="portal-code-head"><span class="portal-code-lang">Python</span>' +
        '<button type="button" class="portal-code-copy" data-portal-copy="x = 1" ' +
        'aria-label="Copy code" hidden>',
    );
    // No wrapper was added for the sake of the runnable case.
    expect(on.html).not.toContain("portal-code-actions");
  });

  it("keeps a marked block Copy-only when the portal has no playground", async () => {
    const out = await renderOne("guide.md", `# Guide\n\n${RUNNABLE}\n`);
    expect(errorCodes(out)).toEqual([]);
    expect(out.html).not.toContain("data-portal-run");
    expect(out.html).not.toContain("portal-code-actions");
    expect(out.runnable).toBeUndefined();
    // And it is the ordinary head, unchanged by the feature.
    expect(out.html).toContain(
      '<div class="portal-code-head"><span class="portal-code-lang">Python</span><button',
    );
  });

  it("copies the author's exact source, marker or no marker", async () => {
    const on = await renderOne("guide.md", `# Guide\n\n${RUNNABLE}\n`, {}, { runnable: true });
    // Verbatim, newline and all: the serializer does not re-wrap or re-escape the author's text.
    expect(on.html).toContain('data-portal-copy="import xarray as xr\nprint(xr.__version__)"');
  });
});

describe("4. the RST lane says the same thing", () => {
  it("reads `:try-in-python:` on a code-block and marks it", async () => {
    const out = await renderOne(
      "guide.rst",
      [
        "Guide",
        "=====",
        "",
        ".. code-block:: python",
        "   :try-in-python:",
        "",
        "   import xarray as xr",
        "   print(xr.__version__)",
        "",
      ].join("\n"),
      {},
      { runnable: true },
    );
    expect(errorCodes(out)).toEqual([]);
    expect(out.html).toContain("data-portal-run");
    expect(out.runnable?.[0]?.id).toBe("content:content/guide.rst#1");
  });

  it("refuses the option on a language that is not Python, with the same code", async () => {
    const out = await renderOne(
      "guide.rst",
      ["Guide", "=====", "", ".. code-block:: bash", "   :try-in-python:", "", "   ls", ""].join(
        "\n",
      ),
      {},
      { runnable: true },
    );
    expect(errorCodes(out)).toEqual(["PC1022"]);
    expect(out.html).not.toContain("data-portal-run");
  });

  it("leaves an unmarked RST code block exactly as it was", async () => {
    const source = ["Guide", "=====", "", ".. code:: python", "", "   x = 1", ""].join("\n");
    const off = await renderOne("guide.rst", source);
    const on = await renderOne("guide.rst", source, {}, { runnable: true });
    expect(on.html).toBe(off.html);
    expect(on.html).not.toContain("portal-code-actions");
  });
});
