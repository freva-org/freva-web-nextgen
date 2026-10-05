// What a portal-style-v1 rule that can reach a protected control may declare. Listing the ways to
// hide something is never complete - `opacity: calc(1 - 1)`, a zero `matrix()`, `filter:
// opacity(0)`, a mask, an offset past the viewport - so this is an allowlist: a property is either
// one that cannot hide a control, or one whose value must be provably safe, literal by literal.
// Anything else, and any value that needs evaluating, is refused on such a rule.
//
// Values also compose: a control sits inside its landmark, a container and at most one template
// wrapper, and each of them can be styled. So nothing that composes without bound is accepted -
// no transforms, no offsets, no relative font sizes below 1em, no opacity below 0.9 - and what
// adds up is capped per element: 8px of margin, 16px of padding and 2px of border, 26px per
// element. That bounds layout but cannot prove it; only a browser can (docs/customisation.md).

import { createRequire } from "node:module";
import type { Node as ValueNode } from "postcss-value-parser";
import { styleApi } from "./api.js";
import { cssUnescape } from "./css-text.js";

const require = createRequire(import.meta.url);
/* eslint-disable @typescript-eslint/consistent-type-imports -- the type of a required module */
const valueParser = require("postcss-value-parser") as typeof import("postcss-value-parser");
/* eslint-enable @typescript-eslint/consistent-type-imports */

/** Properties that cannot take a control off screen or out of reach, with any checked value. */
const FREE = new RegExp(
  "^(" +
    [
      "background(-[a-z-]+)?",
      "border(-[a-z]+)*-(radius|style|color)",
      "border-(top|bottom)-(left|right)-radius",
      "border-(start|end)-(start|end)-radius",
      "border-(style|color|radius)",
      "outline(-[a-z-]+)?", // checked on every rule, see outlineViolation
      "box-shadow",
      "text-shadow",
      "font-family",
      "font-weight",
      "font-style",
      "font-variant(-[a-z-]+)?",
      "text-transform",
      "text-decoration(-[a-z-]+)?",
      "text-underline-offset",
      "text-align",
      "vertical-align",
      "white-space",
      "cursor",
      "transition(-[a-z-]+)?", // checked on every rule, see globalViolation
      "animation(-[a-z-]+)?", // the names are checked against their keyframes
      "align-(items|self|content)",
      "justify-(items|self|content)",
      "place-(items|self|content)",
      "flex-(direction|wrap|flow)",
      "box-sizing",
      "accent-color",
      "caret-color",
      "--site-[a-z0-9-]+",
    ].join("|") +
    ")$",
);

/** Text colour: free, except a colour that is fully transparent. */
const COLOUR = /^(color|-webkit-text-fill-color)$/;

type Check = (nodes: ValueNode[]) => string | undefined;

const words = (nodes: ValueNode[]): ValueNode[] =>
  nodes.filter((n) => n.type !== "space" && n.type !== "div");

/** A literal number with its unit, or undefined for anything else (a function, a keyword). */
function literal(node: ValueNode | undefined): { n: number; unit: string } | undefined {
  if (!node || node.type !== "word") return undefined;
  const parsed = valueParser.unit(node.value);
  if (!parsed) return undefined;
  const n = Number(parsed.number);
  return Number.isFinite(n) ? { n, unit: parsed.unit.toLowerCase() } : undefined;
}

/** Only these keywords, nothing else. */
const keywords =
  (...allowed: string[]): Check =>
  (nodes) => {
    const list = words(nodes);
    return list.length > 0 &&
      list.every((n) => n.type === "word" && allowed.includes(n.value.toLowerCase()))
      ? undefined
      : `takes only ${allowed.join(", ")}`;
  };

/** A length a protected control can be sized to without vanishing. */
function largeEnough(value: { n: number; unit: string }): boolean {
  switch (value.unit) {
    case "px":
      return value.n >= 24;
    case "em":
    case "rem":
    case "ch":
      return value.n >= 1.5;
    case "%":
    case "vw":
    case "vh":
    case "vmin":
    case "vmax":
    case "dvh":
    case "svh":
    case "lvh":
      return value.n >= 10;
    default:
      return false;
  }
}

/** Every literal satisfies `ok`, keywords from `allowed` aside; functions and var() never do. */
const literals =
  (ok: (v: { n: number; unit: string }) => boolean, message: string, ...allowed: string[]): Check =>
  (nodes) => {
    const list = words(nodes);
    return list.length > 0 &&
      list.every((n) => {
        if (n.type === "word" && allowed.includes(n.value.toLowerCase())) return true;
        const v = literal(n);
        return v !== undefined && ok(v);
      })
      ? undefined
      : message;
  };

const CONTENT_KEYWORDS = ["auto", "fit-content", "min-content", "max-content"];

/** Width along the line: relative to the container, so it cannot push a control past the edge. */
const widths = literals(
  (v) => v.unit === "%" && v.n >= 50 && v.n <= 100,
  "takes a content keyword or 50%-100%: a fixed width could push the control out of the header",
  ...CONTENT_KEYWORDS,
);
/** An upper bound may be anything that is not small. */
const maxSizes = literals(
  largeEnough,
  "takes none or a literal of at least 24px (1.5em, 10%)",
  "none",
  ...CONTENT_KEYWORDS,
);
/** Height does not push anything along the header. */
const heights = literals(
  (v) => largeEnough(v) && (v.unit !== "px" || v.n <= 256),
  "takes a content keyword or a literal from 24px to 256px",
  ...CONTENT_KEYWORDS,
);

const margins = literals(
  (v) =>
    (v.unit === "px" && Math.abs(v.n) <= 8) ||
    (/^r?em$/.test(v.unit) && Math.abs(v.n) <= 0.5) ||
    v.n === 0,
  "takes auto or a literal within 8px (0.5em)",
  "auto",
);
const paddings = literals(
  (v) =>
    (v.unit === "px" && v.n >= 0 && v.n <= 16) ||
    (/^r?em$/.test(v.unit) && v.n >= 0 && v.n <= 1) ||
    v.n === 0,
  "takes a literal from 0 to 16px (1em)",
);
const gaps = literals(
  (v) =>
    (v.unit === "px" && v.n >= 0 && v.n <= 16) ||
    (/^r?em$/.test(v.unit) && v.n >= 0 && v.n <= 1) ||
    v.n === 0,
  "takes normal or a literal from 0 to 16px (1em)",
  "normal",
);
const indent = literals(
  (v) => (v.unit === "px" && v.n >= 0 && v.n <= 8) || v.n === 0,
  "takes a literal from 0 to 8px",
);

/** Border widths: a literal up to 2px, or `thin`. Colours, styles and tokens around it are free. */
const borderWidth: Check = (nodes) => {
  for (const node of words(nodes)) {
    if (node.type === "function") {
      // A colour is all a function may be here: a token or a literal colour, never a length.
      const problem = colourProblem(node);
      if (problem) return `takes literal widths and colours; this ${problem}`;
      continue;
    }
    if (node.type !== "word") continue;
    const v = literal(node);
    if (v) {
      if (!((v.unit === "px" && v.n >= 0 && v.n <= 2) || v.n === 0))
        return "takes widths up to 2px";
    } else if (/^(medium|thick)$/i.test(node.value)) {
      return "takes widths up to 2px (thin)";
    }
  }
  return undefined;
};

/** Font size: absolute and bounded, or relative but never smaller - `0.6em` nests to nothing. */
const fontSize = literals(
  (v) =>
    (v.unit === "px" && v.n >= 10 && v.n <= 32) ||
    (v.unit === "rem" && v.n >= 0.625 && v.n <= 2) ||
    (v.unit === "em" && v.n >= 1 && v.n <= 2) ||
    (v.unit === "%" && v.n >= 100 && v.n <= 200),
  "takes 10px-32px, 0.625rem-2rem, or 1em-2em (100%-200%)",
  "inherit",
  "medium",
  "large",
  "x-large",
);

const opacity: Check = (nodes) => {
  const list = words(nodes);
  const v = list.length === 1 ? literal(list[0]) : undefined;
  if (!v) return "takes a literal number";
  // At least 0.9: opacity multiplies down the nested elements, and four of them at 0.9 still show.
  const ok = v.unit === "%" ? v.n >= 90 : v.unit === "" && v.n >= 0.9;
  return ok ? undefined : "takes a literal of at least 0.9 (90%)";
};

const spacing: Check = (nodes) => {
  const list = words(nodes);
  if (list.length === 1 && list[0]!.type === "word" && /^normal$/i.test(list[0]!.value))
    return undefined;
  const v = list.length === 1 ? literal(list[0]) : undefined;
  const ok =
    v !== undefined &&
    (v.unit === "px"
      ? Math.abs(v.n) <= 8
      : v.unit === "em" || v.unit === "rem"
        ? Math.abs(v.n) <= 0.5
        : v.n === 0);
  return ok ? undefined : "takes normal or a literal within 8px (0.5em)";
};

/** Filters that change colour but cannot make a control vanish. */
const filter: Check = (nodes) => {
  const list = words(nodes);
  if (list.length === 1 && list[0]!.type === "word" && /^none$/i.test(list[0]!.value))
    return undefined;
  for (const node of list) {
    if (node.type !== "function") return "takes none or colour filters";
    const name = node.value.toLowerCase();
    if (!/^(grayscale|sepia|hue-rotate|saturate|invert|drop-shadow)$/.test(name)) {
      return `${name}() can hide a control and is not accepted here`;
    }
  }
  return undefined;
};

const CHECKED: Record<string, Check> = {
  display: (nodes) =>
    words(nodes).some((n) => n.type !== "word" || /^none$/i.test(n.value))
      ? "may not be none"
      : undefined,
  visibility: keywords("visible"),
  "pointer-events": keywords("auto"),
  "content-visibility": keywords("visible", "auto"),
  opacity,
  clip: keywords("auto"),
  "clip-path": keywords("none"),
  mask: keywords("none"),
  "mask-image": keywords("none"),
  "-webkit-mask": keywords("none"),
  "-webkit-mask-image": keywords("none"),
  filter,
  "backdrop-filter": keywords("none"),
  // Transforms compose down the nested elements and with each other, in units that convert into
  // one another, so none is accepted on a control or what contains it.
  transform: keywords("none"),
  translate: keywords("none"),
  scale: keywords("none"),
  rotate: keywords("none"),
  width: widths,
  "min-width": widths,
  "inline-size": widths,
  "min-inline-size": widths,
  "flex-basis": widths,
  "max-width": maxSizes,
  "max-inline-size": maxSizes,
  "max-height": maxSizes,
  "max-block-size": maxSizes,
  height: heights,
  "min-height": heights,
  "block-size": heights,
  "min-block-size": heights,
  "font-size": fontSize,
  "line-height": (nodes) => {
    const list = words(nodes);
    if (list.length === 1 && list[0]!.type === "word" && /^normal$/i.test(list[0]!.value))
      return undefined;
    const v = list.length === 1 ? literal(list[0]) : undefined;
    return v && ((v.unit === "" && v.n >= 1) || largeEnough(v) || (v.unit === "px" && v.n >= 12))
      ? undefined
      : "takes normal or a literal of at least 1";
  },
  padding: paddings,
  "padding-top": paddings,
  "padding-right": paddings,
  "padding-bottom": paddings,
  "padding-left": paddings,
  "padding-inline": paddings,
  "padding-block": paddings,
  "padding-inline-start": paddings,
  "padding-inline-end": paddings,
  "padding-block-start": paddings,
  "padding-block-end": paddings,
  gap: gaps,
  "row-gap": gaps,
  "column-gap": gaps,
  border: borderWidth,
  "border-width": borderWidth,
  "border-top": borderWidth,
  "border-right": borderWidth,
  "border-bottom": borderWidth,
  "border-left": borderWidth,
  "border-inline": borderWidth,
  "border-block": borderWidth,
  "border-inline-start": borderWidth,
  "border-inline-end": borderWidth,
  "border-block-start": borderWidth,
  "border-block-end": borderWidth,
  "border-top-width": borderWidth,
  "border-right-width": borderWidth,
  "border-bottom-width": borderWidth,
  "border-left-width": borderWidth,
  "border-inline-width": borderWidth,
  "border-block-width": borderWidth,
  "border-inline-start-width": borderWidth,
  "border-inline-end-width": borderWidth,
  "border-block-start-width": borderWidth,
  "border-block-end-width": borderWidth,
  overflow: keywords("visible"),
  "overflow-x": keywords("visible"),
  "overflow-y": keywords("visible"),
  "letter-spacing": spacing,
  "word-spacing": spacing,
  // The account control and the menu button are positioned: an offset would move them.
  top: keywords("auto"),
  right: keywords("auto"),
  bottom: keywords("auto"),
  left: keywords("auto"),
  inset: keywords("auto"),
  "inset-inline": keywords("auto"),
  "inset-block": keywords("auto"),
  "inset-inline-start": keywords("auto"),
  "inset-inline-end": keywords("auto"),
  "inset-block-start": keywords("auto"),
  "inset-block-end": keywords("auto"),
  margin: margins,
  "margin-top": margins,
  "margin-right": margins,
  "margin-bottom": margins,
  "margin-left": margins,
  "margin-inline": margins,
  "margin-block": margins,
  "margin-inline-start": margins,
  "margin-inline-end": margins,
  "margin-block-start": margins,
  "margin-block-end": margins,
  "text-indent": indent,
  order: (nodes) => (literal(words(nodes)[0])?.unit === "" ? undefined : "takes a literal integer"),
  flex: literals(
    (v) => v.unit === "" && v.n >= 0,
    "takes auto, none or factors; a basis goes in flex-basis",
    "auto",
    "none",
    "initial",
  ),
  "flex-grow": literals((v) => v.unit === "" && v.n >= 0, "takes a factor"),
  "flex-shrink": literals((v) => v.unit === "" && v.n >= 0, "takes a factor"),
};

/** Public tokens set where a protected control inherits them. */
const TOKENS: Record<string, Check | "colour"> = {
  "--portal-header-height": heights,
  "--portal-footer-height": heights,
  "--portal-content-width": literals(
    (v) => v.unit === "px" && v.n >= 640,
    "takes a literal of at least 640px",
  ),
  // The header's own padding: it adds to the chain, so it is held to the per-element budget.
  "--portal-shell-padding": paddings,
  "--portal-type-scale": (nodes) => {
    const v = literal(words(nodes)[0]);
    return v && v.unit === "" && v.n >= 0.5 ? undefined : "takes a literal factor of at least 0.5";
  },
};

/**
 * The framework properties the `--portal-color-*` tokens map onto, as a stylesheet's `var()` names
 * them once mapped. Every other token is a length, a factor or a font: never a colour to rely on.
 */
let colourVars: ReadonlySet<string> | undefined;
function colourTokenVars(): ReadonlySet<string> {
  colourVars ??= new Set(
    Object.entries(styleApi().tokens)
      .filter(([token]) => token.startsWith("--portal-color-"))
      .map(([, target]) => target),
  );
  return colourVars;
}

const COLOUR_FUNCTIONS = /^(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)$/i;
const COLOUR_SPACES =
  /^(srgb|srgb-linear|display-p3|a98-rgb|prophoto-rgb|rec2020|xyz|xyz-d50|xyz-d65)$/i;

/** An alpha a reader can see: at least one half. */
function visibleAlpha(v: { n: number; unit: string }): boolean {
  return v.unit === "%" ? v.n >= 50 : v.unit === "" && v.n >= 0.5;
}

/**
 * Why one colour value cannot be shown to be visible, or undefined when it can. Accepted: a named
 * colour or `currentcolor`; a hex colour whose alpha, if any, is at least one half; a colour
 * function whose every argument is a literal and whose alpha, if any, is at least one half; and
 * `var()` of a colour token, with no fallback. Anything that needs evaluating - `calc()` inside
 * the alpha, `color-mix()`, a length token, a `--site-*` property - is refused.
 */
export function colourProblem(node: ValueNode): string | undefined {
  if (node.type === "word") {
    const value = node.value.toLowerCase();
    if (value === "transparent") return "is transparent";
    const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(value);
    if (hex) {
      const digits = hex[1]!;
      const alpha =
        digits.length === 4
          ? Number.parseInt(digits[3]!.repeat(2), 16)
          : digits.length === 8
            ? Number.parseInt(digits.slice(6), 16)
            : 255;
      return alpha >= 128 ? undefined : "has an alpha below one half";
    }
    if (value.startsWith("#")) return "is not a colour";
    if (literal(node)) return "is not a colour";
    return /^[a-z]+$/.test(value) ? undefined : "is not a colour";
  }
  if (node.type !== "function") return "is not a colour";
  const name = node.value.toLowerCase();
  if (name === "var") {
    const args = node.nodes.filter((n) => n.type !== "space");
    const ref = args[0]?.type === "word" ? args[0].value : "";
    if (args.length !== 1) return "uses var() with a fallback, which cannot be checked";
    return colourTokenVars().has(ref) ? undefined : `uses var(${ref}), which is not a colour token`;
  }
  if (!COLOUR_FUNCTIONS.test(name)) return `uses ${name}(), which cannot be checked`;
  const parts = node.nodes.filter((n) => n.type !== "space");
  if (parts.some((n) => n.type !== "word" && n.type !== "div")) {
    return `has an argument of ${name}() that needs evaluating`;
  }
  // Every argument is a literal number. Keywords are where a colour stops being literal: a
  // relative colour (`rgb(from transparent r g b)`) takes its channels - alpha included - from
  // another colour, and `none` is a missing channel, which for alpha means zero. Only the colour
  // space that `color()` names comes first as a word.
  const args = parts.filter((n) => n.type === "word");
  for (const [index, arg] of args.entries()) {
    if (name === "color" && index === 0) {
      if (!COLOUR_SPACES.test(arg.value)) return `names ${arg.value}, which is not a colour space`;
      continue;
    }
    if (!literal(arg)) {
      return /^from$/i.test(arg.value)
        ? `is a relative colour, which takes its alpha from another colour and cannot be checked`
        : `has '${arg.value}' in ${name}(), which is not a literal`;
    }
  }
  const slash = parts.findIndex((n) => n.type === "div" && n.value === "/");
  const commas = parts.filter((n) => n.type === "div" && n.value === ",").length;
  const alphaNode =
    slash >= 0 ? parts[slash + 1] : commas === 3 ? parts[parts.length - 1] : undefined;
  if (!alphaNode) return undefined;
  const alpha = literal(alphaNode);
  if (!alpha) return `has an alpha of ${name}() that is not a literal`;
  return visibleAlpha(alpha) ? undefined : "has an alpha below one half";
}

/** Every colour in a value, each provably visible; `others` says which words are not colours. */
function colours(
  nodes: ValueNode[],
  others: (word: string) => boolean = () => false,
): string | undefined {
  for (const node of words(nodes)) {
    if (node.type === "word" && others(node.value)) continue;
    const problem = colourProblem(node);
    if (problem) return problem;
  }
  return undefined;
}

/**
 * Why a declaration may not appear on a rule that can match a protected control, or undefined
 * when it is provably safe. `hasVar` values are never provable: a custom property can hold
 * anything at runtime.
 */
export function protectedViolation(
  property: string,
  value: string,
  hasVar: boolean,
): string | undefined {
  const nodes = valueParser(value).nodes;
  if (COLOUR.test(property) || property.startsWith("--portal-color-")) {
    const problem = colours(nodes, (word) =>
      /^(inherit|initial|unset|revert|revert-layer)$/i.test(word),
    );
    return problem
      ? `${property}: ${value} ${problem}, so the control could be invisible`
      : undefined;
  }
  if (property.startsWith("--portal-")) {
    const check = TOKENS[property];
    if (!check || check === "colour") return undefined;
    if (hasVar) return `${property} through var() cannot be checked`;
    const problem = check(nodes);
    return problem ? `${property}: ${value} - ${property} ${problem}` : undefined;
  }
  if (FREE.test(property)) return undefined;
  const check = CHECKED[property];
  if (!check) return `${property} is not accepted on a rule that can match a protected control`;
  // A border names its colour too; its check reads var() itself and accepts colour tokens only.
  if (hasVar && check !== borderWidth) return `${property} through var() cannot be checked`;
  const problem = check(nodes);
  return problem ? `${property}: ${value} - ${property} ${problem}` : undefined;
}

/** What generated content on a protected control may be: glyphs in the flow, never a surface. */
const PSEUDO = new RegExp(
  "^(" +
    [
      "content",
      "color",
      "font-family",
      "font-weight",
      "font-style",
      "font-variant(-[a-z-]+)?",
      "text-transform",
      "text-decoration(-[a-z-]+)?",
      "vertical-align",
      "display",
      "visibility",
      "opacity",
      "speak",
      "--site-[a-z0-9-]+",
    ].join("|") +
    ")$",
);

/**
 * For `::before` and `::after` of something that can be a protected control: decorative glyphs in
 * the flow. Hiding the generated content is fine; painting a surface, positioning or transforming
 * it is not, since it could then cover the control it belongs to.
 */
export function pseudoViolation(
  property: string,
  value: string,
  hasVar: boolean,
): string | undefined {
  const nodes = valueParser(value).nodes;
  if (property === "content") {
    // A glyph or two - an arrow, a bullet - and never a run of text that widens the control.
    // What renders is every string together, so the limit is on their total; counters render
    // numbers of any length and are not offered here.
    let total = 0;
    let other = false;
    for (const node of words(nodes)) {
      if (node.type === "string") total += [...cssUnescape(node.value)].length;
      else if (!(node.type === "word" && /^(none|normal)$/i.test(node.value))) other = true;
    }
    if (other) return "content on a protected control takes strings only";
    return total > 3
      ? `content on a protected control is at most three characters in all; this is ${total}`
      : undefined;
  }
  if (PSEUDO.test(property)) return undefined;
  const bounded: Record<string, Check> = {
    "font-size": fontSize,
    "letter-spacing": spacing,
    "margin-left": nonNegative,
    "margin-right": nonNegative,
    "margin-inline": nonNegative,
    "margin-inline-start": nonNegative,
    "margin-inline-end": nonNegative,
  };
  const check = bounded[property];
  if (!check)
    return `${property} is not accepted on generated content of a protected control: it could cover the control`;
  if (hasVar) return `${property} through var() cannot be checked`;
  const problem = check(nodes);
  return problem ? `${property}: ${value} - ${property} ${problem}` : undefined;
}

const nonNegative = literals(
  (v) => (v.unit === "px" && v.n >= 0 && v.n <= 8) || v.n === 0,
  "takes a literal from 0 to 8px",
);

/** A focus indicator that provably shows: a visible style, a width, a colour that is not clear. */
const OUTLINE_STYLES = /^(auto|solid|dashed|dotted|double|groove|ridge|inset|outset)$/i;

function outlineViolation(property: string, value: string, hasVar: boolean): string | undefined {
  if (!/^outline(-style|-width|-color|-offset)?$/.test(property)) return undefined;
  const nodes = valueParser(value).nodes;
  const list = words(nodes);
  // Colours must be provably visible; widths, offsets and styles are literals. A var() is a
  // colour token or nothing: a length token can be zero.
  if (property === "outline-color") {
    const problem = colours(nodes);
    if (problem)
      return `outline-color: ${value} ${problem}; a focus indicator has to be provably visible`;
    return undefined;
  }
  if (property === "outline") {
    const problem = colours(
      nodes,
      (word) =>
        OUTLINE_STYLES.test(word) ||
        /^(none|hidden|thin|medium|thick|invert)$/i.test(word) ||
        literal({ type: "word", value: word } as ValueNode) !== undefined,
    );
    if (problem)
      return `outline: ${value} ${problem}; a focus indicator has to be provably visible`;
  } else if (hasVar || list.some((n) => n.type === "function")) {
    return `${property}: ${value} - takes literals only; a focus indicator has to be provably visible`;
  }
  const width = (v: { n: number; unit: string }): boolean =>
    (v.unit === "px" && v.n >= 1 && v.n <= 8) ||
    (/^r?em$/.test(v.unit) && v.n >= 0.0625 && v.n <= 0.5);
  switch (property) {
    case "outline-style":
      return list.length === 1 && list[0]!.type === "word" && OUTLINE_STYLES.test(list[0]!.value)
        ? undefined
        : `outline-style: ${value} - takes a visible style`;
    case "outline-width":
      return literals(
        width,
        "takes thin, medium, thick or 1px-8px",
        "thin",
        "medium",
        "thick",
      )(nodes)
        ? `outline-width: ${value} - takes thin, medium, thick or 1px-8px`
        : undefined;
    case "outline-offset":
      return literals(
        (v) => (v.unit === "px" && Math.abs(v.n) <= 8) || v.n === 0,
        `outline-offset: ${value} - takes a literal within 8px`,
      )(nodes);
    case "outline": {
      // The shorthand resets what it leaves out: without a style the outline is `none`.
      let style = false;
      for (const node of list) {
        if (node.type !== "word") continue;
        if (OUTLINE_STYLES.test(node.value)) style = true;
        else if (/^(none|hidden)$/i.test(node.value))
          return `outline: ${value} removes the focus indicator`;
        const v = literal(node);
        if (v && !width(v)) return `outline: ${value} - its width takes 1px-8px`;
      }
      return style ? undefined : `outline: ${value} - names no visible style, so it is none`;
    }
    default:
      return undefined;
  }
}

/** Transitions may not hold a change back: a long delay or duration would hide a focus ring. */
function transitionViolation(property: string, value: string, hasVar: boolean): string | undefined {
  if (!/^transition(-duration|-delay|-behavior)?$/.test(property)) return undefined;
  if (hasVar) return `${property} through var() cannot be checked`;
  let problem: string | undefined;
  valueParser.walk(valueParser(value).nodes, (node) => {
    if (node.type === "function" && !/^(cubic-bezier|steps)$/i.test(node.value))
      problem = `${node.value}() cannot be checked`;
    if (node.type === "word" && /^allow-discrete$/i.test(node.value))
      problem = "allow-discrete would delay a change that is otherwise immediate";
    const v = literal(node);
    if (v && ((v.unit === "s" && v.n > 1) || (v.unit === "ms" && v.n > 1000)))
      problem = "a duration or delay over 1s";
  });
  return problem ? `${property}: ${value} - ${problem}` : undefined;
}

/**
 * On every rule: nothing may be lifted over the chrome, remove a focus indicator or hold one back,
 * and no colour token may be made clear. The framework raises the account control and the menu
 * button to z-index 11; consumer content stays at 10 or below and is never fixed to the viewport.
 * Any element can take focus, and the framework's `:focus-visible` outline is in a lower layer
 * than the consumer's, so outlines are checked everywhere, not only on `:focus-visible` rules.
 */
export function globalViolation(
  property: string,
  value: string,
  hasVar: boolean,
): string | undefined {
  if (property.startsWith("--portal-color-")) {
    const nodes = valueParser(value).nodes;
    const problem = words(nodes).length === 1 ? colours(nodes) : "is not a single colour";
    if (problem)
      return `${property}: ${value} ${problem}; a colour token has to be provably visible`;
  }
  const outline = outlineViolation(property, value, hasVar);
  if (outline) return outline;
  const transition = transitionViolation(property, value, hasVar);
  if (transition) return transition;
  if (property !== "position" && property !== "z-index") return undefined;
  if (hasVar) return `${property} through var() cannot be checked`;
  const list = words(valueParser(value).nodes);
  if (property === "position") {
    return list.some((n) => n.type === "word" && /^fixed$/i.test(n.value))
      ? "position: fixed could cover the portal's controls"
      : undefined;
  }
  if (list.length === 1 && list[0]!.type === "word" && /^auto$/i.test(list[0]!.value))
    return undefined;
  const v = list.length === 1 ? literal(list[0]) : undefined;
  return v && v.unit === "" && Number.isInteger(v.n) && v.n <= 10
    ? undefined
    : `z-index: ${value} - z-index takes auto or a literal integer of at most 10`;
}
