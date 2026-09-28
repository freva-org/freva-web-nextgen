// Per-mode page palettes: `theme.tokens.light` and `theme.tokens.dark`.
//
// Flat colour tokens are one value for both modes, which is why four are not applied (FP1212): a
// light page's background would repaint the dark one. A mode block owns one mode's page colours,
// and the design's surface family is derived from it rather than restated: raised surfaces a small
// step off the page, rules and chips a larger step towards the text, status fills a tint of their
// own colour. The steps are measured from the design's values and re-applied to the chosen
// background, so a white page gets white-page surfaces.
//
// Text is re-checked against the surfaces it lands on. A colour the consumer did not set moves
// just far enough to clear WCAG AA; one they DID set is reported (FP1226), never changed.

import { contrast, fromHsl, isHex, luminance, mix, toHsl } from "./color.js";

export type ColorMode = "light" | "dark";

/** The page colours one mode block may set. Everything else is derived from them. */
export const MODE_TOKENS = [
  "colorBackground",
  "colorSurface",
  "colorText",
  "colorTextMuted",
  "colorBorder",
] as const;
export type ModeTokenName = (typeof MODE_TOKENS)[number];
export type ModeTokens = Partial<Record<ModeTokenName, string>>;

/**
 * The design's page palette per mode, exactly as `freva-tokens.css` states it (a contract test
 * reads the stylesheet and holds the two equal). Every derived value is a step measured from
 * these, so retuning the design retunes every derived palette with it.
 */
export const DESIGN_PALETTE: Record<ColorMode, Record<string, string>> = {
  light: {
    "--bg": "#f6f5f1",
    "--surface": "#fffef9",
    "--surface-2": "#fbfaf5",
    "--line": "#e2e0d8",
    "--line-2": "#d8d6cd",
    "--chip": "#eceae2",
    "--tile": "#eef1f4",
    "--ink": "#14202c",
    "--ink-2": "#4d5560",
    "--muted": "#6f6f66",
    "--danger": "#8c4a3d",
    "--danger-bg": "#f6ece9",
    "--warning": "#7d6119",
    "--warning-bg": "#f7f0dc",
    "--syn-comment": "#6b7a6b",
    "--syn-keyword": "#7a3b8f",
    "--syn-string": "#2f6f4f",
    "--syn-number": "#a2542a",
    "--syn-name": "#1b4f72",
    "--syn-punct": "#5b6470",
    "--syn-removed": "#8c4a3d",
    "--syn-removed-bg": "#f6ece9",
    "--syn-added": "#2f6f4f",
    "--syn-added-bg": "#e9f2ec",
    "--syn-output": "#6f6f66",
  },
  dark: {
    "--bg": "#10161d",
    "--surface": "#171f28",
    "--surface-2": "#141b23",
    "--line": "#263140",
    "--line-2": "#2f3b4a",
    "--chip": "#202a36",
    "--tile": "#1c2634",
    "--ink": "#e9eef3",
    "--ink-2": "#aab5c1",
    "--muted": "#8794a1",
    "--danger": "#d9948a",
    "--danger-bg": "#2b1d1a",
    "--warning": "#d8bd77",
    "--warning-bg": "#2a2317",
    "--syn-comment": "#8b9c8b",
    "--syn-keyword": "#d3a2e8",
    "--syn-string": "#90d6ab",
    "--syn-number": "#eaa77a",
    "--syn-name": "#8fc4f0",
    "--syn-punct": "#9aa5b1",
    "--syn-removed": "#e39a90",
    "--syn-removed-bg": "#2b1d1a",
    "--syn-added": "#90d6ab",
    "--syn-added-bg": "#16261d",
    "--syn-output": "#8794a1",
  },
};

/**
 * Each admonition type's own colour, per mode, as `freva-shell.css` sets `--adm` (a contract test
 * holds the two equal). An admonition's fill is 8% of it over `--surface`, and a link or body text
 * inside one sits on that fill - so each is a surface text is measured against, not only the
 * accent-tinted default.
 */
export const ADMONITION_COLOURS: Record<ColorMode, Record<string, string>> = {
  light: {
    note: "#1b4f72",
    abstract: "#4a5c6b",
    info: "#1a6984",
    tip: "#2f6e4e",
    success: "#2f6e4e",
    question: "#5b4b8a",
    warning: "#795e18",
    failure: "#8c4a3d",
    danger: "#8c2f2f",
    bug: "#6b3f7a",
    example: "#4a5c6b",
    quote: "#5a636f",
  },
  dark: {
    note: "#8fc4f0",
    abstract: "#aab5c1",
    info: "#7fc9e0",
    tip: "#90d6ab",
    success: "#90d6ab",
    question: "#bda9f0",
    warning: "#d8bd77",
    failure: "#e39a90",
    danger: "#f0a09a",
    bug: "#d3a2e8",
    example: "#aab5c1",
    quote: "#9aa5b1",
  },
};

/** WCAG AA for body text. Muted text carries 10-11px labels, so it gets no large-text allowance. */
const AA = 4.5;
/** Below this a surface reads as the page itself: a card, a dialog, a rail with no edge. */
const DISTINCT = 1.03;

/** A text/background pair that does not clear its threshold, with the token that decided it. */
export interface PaletteFinding {
  /** The colour mode the pair fails in; `both` for the header and footer, which are one in both. */
  mode: ColorMode | "both";
  /** JSON pointer to the token the consumer set that makes the pair fail. */
  pointer: string;
  message: string;
}

export interface ModePalette {
  /** Custom property -> value, for this mode's block. */
  properties: Record<string, string>;
  /** The background code blocks are drawn on: `color-mix(in srgb, --ink 6%, --chip)`. */
  codeBackground: string;
  /** The surfaces accent-coloured text lands on, in no particular order. */
  textSurfaces: string[];
  findings: PaletteFinding[];
}

/** How far a design token sits from the design's page, as a contrast ratio. */
function designStep(mode: ColorMode, property: string): number {
  const design = DESIGN_PALETTE[mode];
  return contrast(design[property]!, design["--bg"]!);
}

/**
 * `from`, moved towards `to` by the smallest amount that puts `ratio` between the result and
 * `from`. `to` itself when even it is not that far - the caller measures what it got.
 */
function stepTowards(from: string, to: string, ratio: number): string {
  for (let step = 1; step <= 200; step += 1) {
    const candidate = mix(to, from, step / 200);
    if (contrast(candidate, from) >= ratio) return candidate;
  }
  return to;
}

/**
 * The quietest version of `ink` - moved as far back towards `ground` as it can go - that still
 * clears `ratio` on every surface. `ink` itself when it cannot move at all.
 */
function stepBack(ink: string, ground: string, ratio: number, surfaces: string[]): string {
  let best = ink;
  for (let step = 1; step <= 200; step += 1) {
    const candidate = mix(ground, ink, step / 200);
    if (!surfaces.every((surface) => contrast(candidate, surface) >= ratio)) break;
    best = candidate;
  }
  return best;
}

/**
 * `colour`, with its hue kept, moved in lightness away from the surfaces until it reads on all of
 * them: towards black on a light page, towards white on a dark one. Unchanged when it already
 * reads - the design's own colours come back as they are.
 */
function readable(colour: string, surfaces: string[], ratio = AA): string {
  const ok = (c: string): boolean => surfaces.every((surface) => contrast(c, surface) >= ratio);
  if (ok(colour)) return colour;
  const darkPage = surfaces.every((surface) => luminance(surface) < 0.2);
  const [h, s, l] = toHsl(colour);
  const target = darkPage ? 1 : 0;
  for (let step = 1; step <= 100; step += 1) {
    const candidate = fromHsl(h, s, l + (target - l) * (step / 100));
    if (ok(candidate)) return candidate;
  }
  return darkPage ? "#ffffff" : "#000000";
}

const describe = (ratio: number): string => `${ratio.toFixed(2)}:1`;

/**
 * One mode's page palette from its mode block. `undefined` when the block sets nothing: that mode
 * is the design's, byte for byte.
 */
export function derivePalette(
  mode: ColorMode,
  tokens: ModeTokens | undefined,
  accent: string | undefined,
): ModePalette | undefined {
  const set = Object.fromEntries(
    Object.entries(tokens ?? {}).filter(([, value]) => typeof value === "string" && isHex(value)),
  ) as ModeTokens;
  if (Object.keys(set).length === 0) return undefined;

  const design = DESIGN_PALETTE[mode];
  const findings: PaletteFinding[] = [];
  const out: Record<string, string> = {};
  const bg = set.colorBackground ?? design["--bg"]!;
  const newGround = set.colorBackground !== undefined;

  // The text colour. A consumer's is theirs; the design's is used unless the new page makes it
  // unreadable, and then the other mode's ink - a light page chosen for "dark" mode, say.
  let ink = set.colorText ?? design["--ink"]!;
  if (!set.colorText && contrast(ink, bg) < AA) {
    const other = DESIGN_PALETTE[mode === "light" ? "dark" : "light"]["--ink"]!;
    if (contrast(other, bg) > contrast(ink, bg)) ink = other;
  }

  // Surfaces. On the design's own page they stay the design's; a new page gets them re-derived.
  if (newGround) {
    // A raised surface steps AWAY from the text - lighter on a light page - when the page leaves
    // room for it. A white page leaves none: a card lighter than white does not exist, and the
    // design's step would put it exactly on the page. Then raised surfaces step towards the text
    // instead, and by the design's smaller step, so a card stays quieter than a chip or a code
    // block on it.
    const lift = mode === "dark" || luminance(ink) < luminance(bg) ? "#ffffff" : "#000000";
    const roomToLift = contrast(lift, bg) >= designStep(mode, "--surface");
    const raise = roomToLift ? lift : ink;
    const surfaceStep = roomToLift
      ? designStep(mode, "--surface")
      : designStep(mode, "--surface-2");
    out["--bg"] = bg;
    out["--surface"] = set.colorSurface ?? stepTowards(bg, raise, surfaceStep);
    out["--surface-2"] = mix(out["--surface"], bg, 0.5);
    // Rules, chips and tiles step towards the text, as far as the design's do.
    out["--line"] = stepTowards(bg, ink, designStep(mode, "--line"));
    out["--line-2"] = set.colorBorder ?? stepTowards(bg, ink, designStep(mode, "--line-2"));
    out["--chip"] = stepTowards(bg, ink, designStep(mode, "--chip"));
    out["--tile"] = stepTowards(bg, ink, designStep(mode, "--tile"));
    // Status fills are a tint of their own colour, as far off the page as the design's are.
    for (const [fill, colour] of [
      ["--danger-bg", "--danger"],
      ["--warning-bg", "--warning"],
      ["--syn-removed-bg", "--syn-removed"],
      ["--syn-added-bg", "--syn-added"],
    ] as const) {
      out[fill] = stepTowards(bg, design[colour]!, designStep(mode, fill));
    }
  } else {
    if (set.colorSurface) {
      out["--surface"] = set.colorSurface;
      out["--surface-2"] = mix(set.colorSurface, bg, 0.5);
    }
    if (set.colorBorder) out["--line-2"] = set.colorBorder;
  }
  const surface = out["--surface"] ?? design["--surface"]!;
  const surface2 = out["--surface-2"] ?? design["--surface-2"]!;
  const chip = out["--chip"] ?? design["--chip"]!;
  const codeBackground = mix(ink, chip, 0.06);
  // Admonition fills: 8% of the type's colour - or of the accent, for an untyped one - over the
  // surface, exactly as the stylesheet mixes them.
  const admonitionFills = [
    ...Object.values(ADMONITION_COLOURS[mode]),
    ...(accent && isHex(accent) ? [accent] : []),
  ].map((colour) => mix(colour, surface, 0.08));

  if (set.colorSurface && contrast(set.colorSurface, bg) < DISTINCT) {
    findings.push({
      mode,
      pointer: `/theme/tokens/${mode}/${"colorSurface"}`,
      message: `the ${mode} surface ${set.colorSurface} is ${describe(contrast(set.colorSurface, bg))} against the page ${bg}: cards, dialogs and the rail would not stand off it (at least ${DISTINCT}:1).`,
    });
  }

  // Body text, on everything it is set on.
  const bodySurfaces = [bg, surface, surface2, chip, codeBackground, ...admonitionFills];
  if (set.colorText || newGround) out["--ink"] = ink;
  for (const ground of bodySurfaces) {
    if (contrast(ink, ground) < AA) {
      findings.push({
        mode,
        pointer: `/theme/tokens/${mode}/${set.colorText ? "colorText" : "colorBackground"}`,
        message: `${mode} text ${ink} on ${ground} is ${describe(contrast(ink, ground))}; body text needs ${AA}:1.`,
      });
      break;
    }
  }

  // Secondary and muted text keep the design's distance from the ink where the page allows it,
  // and never less than AA on the surfaces they sit on. A new page or ink re-derives them; a new
  // SURFACE alone keeps the design's value while it still reads there, and re-derives it if not.
  const quietSurfaces = [bg, surface, surface2];
  const derived = set.colorText !== undefined || newGround;
  const quiet = (property: "--ink-2" | "--muted", on: string[]): string | undefined =>
    !derived && on.every((ground) => contrast(design[property]!, ground) >= AA)
      ? undefined
      : stepBack(ink, bg, Math.max(AA, designStep(mode, property)), on);
  if (derived || set.colorSurface) {
    const ink2 = quiet("--ink-2", [...quietSurfaces, chip]);
    if (ink2) out["--ink-2"] = ink2;
  }
  if (set.colorTextMuted) {
    out["--muted"] = set.colorTextMuted;
    const worst = Math.min(...quietSurfaces.map((s) => contrast(set.colorTextMuted!, s)));
    if (worst < AA) {
      findings.push({
        mode,
        pointer: `/theme/tokens/${mode}/${"colorTextMuted"}`,
        message: `${mode} muted text ${set.colorTextMuted} measures ${describe(worst)} on the page's surfaces; it carries small labels and needs ${AA}:1.`,
      });
    }
  } else if (derived || set.colorSurface) {
    const muted = quiet("--muted", quietSurfaces);
    if (muted) out["--muted"] = muted;
  }

  // Coloured text on the new page: status colours, and the syntax colours of code the data API
  // highlighted, each kept in its hue and moved only as far as it has to.
  if (newGround) {
    out["--danger"] = readable(design["--danger"]!, [bg, surface, out["--danger-bg"]!]);
    out["--warning"] = readable(design["--warning"]!, [bg, surface, out["--warning-bg"]!]);
    for (const name of ["comment", "keyword", "string", "number", "name", "punct", "output"]) {
      out[`--syn-${name}`] = readable(design[`--syn-${name}`]!, [codeBackground]);
    }
    out["--syn-removed"] = readable(design["--syn-removed"]!, [
      codeBackground,
      out["--syn-removed-bg"]!,
    ]);
    out["--syn-added"] = readable(design["--syn-added"]!, [codeBackground, out["--syn-added-bg"]!]);
  } else if (set.colorSurface) {
    // Status text sits on surfaces too; moved only if the new one leaves it unreadable.
    for (const [text, fill] of [
      ["--danger", "--danger-bg"],
      ["--warning", "--warning-bg"],
    ] as const) {
      const moved = readable(design[text]!, [bg, surface, design[fill]!]);
      if (moved !== design[text]) out[text] = moved;
    }
  }

  // Accent-coloured text - a link - lands on the page, on cards and inside admonitions.
  const textSurfaces = [bg, surface, surface2, ...admonitionFills];

  return { properties: out, codeBackground, textSurfaces, findings };
}
