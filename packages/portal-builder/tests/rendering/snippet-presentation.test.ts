// How a runnable snippet is presented: when its controls show (`pythonPlayground.controls`) and
// whether a visitor may edit it (`editable` on the fence, `pythonPlayground.editableSnippets`).
// Both are presentation: the id and digest a press sends are the same either way, and a plain
// code block is untouched by both.
import { afterAll, describe, expect, it } from "vitest";
import { errorCodes, renderOne } from "../helpers/render.js";
import { cleanupFixtures, resolveFixture } from "../helpers/fixture.js";
import { writeConsumerSite } from "../helpers/consumer.js";

afterAll(cleanupFixtures);

const FENCE = (words: string): string =>
  `# Guide\n\n\`\`\`python ${words}\nx = 1\nprint(x)\n\`\`\`\n`;
const PLAIN = "```bash\nls\n```\n";

/** The opening tag of each code figure, in document order. */
const figures = (html: string): string[] =>
  html.match(/<div class="portal-code-figure"[^>]*>/g) ?? [];

describe("1. an editable snippet", () => {
  it("marks the figure, and sends the same id and digest as a read-only one", async () => {
    const editable = await renderOne(
      "guide.md",
      FENCE("try-in-python editable"),
      {},
      { runnable: true },
    );
    const plain = await renderOne("guide.md", FENCE("try-in-python"), {}, { runnable: true });
    expect(errorCodes(editable)).toEqual([]);
    expect(figures(editable.html)[0]).toContain("data-portal-editable");
    expect(figures(plain.html)[0]).not.toContain("data-portal-editable");
    // The identity is the author's code; editing is something a visitor does to a copy of it.
    expect(editable.runnable).toEqual(plain.runnable);
    expect(editable.html).not.toContain("style=");
  });

  it("takes the marker in any order beside the title", async () => {
    const a = await renderOne(
      "guide.md",
      FENCE('editable try-in-python title="a.py"'),
      {},
      { runnable: true },
    );
    const b = await renderOne(
      "guide.md",
      FENCE('try-in-python title="a.py" editable'),
      {},
      { runnable: true },
    );
    expect(errorCodes(a)).toEqual([]);
    expect(a.html).toBe(b.html);
  });

  it("is PC1022 without try-in-python, and when written twice", async () => {
    const alone = await renderOne("guide.md", FENCE("editable"), {}, { runnable: true });
    expect(errorCodes(alone)).toEqual(["PC1022"]);
    expect(alone.diagnostics[0]?.hint).toContain("python try-in-python editable");
    const twice = await renderOne(
      "guide.md",
      FENCE("try-in-python editable editable"),
      {},
      { runnable: true },
    );
    expect(errorCodes(twice)).toEqual(["PC1022"]);
  });

  it("stays a plain block on a portal without a playground", async () => {
    const off = await renderOne("guide.md", FENCE("try-in-python editable"));
    const plain = await renderOne("guide.md", FENCE("try-in-python"));
    expect(off.html).toBe(plain.html);
    expect(off.html).not.toContain("data-portal-editable");
  });

  it("editableSnippets makes every runnable snippet editable, and nothing else", async () => {
    const out = await renderOne(
      "guide.md",
      `${FENCE("try-in-python")}\n${PLAIN}`,
      {},
      { runnable: true, presentation: { editableAll: true } },
    );
    const [run, bash] = figures(out.html);
    expect(run).toContain("data-portal-editable");
    expect(bash).not.toContain("data-portal-editable");
  });

  it("is refused, and counted, where the interpreter is on another origin", async () => {
    const out = await renderOne(
      "guide.md",
      `${FENCE("try-in-python editable")}\n${FENCE("try-in-python")}`,
      {},
      { runnable: true, presentation: { editing: false } },
    );
    expect(out.html).not.toContain("data-portal-editable");
    expect(out.html).toContain("data-portal-run");
    expect(out.editableRefused).toBe(1);
  });
});

describe("2. when the controls show", () => {
  it("adds nothing by default: the controls are always shown", async () => {
    const out = await renderOne("guide.md", FENCE("try-in-python"), {}, { runnable: true });
    expect(out.html).not.toContain("data-portal-controls");
  });

  it("controls: hover marks runnable figures only, and leaves a plain block byte-identical", async () => {
    const source = `${FENCE("try-in-python")}\n${PLAIN}`;
    const hover = await renderOne(
      "guide.md",
      source,
      {},
      { runnable: true, presentation: { controls: "hover" } },
    );
    const always = await renderOne("guide.md", source, {}, { runnable: true });
    const [run, bash] = figures(hover.html);
    expect(run).toContain('data-portal-controls="hover"');
    expect(bash).toBe(figures(always.html)[1]);
  });
});

describe("3. the portal configuration", () => {
  it("warns FP1227 at playgroundOrigin, and ships no editable snippet", async () => {
    const root = writeConsumerSite({
      playground: { playgroundOrigin: "https://play.example.org" },
      runnableDocs: true,
      editableDocs: true,
      pages: 2,
    });
    const { model, diagnostics } = await resolveFixture(root);
    expect(model).toBeDefined();
    const found = diagnostics.items.filter((d) => d.code === "FP1227");
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe("warning");
    expect(found[0]?.pointer).toBe("/pythonPlayground/playgroundOrigin");
    expect(found[0]?.message).toContain("2 snippets ask");
    expect(JSON.stringify(model)).not.toContain("data-portal-editable");
  }, 120_000);

  it("points FP1227 at editableSnippets when that is what asked", async () => {
    const root = writeConsumerSite({
      playground: { playgroundOrigin: "https://play.example.org", editableSnippets: true },
      runnableDocs: true,
      pages: 1,
    });
    const { diagnostics } = await resolveFixture(root);
    const found = diagnostics.items.filter((d) => d.code === "FP1227");
    expect(found.map((d) => d.pointer)).toEqual(["/pythonPlayground/editableSnippets"]);
  }, 120_000);

  it("carries both keys through on the portal's own origin", async () => {
    const root = writeConsumerSite({
      playground: { controls: "hover", editableSnippets: true },
      runnableDocs: true,
      pages: 1,
    });
    const { model, diagnostics } = await resolveFixture(root);
    expect(diagnostics.items.filter((d) => d.severity === "error")).toEqual([]);
    expect(codes(diagnostics.items)).not.toContain("FP1227");
    const text = JSON.stringify(model);
    expect(text).toContain("data-portal-editable");
    expect(text).toContain('data-portal-controls=\\"hover\\"');
  }, 120_000);

  it("refuses a controls value other than always or hover, and a non-boolean editableSnippets", async () => {
    for (const bad of ["controls: sometimes", "editableSnippets: yes-please"]) {
      const root = writeConsumerSite({ playground: {}, runnableDocs: true, pages: 1 });
      const { readFileSync, writeFileSync } = await import("node:fs");
      const config = `${root}/portal.yaml`;
      writeFileSync(
        config,
        readFileSync(config, "utf8").replace("  enabled: true\n", `  enabled: true\n  ${bad}\n`),
      );
      const { model } = await resolveFixture(root);
      expect(model, bad).toBeUndefined();
    }
  }, 120_000);
});

function codes(items: { code: string }[]): string[] {
  return items.map((d) => d.code);
}
