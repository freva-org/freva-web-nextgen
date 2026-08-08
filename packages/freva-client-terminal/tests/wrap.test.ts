// The shell-line wrapping contract.
//
// The shape to avoid: an absolutely-positioned, non-wrapping prefix with the editable text pushed
// past it by an indent, plus a width threshold that drops the prefix onto its own line. An indent
// shifts only the FIRST line, so the moment the prefix itself wraps, the painted prompt and the
// typed text disagree - the typed text either overlaps the prompt or is exiled to the following
// line.
//
// `wrapPlan` writes down what happens instead: one `pre-wrap` flow containing the prefix and the
// command as inline siblings. These cases cover a prefix occupying one, two, three and four visual
// lines - the geometry a jsdom width mock cannot reach at all, because jsdom performs no layout.
// `fixtures/wrapping.html` checks that a real engine realises the same contract.

import assert from "node:assert/strict";
import test from "node:test";

import { wrapPlan } from "../src/wrap.js";

/** The read-only prefix of a realistic shell line. */
const PREFIX = ["$", "freva-client", "databrowser", "data-search", "--flavour", "cmip6"];

test("a one-line prefix: the command continues on the SAME line", () => {
  const plan = wrapPlan(PREFIX, "project=cmip6", 200);
  assert.equal(plan.prefixLines, 1);
  assert.equal(plan.commandLine, 0, "the command begins on the prefix's own line");
  assert.equal(
    plan.commandColumn,
    PREFIX.join(" ").length + 1,
    "…immediately after the last prefix token plus one space",
  );
});

/** Narrow enough that the prefix needs `lines` visual lines. */
const widthForPrefixLines = (lines: number): number => {
  for (let cols = 8; cols < 300; cols++) {
    if (wrapPlan(PREFIX, "", cols).prefixLines === lines) return cols;
  }
  throw new Error(`no width produces a ${lines}-line prefix`);
};

for (const lines of [1, 2, 3, 4]) {
  test(`a ${lines}-line prefix: the command still begins right after the LAST prefix token`, () => {
    const cols = widthForPrefixLines(lines);
    const plan = wrapPlan(PREFIX, "project=cmip6", cols);
    assert.equal(plan.prefixLines, lines, `the prefix occupies ${lines} visual lines`);
    // The whole point. The command is NOT forced to a fresh line just because the prefix wrapped.
    const lastPrefixLine = wrapPlan(PREFIX, "", cols).lines[lines - 1];
    const roomOnLastLine = cols - lastPrefixLine.length - 1;
    if (roomOnLastLine >= "project=cmip6".length) {
      assert.equal(
        plan.commandLine,
        lines - 1,
        "the command shares the prefix's last visual line when it fits",
      );
      assert.equal(
        plan.commandColumn,
        lastPrefixLine.length + 1,
        "…starting one space after the last prefix token, with NO indent",
      );
    } else {
      assert.equal(
        plan.commandLine,
        lines,
        "it moves down only when it genuinely does not fit - as a shell does",
      );
      assert.equal(plan.commandColumn, 0, "…and then starts at column 0, not at an indent");
    }
  });
}

test("every wrapped continuation starts at the container's left edge", () => {
  // The failure mode to rule out is an indented continuation (or an overlapped prompt). Here a
  // long command wraps repeatedly and every continuation line begins at column 0.
  const command = Array.from({ length: 12 }, (_, i) => `variable=v${i}`).join(" ");
  const plan = wrapPlan(PREFIX, command, 40);
  assert.ok(plan.lines.length > 4, "the line really did wrap several times");
  for (let i = 1; i < plan.lines.length; i++) {
    assert.ok(
      !/^\s/.test(plan.lines[i]),
      `continuation line ${i} starts at the left edge: ${JSON.stringify(plan.lines[i])}`,
    );
  }
  for (const line of plan.lines) {
    assert.ok(line.length <= 40, `no line overflows the container: ${JSON.stringify(line)}`);
  }
});

test("a token longer than the whole line is hard-broken rather than overflowing", () => {
  const plan = wrapPlan(["$"], `variable=${"x".repeat(90)}`, 20);
  for (const line of plan.lines) assert.ok(line.length <= 20, JSON.stringify(line));
  assert.ok(plan.lines.length >= 5, "it wrapped across several lines instead of running off");
});

test("an empty command still reports where typing would begin", () => {
  const plan = wrapPlan(PREFIX, "", 200);
  assert.equal(plan.commandLine, 0);
  assert.equal(plan.commandColumn, PREFIX.join(" ").length + 1);
});

test("no prefix at all: the command owns the line from column 0", () => {
  const plan = wrapPlan([], "project=cmip6", 200);
  assert.equal(plan.commandLine, 0);
  assert.equal(plan.commandColumn, 0);
});
