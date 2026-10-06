// portal-style-v1: a restricted local stylesheet, parsed and enforced by the builder.
//
// The stylesheet may style the public parts (`schema/style-parts-v1.json`) and the consumer's own
// `.site-*` slot markup, through tokens, part, variant and state attributes - and nothing else.
// Every selector, at-rule and value is checked against closed lists after comments are removed
// and escapes decoded, and what ships is re-serialized from the checked form rather than copied,
// so the bytes a browser reads are the bytes that were checked. It cannot fetch anything (local
// files only, published under the portal's own origin), cannot hide or disable a protected
// control, and cannot name a framework internal.

import { createRequire } from "node:module";
import postcss, {
  type AtRule,
  type ChildNode,
  type Container,
  type Declaration,
  type Rule,
} from "postcss";
import type {
  Node as SelectorNode,
  Root as SelectorRoot,
  Selector as SelectorList,
} from "postcss-selector-parser";
import type { FunctionNode, Node as ValueNode, StringNode } from "postcss-value-parser";
import type { Diagnostic, SourcePosition } from "../diagnostics.js";
import { CREDENTIAL_PATTERN } from "../model/credentials.js";
import { allVariants, styleApi, type StyleApi } from "./api.js";
import { canonicalValue, cssUnescape, stripComments } from "./css-text.js";
import { globalViolation, protectedViolation, pseudoViolation } from "./visibility.js";

// Both parsers are CommonJS with `export =` typings; required, so every TypeScript configuration
// that reads this file (the build's and the template checker's) types them the same way.
const require = createRequire(import.meta.url);
/* eslint-disable @typescript-eslint/consistent-type-imports -- the type of a required module */
const selectorParser =
  require("postcss-selector-parser") as typeof import("postcss-selector-parser");
const valueParser = require("postcss-value-parser") as typeof import("postcss-value-parser");
/* eslint-enable @typescript-eslint/consistent-type-imports */

export interface StyleCheckContext {
  /** Source-root-relative path of the stylesheet, for diagnostics. */
  file: string;
  /** Features this build does not ship; rules that can only match their parts are pruned. */
  disabledFeatures: ReadonlySet<string>;
  /** Parts that hold a protected part in this portal (static ones come from the API). */
  dynamicProtectedParts?: ReadonlySet<string>;
  /** `.site-*` classes whose elements contain a protected part, from the slot templates. */
  protectedSiteClasses?: ReadonlySet<string>;
  /**
   * Resolve a local reference (relative to the stylesheet) to its published URL, or report why
   * not and return undefined. `kind` says what the reference may be.
   */
  resolveAsset(ref: string, kind: "image" | "font", position: SourcePosition): string | undefined;
  /** Upper bound on the source size, in bytes. */
  maxBytes?: number;
}

export interface PrunedRule {
  selector: string;
  features: string[];
  line: number;
}

export interface StyleCheckResult {
  /** The checked stylesheet body, to be placed inside the consumer layer. Absent on error. */
  css?: string;
  diagnostics: Diagnostic[];
  pruned: PrunedRule[];
  /** Rules kept, for the report. */
  rules: number;
}

const MAX_BYTES = 256 * 1024;

const ALLOWED_PSEUDO_CLASSES = new Set([
  ":hover",
  ":focus-visible",
  ":active",
  ":first-child",
  ":last-child",
  ":nth-child",
  ":not",
  ":is",
  ":where",
]);
const ALLOWED_PSEUDO_ELEMENTS = new Set(["::before", "::after"]);
const PUBLIC_ATTRIBUTES = new Set(["data-part", "data-variant", "data-state", "data-theme"]);

/** Element types a slot template can emit, the only ones a type selector may name. */
const CONSUMER_ELEMENTS = new Set([
  "a",
  "img",
  "picture",
  "source",
  "svg",
  "span",
  "div",
  "p",
  "ul",
  "ol",
  "li",
  "section",
  "strong",
  "em",
  "small",
  "br",
  "hr",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "address",
  "figure",
  "figcaption",
  "time",
]);

/** Slot containers: a type selector is allowed under one of these, or under a `.site-*` class. */
const SLOT_CONTAINER_PARTS = new Set([
  "header-extra",
  "footer-top",
  "footer-columns",
  "footer-bottom",
  "section-shell",
  "prose-aside",
]);

const ALLOWED_FUNCTIONS = new Set([
  "var",
  "calc",
  "min",
  "max",
  "clamp",
  "rgb",
  "rgba",
  "hsl",
  "hsla",
  "hwb",
  "lab",
  "lch",
  "oklab",
  "oklch",
  "color",
  "color-mix",
  "linear-gradient",
  "radial-gradient",
  "conic-gradient",
  "repeating-linear-gradient",
  "repeating-radial-gradient",
  "repeating-conic-gradient",
  "url",
  "image-set",
  "counter",
  "counters",
  "cubic-bezier",
  "steps",
  "translate",
  "translatex",
  "translatey",
  "translate3d",
  "scale",
  "scalex",
  "scaley",
  "rotate",
  "skew",
  "skewx",
  "skewy",
  "matrix",
  "perspective",
  "minmax",
  "repeat",
  "fit-content",
  "blur",
  "brightness",
  "contrast",
  "drop-shadow",
  "grayscale",
  "hue-rotate",
  "invert",
  "saturate",
  "sepia",
  "format",
]);

const FORBIDDEN_PROPERTIES = new Set([
  "behavior",
  "-ms-behavior",
  "-moz-binding",
  "-ms-filter",
  "-webkit-user-modify",
]);

const FONT_FACE_DESCRIPTORS = new Set([
  "font-family",
  "src",
  "font-weight",
  "font-style",
  "font-stretch",
  "font-display",
  "unicode-range",
  "size-adjust",
  "ascent-override",
  "descent-override",
  "line-gap-override",
]);

const MEDIA_FEATURES =
  /^(min-|max-)?(width|height)\s*:\s*[0-9.]+(px|em|rem)$|^prefers-color-scheme\s*:\s*(light|dark)$|^prefers-reduced-motion\s*:\s*(reduce|no-preference)$|^orientation\s*:\s*(portrait|landscape)$|^(width|height)\s*(<=|>=|<|>)\s*[0-9.]+(px|em|rem)$/;

interface SelectorAnalysis {
  /** Canonical text. */
  text: string;
  /** Canonical text of each complex selector, in order. */
  complex: string[];
  /** Parts each complex selector requires (outside :is/:where/:not). */
  required: string[][];
  /** Whether the subject of any complex selector could be a protected element or its ancestor. */
  canMatchProtected: boolean;
  /** Whether a `::before`/`::after` subject could belong to a protected control. */
  canMatchProtectedPseudo: boolean;
}

export function checkStylesheet(source: string, ctx: StyleCheckContext): StyleCheckResult {
  const api = styleApi();
  const diagnostics: Diagnostic[] = [];
  const pruned: PrunedRule[] = [];
  const bytes = Buffer.byteLength(source, "utf8");
  if (bytes > (ctx.maxBytes ?? MAX_BYTES)) {
    diagnostics.push({
      code: "FP1407",
      severity: "error",
      message: `The stylesheet is ${bytes} bytes; portal-style-v1 accepts at most ${ctx.maxBytes ?? MAX_BYTES}.`,
      file: ctx.file,
    });
    return { diagnostics, pruned, rules: 0 };
  }

  let root: postcss.Root;
  try {
    root = postcss.parse(source, { from: ctx.file });
  } catch (error) {
    const e = error as { reason?: string; line?: number; column?: number; message: string };
    diagnostics.push({
      code: "FP1901",
      severity: "error",
      message: `The stylesheet could not be parsed: ${e.reason ?? e.message}.`,
      file: ctx.file,
      ...(e.line ? { position: { line: e.line, ...(e.column ? { column: e.column } : {}) } } : {}),
    });
    return { diagnostics, pruned, rules: 0 };
  }

  const fail = (
    code: string,
    message: string,
    node: { source?: postcss.Source },
    hint?: string,
  ): void => {
    const start = node.source?.start;
    diagnostics.push({
      code,
      severity: "error",
      message,
      file: ctx.file,
      ...(start ? { position: { line: start.line, column: start.column } } : {}),
      ...(hint ? { hint } : {}),
    });
  };

  root.walkComments((comment) => {
    comment.remove();
  });

  const protectedParts = new Set(
    Object.entries(api.parts)
      .filter(([, spec]) => spec.protected || spec.containsProtected)
      .map(([name]) => name),
  );
  for (const part of ctx.dynamicProtectedParts ?? []) protectedParts.add(part);
  const protectedClasses = ctx.protectedSiteClasses ?? new Set<string>();
  const variants = allVariants(api);
  let kept = 0;

  const checkSelector = (rule: Rule): SelectorAnalysis | undefined => {
    const text = cssUnescape(stripComments(rule.selector)).trim();
    let ok = true;
    const required: string[][] = [];
    let canMatchProtected = false;
    let canMatchProtectedPseudo = false;
    const complexTexts: string[] = [];
    const report = (message: string, hint?: string): void => {
      ok = false;
      fail("FP1902", message, rule, hint);
    };

    let ast: SelectorRoot;
    try {
      ast = selectorParser().astSync(stripComments(rule.selector));
    } catch (error) {
      report(`Selector '${text}' could not be parsed: ${(error as Error).message}.`);
      return undefined;
    }

    /**
     * One compound (the simple selectors between two combinators). Returns its canonical text,
     * the parts it requires, and what its subject could be.
     */
    const compound = (
      nodes: SelectorNode[],
      opts: { nested: boolean; first: boolean; consumerContext: boolean; last: boolean },
    ): { text: string; parts: string[]; siteClasses: string[]; kinds: Set<string> } | undefined => {
      let out = "";
      const parts: string[] = [];
      const siteClasses: string[] = [];
      const kinds = new Set<string>();
      for (const node of nodes) {
        switch (node.type) {
          case "tag": {
            const name = node.value.toLowerCase();
            if (!CONSUMER_ELEMENTS.has(name)) {
              report(`Element selector '${node.value}' is not one a slot template can emit.`);
              return undefined;
            }
            if (!opts.consumerContext) {
              report(
                `Element selector '${node.value}' outside slot content. Type selectors apply only inside a .site-* element or a slot container.`,
                "Scope it, for example `.site-footer-note a`, or style the part through [data-part=…].",
              );
              return undefined;
            }
            out += name;
            kinds.add("tag");
            break;
          }
          case "universal":
            report("The universal selector '*' is not part of portal-style-v1.");
            return undefined;
          case "id":
            report(
              `ID selector '#${node.value}' is not part of portal-style-v1.`,
              "Style a public part with [data-part=…], or a .site-* class in your own slot markup.",
            );
            return undefined;
          case "class": {
            const value = node.value;
            if (!new RegExp(`^${api.consumerClassPrefix}[a-z0-9][a-z0-9-]*$`).test(value)) {
              report(
                `Class '.${value}' is not public. Only .${api.consumerClassPrefix}* classes from slot templates may be named.`,
                "Framework class names are internal and may change in any release; use [data-part=…].",
              );
              return undefined;
            }
            out += `.${value}`;
            siteClasses.push(value);
            kinds.add("class");
            break;
          }
          case "attribute": {
            const attr = node.attribute.toLowerCase();
            if (node.namespace || !PUBLIC_ATTRIBUTES.has(attr) || node.insensitive) {
              report(
                `Attribute selector '[${node.attribute}]' is not public. Use data-part, data-variant, data-state or data-theme.`,
              );
              return undefined;
            }
            const operator = node.operator;
            const value = node.value;
            if (attr === "data-state" && operator === undefined) {
              out += "[data-state]";
              kinds.add("state");
              break;
            }
            if (operator !== "=" || value === undefined) {
              report(`'[${attr}]' takes exactly one value with '=': [${attr}=…].`);
              return undefined;
            }
            if (attr === "data-part") {
              const spec = api.parts[value];
              if (!spec) {
                report(
                  `Unknown part '${value}'. The parts are listed in schema/style-parts-v1.json.`,
                );
                return undefined;
              }
              parts.push(value);
              kinds.add(protectedParts.has(value) ? "protected-part" : "part");
            } else if (attr === "data-variant") {
              if (!variants.has(value)) {
                report(`Unknown variant '${value}'.`);
                return undefined;
              }
              kinds.add("variant");
            } else if (attr === "data-state") {
              if (!(value in api.states)) {
                report(`Unknown state '${value}'.`);
                return undefined;
              }
              kinds.add("state");
            } else {
              if (!api.themes.includes(value)) {
                report(`Unknown theme '${value}': light or dark.`);
                return undefined;
              }
              kinds.add("root");
            }
            out += `[${attr}="${value}"]`;
            break;
          }
          case "pseudo": {
            const name = node.value.toLowerCase();
            if (name.startsWith("::") || name === ":before" || name === ":after") {
              if (!ALLOWED_PSEUDO_ELEMENTS.has(name) || !opts.last || opts.nested) {
                report(
                  `Pseudo-element '${node.value}' is not allowed here. ::before and ::after may end a selector.`,
                );
                return undefined;
              }
              out += name;
              kinds.add("pseudo-element");
              break;
            }
            if (name === ":root") {
              if (!opts.first || opts.nested) {
                report("':root' may only start a selector.");
                return undefined;
              }
              out += ":root";
              kinds.add("root");
              break;
            }
            if (!ALLOWED_PSEUDO_CLASSES.has(name)) {
              report(`Pseudo-class '${node.value}' is not part of portal-style-v1.`);
              return undefined;
            }
            if (name === ":nth-child") {
              const arg = node.nodes
                .map((n) => n.toString())
                .join("")
                .trim();
              if (!/^(odd|even|[+-]?\d*n(\s*[+-]\s*\d+)?|[+-]?\d+)$/.test(arg)) {
                report(`':nth-child(${arg})' takes an+b, odd or even.`);
                return undefined;
              }
              out += `:nth-child(${arg.replace(/\s+/g, "")})`;
              break;
            }
            if (name === ":not" || name === ":is" || name === ":where") {
              if (opts.nested) {
                report(`'${name}()' may not be nested.`);
                return undefined;
              }
              const args: string[] = [];
              for (const inner of node.nodes as SelectorList[]) {
                if (inner.nodes.some((n) => n.type === "combinator")) {
                  report(`'${name}()' takes simple selectors only, without combinators.`);
                  return undefined;
                }
                const sub = compound(inner.nodes, {
                  nested: true,
                  first: false,
                  consumerContext: opts.consumerContext,
                  last: false,
                });
                if (!sub) return undefined;
                args.push(sub.text);
                // `:not()` matches everything its argument does not, protected parts included.
                if (name === ":not") kinds.add("any");
                else for (const kind of sub.kinds) kinds.add(kind);
                if (name !== ":not") siteClasses.push(...sub.siteClasses);
              }
              out += `${name}(${args.join(", ")})`;
              break;
            }
            out += name;
            kinds.add("pseudo");
            break;
          }
          case "nesting":
            report("Nesting selectors ('&') are not part of portal-style-v1.");
            return undefined;
          default:
            report(`Selector component '${node.toString()}' is not part of portal-style-v1.`);
            return undefined;
        }
      }
      return { text: out, parts, siteClasses, kinds };
    };

    for (const selector of ast.nodes) {
      const groups: SelectorNode[][] = [[]];
      const combinators: string[] = [];
      for (const node of selector.nodes) {
        if (node.type === "combinator") {
          const value = node.value.trim() === "" ? " " : node.value.trim();
          if (value !== " " && value !== ">") {
            report(
              `Combinator '${value}' is not part of portal-style-v1: use descendant or '>' only.`,
            );
            return undefined;
          }
          combinators.push(value);
          groups.push([]);
        } else {
          groups[groups.length - 1]!.push(node);
        }
      }
      if (groups.some((g) => g.length === 0)) {
        report(`Selector '${selector.toString().trim()}' is incomplete.`);
        return undefined;
      }
      const texts: string[] = [];
      const needed: string[] = [];
      let consumerContext = false;
      let subject: { kinds: Set<string>; siteClasses: string[]; parts: string[] } | undefined;
      for (const [index, group] of groups.entries()) {
        const last = index === groups.length - 1;
        const result = compound(group, {
          nested: false,
          first: index === 0,
          consumerContext,
          last,
        });
        if (!result) return undefined;
        texts.push(result.text);
        needed.push(...result.parts);
        if (
          result.siteClasses.length > 0 ||
          result.parts.some((p) => SLOT_CONTAINER_PARTS.has(p))
        ) {
          consumerContext = true;
        }
        if (last) subject = result;
      }
      // A pseudo-element subject is generated content of the element, checked by its own rules.
      if (subject) {
        const k = subject.kinds;
        if (
          k.has("protected-part") ||
          k.has("root") ||
          k.has("tag") ||
          k.has("any") ||
          subject.siteClasses.some((c) => protectedClasses.has(c)) ||
          (!k.has("part") && !k.has("class"))
        ) {
          if (k.has("pseudo-element")) canMatchProtectedPseudo = true;
          else canMatchProtected = true;
        }
      }
      required.push(needed);
      complexTexts.push(
        texts
          .map((t, i) => (i === 0 ? t : `${combinators[i - 1] === ">" ? " > " : " "}${t}`))
          .join(""),
      );
    }
    if (!ok) return undefined;
    return {
      text: complexTexts.join(", "),
      complex: complexTexts,
      required,
      canMatchProtected,
      canMatchProtectedPseudo,
    };
  };

  /** Resolve `url()` / `image-set()` targets in a parsed value, in place. */
  const checkValue = (
    raw: string,
    node: Declaration | AtRule,
    opts: { property: string; fontFace?: boolean; custom?: boolean },
  ): { text: string; hasVar: boolean; words: string[]; ok: boolean } => {
    let ok = true;
    let hasVar = false;
    const words: string[] = [];
    const value = canonicalValue(raw).trim();
    const bad = (message: string, hint?: string): void => {
      ok = false;
      fail("FP1904", message, node, hint);
    };
    // A decoded `;`, `{` or `}` outside a string would end the declaration or the rule in the
    // re-serialized output: the one way an escape could smuggle structure past the parser.
    {
      let quote: string | undefined;
      for (let i = 0; i < value.length; i++) {
        const c = value[i]!;
        if (quote) {
          if (c === "\\") i += 1;
          else if (c === quote) quote = undefined;
          continue;
        }
        if (c === '"' || c === "'") quote = c;
        else if (c === ";" || c === "{" || c === "}" || c === "<" || c === "\\") {
          bad(`'${opts.property}' contains '${c}' outside a string.`);
          return { text: value, hasVar, words, ok: false };
        }
      }
    }
    const parsed = valueParser(value);
    const visitString = (text: string): string => cssUnescape(text).trim();
    const urlTarget = (
      target: string,
      kind: "image" | "font",
      fn: FunctionNode | StringNode,
    ): string | undefined => {
      const decoded = visitString(target);
      if (decoded === "") {
        bad("An empty url() is not allowed.");
        return undefined;
      }
      if (
        /^[a-z][a-z0-9+.-]*:/i.test(decoded) ||
        decoded.startsWith("//") ||
        decoded.startsWith("\\\\")
      ) {
        bad(
          `'${decoded}' is not a local file. portal-style-v1 loads nothing from another origin and accepts no data:, javascript: or protocol-relative URL.`,
          "Put the file under the source root and refer to it relative to the stylesheet.",
        );
        return undefined;
      }
      if (decoded.startsWith("#") || decoded.startsWith("/")) {
        bad(`'${decoded}' must be a path relative to the stylesheet, under the source root.`);
        return undefined;
      }
      const start = node.source?.start;
      return ctx.resolveAsset(decoded, kind, {
        line: start?.line ?? 1,
        ...(start?.column !== undefined ? { column: start.column + (fn.sourceIndex ?? 0) } : {}),
      });
    };

    const walk = (nodes: ValueNode[]): void => {
      for (const n of nodes) {
        if (n.type === "function") {
          const name = n.value.toLowerCase();
          if (name === "") {
            walk(n.nodes);
            continue;
          }
          if (name === "attr") {
            bad("attr() is not part of portal-style-v1; content takes strings, none or counters.");
            continue;
          }
          if (name === "expression" || !ALLOWED_FUNCTIONS.has(name)) {
            bad(`Function '${n.value}()' is not part of portal-style-v1.`);
            continue;
          }
          if (name === "url") {
            const target = n.nodes.length === 1 ? n.nodes[0]! : undefined;
            const text =
              target && (target.type === "word" || target.type === "string") ? target.value : "";
            const published = urlTarget(text, opts.fontFace ? "font" : "image", n);
            if (published) {
              n.nodes = [
                {
                  type: "string",
                  value: published,
                  quote: '"',
                  sourceIndex: 0,
                  sourceEndIndex: 0,
                } as StringNode,
              ];
            }
            continue;
          }
          if (name === "image-set") {
            for (const arg of n.nodes) {
              if (arg.type === "string") {
                const published = urlTarget(arg.value, "image", arg);
                if (published) arg.value = published;
              } else if (arg.type === "function") {
                walk([arg]);
              }
            }
            continue;
          }
          if (name === "var") {
            hasVar = true;
            const first = n.nodes[0];
            const ref = first?.type === "word" ? first.value : "";
            const mapped = mapCustomProperty(api, ref);
            if (!mapped) {
              bad(
                `var(${ref}) names a property that is not public. Use a --portal-* token from schema/style-parts-v1.json or your own --${api.consumerPropertyPrefix.slice(2)}* property.`,
              );
              continue;
            }
            if (first?.type === "word") first.value = mapped;
            walk(n.nodes.slice(1));
            continue;
          }
          walk(n.nodes);
          continue;
        }
        if (n.type === "word") {
          if (n.value.includes(":"))
            bad(`'${n.value}' is not a CSS value portal-style-v1 accepts.`);
          words.push(n.value.toLowerCase());
          continue;
        }
        if (n.type === "string") {
          if (CREDENTIAL_PATTERN.test(cssUnescape(n.value))) {
            fail("FP1210", "This string looks like a credential. Stylesheets are published.", node);
            ok = false;
          }
        }
      }
    };
    walk(parsed.nodes);
    if (CREDENTIAL_PATTERN.test(value.replace(/"[^"]*"|'[^']*'/g, ""))) {
      fail("FP1210", "This value looks like a credential. Stylesheets are published.", node);
      ok = false;
    }

    if (opts.property === "content" && !opts.custom) {
      for (const n of parsed.nodes) {
        if (n.type === "space" || n.type === "string") continue;
        if (n.type === "word" && ["none", "normal"].includes(n.value.toLowerCase())) continue;
        if (n.type === "function" && ["counter", "counters"].includes(n.value.toLowerCase()))
          continue;
        bad("'content' takes strings, none, normal or counter()/counters() only.");
        break;
      }
    }
    return { text: valueParser.stringify(parsed.nodes), hasVar, words, ok };
  };

  // Animations on protected controls: an animation can hide what a declaration may not, so the
  // keyframes it names are checked like declarations once the whole stylesheet has been read.
  const declaredKeyframes = new Set<string>();
  const hidingKeyframes = new Set<string>();
  let currentKeyframes: string | undefined;
  const animated: {
    decl: Declaration;
    value: string;
    longhand: boolean;
    rule: string;
    hasVar: boolean;
  }[] = [];

  const checkDeclaration = (
    decl: Declaration,
    rule: SelectorAnalysis | undefined,
    context: { print: boolean; fontFace: boolean; keyframes: boolean },
  ): void => {
    const property = cssUnescape(stripComments(decl.prop)).trim().toLowerCase();
    if (context.fontFace) {
      if (!FONT_FACE_DESCRIPTORS.has(property)) {
        fail(
          "FP1903",
          `'${property}' is not an @font-face descriptor portal-style-v1 accepts.`,
          decl,
        );
        return;
      }
    } else if (property.startsWith("--")) {
      if (!mapCustomProperty(api, property)) {
        fail(
          "FP1904",
          `Custom property '${property}' is not public. Set a --portal-* token or your own ${api.consumerPropertyPrefix}* property.`,
          decl,
        );
        return;
      }
    } else if (!/^-?[a-z][a-z0-9-]*$/.test(property) || FORBIDDEN_PROPERTIES.has(property)) {
      fail("FP1904", `Property '${property}' is not part of portal-style-v1.`, decl);
      return;
    }
    const custom = property.startsWith("--");
    const checked = checkValue(decl.value, decl, { property, fontFace: context.fontFace, custom });
    if (!checked.ok) return;
    if (context.fontFace && property === "src") {
      // Local files only: local() is not offered, so the rendering never depends on the
      // visitor's installed fonts.
      if (!/url\(/i.test(checked.text)) {
        fail("FP1904", "@font-face src takes url() of a font file under the source root.", decl);
        return;
      }
    }
    if (context.keyframes && currentKeyframes) {
      // Keyframes are checked as if they applied to a protected control; one that would not be
      // accepted there may not animate one.
      if (protectedViolation(property, checked.text, checked.hasVar)) {
        hidingKeyframes.add(currentKeyframes);
      }
    }
    if (!context.print) {
      const lifted = globalViolation(property, checked.text, checked.hasVar);
      if (lifted) {
        fail(
          "FP1905",
          `${lifted}.`,
          decl,
          "Consumer content stays below the portal's chrome: z-index at most 10, and nothing fixed to the viewport.",
        );
        return;
      }
    }
    if (
      rule &&
      !context.print &&
      !context.keyframes &&
      rule.canMatchProtected &&
      ANIMATION_PROPERTY.test(property)
    ) {
      animated.push({
        decl,
        value: checked.text,
        longhand: property.endsWith("-name"),
        rule: rule.text,
        hasVar: checked.hasVar,
      });
    }
    if (rule && !context.print && !context.keyframes) {
      const hidden = rule.canMatchProtected
        ? protectedViolation(property, checked.text, checked.hasVar)
        : rule.canMatchProtectedPseudo
          ? pseudoViolation(property, checked.text, checked.hasVar)
          : undefined;
      if (hidden) {
        fail(
          "FP1905",
          `'${rule.text}' could match a protected control (the skip link, a landmark, the menu button, the account control or something containing them), and ${hidden}.`,
          decl,
          "Only declarations that provably keep it visible are accepted there. Target an unprotected part or a .site-* class in your own markup; hiding for print belongs in @media print.",
        );
        return;
      }
    }
    decl.prop = custom ? mapCustomProperty(api, property)! : property;
    decl.value = checked.text;
    decl.raws.between = ": ";
    if (decl.important) decl.raws.important = " !important";
  };

  const visit = (
    container: Container,
    context: { print: boolean; fontFace: boolean; keyframes: boolean; depth: number },
  ): void => {
    for (const node of [...(container.nodes ?? [])] as ChildNode[]) {
      if (node.type === "decl") {
        if (
          container.type === "root" ||
          (container.type === "atrule" && !context.fontFace && !context.keyframes)
        ) {
          fail("FP1901", "A declaration outside a rule.", node);
          continue;
        }
        checkDeclaration(
          node,
          (container as { __analysis?: SelectorAnalysis }).__analysis,
          context,
        );
        continue;
      }
      if (node.type === "rule") {
        if (context.keyframes) {
          const selector = cssUnescape(stripComments(node.selector)).trim().toLowerCase();
          if (!/^(from|to|\d{1,3}(\.\d+)?%)(\s*,\s*(from|to|\d{1,3}(\.\d+)?%))*$/.test(selector)) {
            fail("FP1902", `'${selector}' is not a keyframe selector.`, node);
            continue;
          }
          node.selector = selector.replace(/\s*,\s*/g, ", ");
          for (const child of node.nodes) {
            if (child.type !== "decl") fail("FP1901", "Keyframes hold declarations only.", child);
          }
          visit(node, { ...context, depth: context.depth + 1 });
          continue;
        }
        if (container.type === "rule") {
          fail("FP1901", "Nested rules are not part of portal-style-v1.", node);
          continue;
        }
        const analysis = checkSelector(node);
        if (!analysis) continue;
        // Prune a rule that can only ever match parts of disabled features.
        const disabled = analysis.required.map((parts) =>
          parts
            .map((part) => api.parts[part]?.feature)
            .filter((feature): feature is string =>
              Boolean(feature && ctx.disabledFeatures.has(feature)),
            ),
        );
        // A selector list keeps the selectors that can still match; the rest are pruned.
        const dropped = analysis.complex.filter((_, i) => disabled[i]!.length > 0);
        if (dropped.length > 0) {
          const features = [...new Set(disabled.flat())].sort();
          const whole = dropped.length === analysis.complex.length;
          pruned.push({
            selector: dropped.join(", "),
            features,
            line: node.source?.start?.line ?? 1,
          });
          diagnostics.push({
            code: "FP1906",
            severity: "info",
            message: whole
              ? `Rule '${analysis.text}' styles only parts of disabled features (${features.join(", ")}) and is not published.`
              : `Selector '${dropped.join(", ")}' styles only parts of disabled features (${features.join(", ")}) and is dropped from its rule.`,
            file: ctx.file,
            ...(node.source?.start
              ? { position: { line: node.source.start.line, column: node.source.start.column } }
              : {}),
          });
          if (whole) {
            node.remove();
            continue;
          }
          analysis.text = analysis.complex.filter((_, i) => disabled[i]!.length === 0).join(", ");
        }
        node.selector = analysis.text;
        node.raws.between = " ";
        (node as unknown as { __analysis?: SelectorAnalysis }).__analysis = analysis;
        for (const child of node.nodes) {
          if (child.type === "rule" || child.type === "atrule") {
            fail("FP1901", "Nested rules are not part of portal-style-v1.", child);
            child.remove();
          }
        }
        visit(node, context);
        delete (node as unknown as { __analysis?: SelectorAnalysis }).__analysis;
        kept += 1;
        continue;
      }
      if (node.type === "atrule") {
        checkAtRule(node, context);
      }
    }
  };

  const checkAtRule = (
    node: AtRule,
    context: { print: boolean; fontFace: boolean; keyframes: boolean; depth: number },
  ): void => {
    const name = cssUnescape(node.name).toLowerCase();
    const params = canonicalValue(node.params).trim().replace(/\s+/g, " ");
    if (context.fontFace || context.keyframes) {
      fail("FP1903", `@${name} is not allowed inside @font-face or @keyframes.`, node);
      return;
    }
    if (context.depth > 3) {
      fail("FP1903", "At-rules nest at most three deep.", node);
      return;
    }
    switch (name) {
      case "media": {
        const ok = params.split(",").every((query) =>
          query
            .trim()
            .split(/\s+and\s+/)
            .every((part) => {
              const p = part.trim().replace(/^(only|not)\s+/, "");
              if (/^(screen|print|all)$/.test(p)) return true;
              const feature = /^\((.*)\)$/.exec(p);
              return Boolean(feature && MEDIA_FEATURES.test(feature[1]!.trim()));
            }),
        );
        if (!ok) {
          fail(
            "FP1903",
            `@media ${params}: only width/height, prefers-color-scheme, prefers-reduced-motion, orientation, screen and print are accepted.`,
            node,
          );
          return;
        }
        node.name = "media";
        node.params = params;
        visit(node, {
          ...context,
          print: context.print || printOnly(params),
          depth: context.depth + 1,
        });
        return;
      }
      case "supports": {
        if (/selector\s*\(/i.test(params) || /url\s*\(/i.test(params)) {
          fail("FP1903", "@supports takes property: value conditions only.", node);
          return;
        }
        const conditions = [
          ...params.matchAll(/\(\s*([-a-z]+)\s*:\s*([^()]*(\([^()]*\))?[^()]*)\)/gi),
        ];
        const residue = params
          .replace(/\(\s*[-a-z]+\s*:\s*[^()]*(\([^()]*\))?[^()]*\)/gi, "")
          .replace(/\b(and|or|not)\b|[\s()]/gi, "");
        if (conditions.length === 0 || residue !== "") {
          fail("FP1903", `@supports ${params} is not a property: value condition.`, node);
          return;
        }
        for (const condition of conditions) {
          const checked = checkValue(condition[2]!, node, {
            property: condition[1]!.toLowerCase(),
          });
          if (!checked.ok) return;
        }
        node.name = "supports";
        node.params = params;
        visit(node, { ...context, depth: context.depth + 1 });
        return;
      }
      case "layer": {
        if (
          !/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*(\s*,\s*[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*)*$/.test(
            params,
          )
        ) {
          fail("FP1903", `@layer '${params}': layer names are lowercase identifiers.`, node);
          return;
        }
        node.name = "layer";
        node.params = params;
        if (node.nodes) visit(node, { ...context, depth: context.depth + 1 });
        return;
      }
      case "keyframes": {
        if (!/^[a-z][a-z0-9-]{0,63}$/.test(params) || params.startsWith("portal")) {
          fail(
            "FP1903",
            `@keyframes '${params}': a lowercase name not starting with 'portal'.`,
            node,
          );
          return;
        }
        node.name = "keyframes";
        node.params = params;
        declaredKeyframes.add(params);
        currentKeyframes = params;
        visit(node, { ...context, keyframes: true, depth: context.depth + 1 });
        currentKeyframes = undefined;
        return;
      }
      case "font-face": {
        node.name = "font-face";
        node.params = "";
        visit(node, { ...context, fontFace: true, depth: context.depth + 1 });
        return;
      }
      default:
        fail(
          "FP1903",
          `@${name} is not part of portal-style-v1. Accepted: @media, @supports, @layer, @keyframes and @font-face.`,
          node,
          name === "import"
            ? "Everything a stylesheet uses has to be in this one file or under the source root."
            : undefined,
        );
        node.remove();
    }
  };

  visit(root, { print: false, fontFace: false, keyframes: false, depth: 0 });

  for (const entry of animated) {
    const problem = entry.hasVar
      ? "an animation set through var() cannot be checked"
      : animationNames(entry.value, entry.longhand, declaredKeyframes)
          .map((name) =>
            !declaredKeyframes.has(name)
              ? `'${name}' is not a @keyframes declared in this stylesheet`
              : hidingKeyframes.has(name)
                ? `@keyframes ${name} hides what it animates`
                : undefined,
          )
          .find(Boolean);
    if (problem) {
      fail(
        "FP1905",
        `The animation on '${entry.rule}' could hide a protected control: ${problem}.`,
        entry.decl,
        "Animate an unprotected part, or keep the keyframes visible throughout.",
      );
    }
  }

  if (diagnostics.some((d) => d.severity === "error")) return { diagnostics, pruned, rules: kept };
  root.raws.after = "\n";
  return { css: root.toString().trim(), diagnostics, pruned, rules: kept };
}

const ANIMATION_KEYWORDS = new Set([
  "none",
  "infinite",
  "normal",
  "reverse",
  "alternate",
  "alternate-reverse",
  "forwards",
  "backwards",
  "both",
  "running",
  "paused",
  "ease",
  "ease-in",
  "ease-out",
  "ease-in-out",
  "linear",
  "step-start",
  "step-end",
  "initial",
  "inherit",
  "unset",
  "revert",
  "revert-layer",
]);

const ANIMATION_PROPERTY = /^(-[a-z]+-)?animation(-name)?$/;
const CSS_WIDE = new Set([
  "none",
  "initial",
  "inherit",
  "unset",
  "revert",
  "revert-layer",
  "default",
]);

/**
 * Every keyframes name an `animation` or `animation-name` value may refer to, erring towards more.
 * Names are case-sensitive and may be strings. In `animation-name` every identifier but `none` is
 * a name, `linear` included. In the shorthand a keyword is a name too when such keyframes exist,
 * since which one the browser takes depends on position; an unknown identifier is always a name.
 */
export function animationNames(
  value: string,
  longhand: boolean,
  declared: ReadonlySet<string>,
): string[] {
  const names: string[] = [];
  for (const node of valueParser(value).nodes) {
    if (node.type === "string") {
      // The parser keeps a string's escapes; `"\70 ulse"` names `pulse`.
      names.push(cssUnescape(node.value));
      continue;
    }
    if (node.type !== "word" || !/^-{0,2}[a-zA-Z_][\w-]*$/.test(node.value)) continue;
    const word = node.value;
    const lower = word.toLowerCase();
    if (CSS_WIDE.has(lower)) continue;
    if (longhand || declared.has(word) || !ANIMATION_KEYWORDS.has(lower)) names.push(word);
  }
  return names;
}

/**
 * Whether a media query list matches only when printing: every query is the `print` media type,
 * never negated. `not print`, `print, screen` and a bare feature query all reach the screen.
 */
export function printOnly(params: string): boolean {
  return params
    .toLowerCase()
    .split(",")
    .every((query) => /^(only\s+)?print(\s+and\s+.*)?$/.test(query.trim()));
}

/** `--portal-*` maps onto the design's own property; `--site-*` is the consumer's. */
export function mapCustomProperty(api: StyleApi, name: string): string | undefined {
  if (name.startsWith(api.consumerPropertyPrefix) && /^--site-[a-z0-9][a-z0-9-]*$/.test(name)) {
    return name;
  }
  return api.tokens[name];
}
