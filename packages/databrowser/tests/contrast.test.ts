// Text contrast, checked arithmetically rather than by eye.
//
// `--faint` is not decoration: it carries counts, file paths, table headers, flavour captions and
// placeholders - text a user has to READ, so on every surface it is drawn on it has to clear the
// 4.5:1 WCAG AA asks for normal-size text. This test computes the real ratios from the tokens in
// the stylesheet, so the palette cannot quietly drift under that bar.

import { test } from "node:test";
import assert from "node:assert/strict";

import { STYLES } from "../src/styles.js";

/** WCAG relative luminance of an #rrggbb colour. */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const channel = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const r = channel((n >> 16) & 255);
  const g = channel((n >> 8) & 255);
  const b = channel(n & 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(fg: string, bg: string): number {
  const a = luminance(fg);
  const b = luminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/** Read a token's value out of a theme block, expanding the #rgb shorthand. */
function token(block: string, name: string): string {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,6})`).exec(block);
  assert.ok(m, `--${name} not found (or not a plain hex) in the theme block`);
  const hex = m![1].toLowerCase();
  return hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;
}

const dayBlock = STYLES.slice(
  STYLES.indexOf(".freva-db {"),
  STYLES.indexOf('.freva-db[data-theme="night"]'),
);
const nightBlock = STYLES.slice(STYLES.indexOf('.freva-db[data-theme="night"]'));

/** Every surface meaningful `--faint` text is drawn on, per theme. */
const SURFACES = ["bg", "surface", "surface-2", "surface-3"] as const;

for (const [themeName, block] of [
  ["day", dayBlock],
  ["night", nightBlock],
] as const) {
  test(`${themeName}: --faint clears 4.5:1 on every surface it is used on`, () => {
    const faint = token(block, "faint");
    for (const surface of SURFACES) {
      const bg = token(block, surface);
      const ratio = contrast(faint, bg);
      assert.ok(
        ratio >= 4.5,
        `--faint ${faint} on --${surface} ${bg} is ${ratio.toFixed(2)}:1 (needs 4.5:1) in ${themeName}`,
      );
    }
  });

  test(`${themeName}: --text and --dim stay above --faint, so the hierarchy survives`, () => {
    // Raising --faint must not flatten the palette into one grey. Each step is still distinct AND
    // each still clears its own bar on the main surface.
    const surface = token(block, "surface");
    const text = contrast(token(block, "text"), surface);
    const dim = contrast(token(block, "dim"), surface);
    const faint = contrast(token(block, "faint"), surface);
    assert.ok(text > dim, `--text (${text.toFixed(2)}) is stronger than --dim (${dim.toFixed(2)})`);
    assert.ok(
      dim > faint,
      `--dim (${dim.toFixed(2)}) is stronger than --faint (${faint.toFixed(2)})`,
    );
    assert.ok(text >= 7, `--text should clear AAA on its own surface (${text.toFixed(2)}:1)`);
    assert.ok(dim >= 4.5, `--dim must clear AA (${dim.toFixed(2)}:1)`);
  });
}

test("the off-white / dark-blue identity is kept - no flip to pure black and white", () => {
  const dayBg = token(dayBlock, "bg");
  const nightBg = token(nightBlock, "bg");
  assert.notEqual(dayBg, "#ffffff", "the day background stays off-white");
  assert.notEqual(nightBg, "#000000", "the night background stays dark blue, not black");
  const dayText = token(dayBlock, "text");
  assert.notEqual(dayText, "#000000", "day text is not pure black");
});

test("placeholders set BOTH a compliant colour and opacity:1", () => {
  // A UA renders the placeholder as a low-opacity version of the text colour, which lands well under
  // 4.5:1 and differs between engines - so both halves have to be stated explicitly.
  const rule = /::placeholder\s*\{[^}]*\}/g;
  const rules = STYLES.match(rule) ?? [];
  assert.ok(rules.length > 0, "placeholder styling exists");
  const compliant = rules.filter(
    (r) => /opacity:\s*1/.test(r) && /color:\s*var\(--faint\)/.test(r),
  );
  assert.ok(
    compliant.length >= 2,
    "the search field and the shared input rule both set an explicit colour and opacity:1",
  );
});

test("meaningful small labels are at least 11px", () => {
  // Sub-11px text must not carry real content (table headers, counts, paths). Anything below
  // 11px must be genuinely decorative; the rule below pins the ones that carry meaning.
  const bumped = [".dmatrix thead th", ".list-head", ".dl-path", ".fval .n"];
  const block = STYLES.slice(STYLES.indexOf(bumped.join(",\n.freva-db ")));
  assert.match(
    block.slice(0, 400),
    /font-size:\s*11px/,
    "the meaningful small-text labels are raised to 11px",
  );
});

test("disabled text stays readable", () => {
  // 0.5 alpha on --dim does not clear 4.5:1; disabled still has to be legible to be understood.
  const m = /\.btn:disabled,\s*\n\.freva-db \[aria-disabled="true"\] \{\s*opacity:\s*([\d.]+)/.exec(
    STYLES,
  );
  assert.ok(m, "a disabled-text opacity rule exists");
  assert.ok(Number(m![1]) >= 0.7, `disabled opacity ${m![1]} keeps the text readable`);
});
