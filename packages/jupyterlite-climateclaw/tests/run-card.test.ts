// A run at DKRZ in the chat: one card - where it ran (the cell, a click away), how it ended, its
// figures - whose line folds the code; output, error and figures always show. Written once the run
// is over, in stream order, the same live and in a conversation reopened from the history.
import { describe, expect, it } from "vitest";

import { copyableText } from "../src/reply-actions.js";
import { RunCards, runCard } from "../src/run-card.js";
import { normalizeCodeOutput, threadToTurns } from "../src/stream.js";

const output = (o: Record<string, unknown>) => normalizeCodeOutput(o);
const run = (extra: Record<string, unknown> = {}) => ({
  id: "call_1",
  code: "print(1)",
  pointer: { number: 3, notebook: "Chat.ipynb", cellId: "c-1", model: "gpt-test" },
  output: output({ stdout: "1\n", error: "" }),
  images: [],
  figures: [],
  ...extra,
});

describe("a run's card", () => {
  it("a line that folds the code; the output shows either way; the cell chip jumps", () => {
    const card = runCard(run() as never, { open: false });
    expect(card).toMatch(
      /^\n\n<div class="jp-ClimateClaw-run"><details class="jp-ClimateClaw-runCode">/,
    );
    expect(card).toContain('<summary class="jp-ClimateClaw-runHead">');
    expect(card).toContain("jp-ClimateClaw-cell-c-1");
    expect(card).toContain("Cell 3");
    expect(card).toContain("✓ ran · output");
    // The code is inside the fold; the output after it, in the card.
    const fold = card.slice(card.indexOf("<details"), card.indexOf("</details>"));
    expect(fold).toContain("```python\nprint(1)\n```");
    expect(fold).not.toContain("```text");
    expect(card.indexOf("```text\n1\n```")).toBeGreaterThan(card.indexOf("</details>"));
    expect(card.trimEnd().endsWith("</div>")).toBe(true);
    // The summary is one line of HTML: Markdown never splits it.
    const summary = card.slice(card.indexOf("<summary"), card.indexOf("</summary>"));
    expect(summary).not.toContain("\n");
    expect(runCard(run() as never, { open: true })).toContain(
      '<details class="jp-ClimateClaw-runCode" open>',
    );
  });

  it("Hide code folds the code only: output, error and figures stay outside the fold", () => {
    const card = runCard(
      run({
        output: output({ stdout: "out\n", result_repr: "42", error: "ValueError: bad" }),
        images: [{ mime: "image/png", base64: "QUJD" }],
      }) as never,
      { open: false },
    );
    const end = card.indexOf("</details>");
    const shown = ["```text\nout\n42", "```text\nValueError: bad", "data:image/png;base64,QUJD"];
    for (const part of shown) {
      expect(card.indexOf(part)).toBeGreaterThan(end);
    }
    expect(card.match(/<details class="jp-ClimateClaw-runCode"/g)).toHaveLength(1);
  });

  it("a run without code is its line and its output, nothing to fold", () => {
    const card = runCard(run({ code: "" }) as never, { open: false });
    expect(card).not.toContain("jp-ClimateClaw-runCode");
    expect(card).toContain('<div class="jp-ClimateClaw-runHead">');
    expect(card).toContain("```text\n1\n```");
  });

  it("copies as its code and output, without the card's HTML", () => {
    const text = copyableText(`Done.${runCard(run() as never, { open: false })}`);
    expect(text).toBe("Done.\n\nCode\n\n```python\nprint(1)\n```\n\nOutput\n\n```text\n1\n```");
  });

  it("an error marks the card and shows the end of its traceback, without terminal colours", () => {
    const lines = Array.from({ length: 80 }, (_, i) => `  line ${i}`).join("\n");
    const card = runCard(
      run({
        output: output({ error: `\u001b[31mTraceback\u001b[0m\n${lines}\nZeroDivisionError: x` }),
      }) as never,
      { open: false },
    );
    expect(card).toContain('class="jp-ClimateClaw-run jp-mod-error"');
    expect(card).toContain("✗ ZeroDivisionError");
    expect(card).toContain("ZeroDivisionError: x");
    expect(card).toMatch(/… \d+ more lines above/);
    expect(card).not.toContain("\u001b");
  });

  it("long output is cut, and says so", () => {
    const long = Array.from({ length: 200 }, (_, i) => `row ${i}`).join("\n");
    const card = runCard(run({ output: output({ stdout: long }) }) as never, { open: false });
    expect(card).toContain("row 0");
    expect(card).not.toContain("row 199");
    expect(card).toMatch(/… 160 more lines/);
  });

  it("figures go in the card, and are counted on its line", () => {
    const card = runCard(
      run({
        images: [{ mime: "image/png", base64: "QUJD" }],
        figures: [
          {
            figure: { name: "map.png", url: "https://w.example/p/map.png", mime: "image/png" },
            base64: null,
          },
        ],
      }) as never,
      { open: false },
    );
    expect(card).toContain("◩ 2 figures");
    expect(card).toContain("![Figure](data:image/png;base64,QUJD)");
    expect(card).toContain("![map.png](https://w.example/p/map.png)");
  });
});

describe("RunCards", () => {
  it("writes each run once it is over, its figure parts joined to it", () => {
    const cards = new RunCards({ open: false });
    cards.code("call_1", "a()");
    cards.output("call_1", output({ stdout: "x" }));
    cards.image("call_1_0", "image/png", "QUJD");
    expect(cards.isNew("call_1")).toBe(false);
    expect(cards.isNew("call_2")).toBe(true);
    const text = cards.flush();
    expect(text.match(/<details class="jp-ClimateClaw-runCode"/g)).toHaveLength(1);
    expect(text).toContain("data:image/png;base64,QUJD");
    expect(cards.pending).toBe(false);
    expect(cards.flush()).toBe("");
  });
});

describe("a conversation reopened from the history", () => {
  const variants = [
    { variant: "User", content: "plot it" },
    { variant: "Assistant", content: "Running it." },
    { variant: "Code", id: "call_1", content: '{"code": "print(2)"}' },
    { variant: "CodeOutput", id: "call_1", content: { stdout: "2\n", error: "" } },
    { variant: "Assistant", content: "Done." },
  ];

  it("shows its runs as the same cards, the code folded or not as the code toggle says", () => {
    const closed = threadToTurns(variants, { hideCode: true }).turns[1]!.text;
    expect(closed.indexOf("Running it.")).toBeLessThan(closed.indexOf("<details"));
    // Each part of the output folds by its header, open to start with, whatever Hide code says.
    expect(closed).toContain(
      '<details class="jp-ClimateClaw-runPart" open><summary class="jp-ClimateClaw-runSection">Output</summary>',
    );
    expect(closed.indexOf("</details>")).toBeLessThan(closed.indexOf("```text\n2\n```"));
    expect(closed.indexOf("```text\n2\n```")).toBeLessThan(closed.indexOf("Done."));
    expect(closed).toContain("```python\nprint(2)\n```");
    expect(closed).not.toContain('runCode" open>');
    const open = threadToTurns(variants, { hideCode: false }).turns[1]!.text;
    expect(open).toContain('<details class="jp-ClimateClaw-runCode" open>');
    // The code is in the card only, not repeated as a loose block.
    expect(open.match(/```python/g)).toHaveLength(1);
  });
});

describe("Run at DKRZ's import check", () => {
  it("is ClimateClaw's own step: never a card of its own in the chat", async () => {
    const { moduleCheckCode } = await import("../src/runfix.js");
    const cards = new RunCards({ open: false });
    cards.code("call_c", moduleCheckCode(["xarray"]));
    cards.output("call_c", output({ stdout: "climateclaw-missing: \n" }));
    cards.code("call_1", "print(1)");
    cards.output("call_1", output({ stdout: "1\n" }));
    const text = cards.flush();
    expect(text).not.toContain("climateclaw-missing");
    expect(text.match(/class="jp-ClimateClaw-run"/g)).toHaveLength(1);
  });
});
