// Build-time syntax highlighting.
//
// Highlighting happens at build time, so no highlighter ships to the browser, and the output
// carries classes, never inline styles: the artifact has to be servable under a strict Content
// Security Policy, and `style-src 'unsafe-inline'` for code colours would be a poor trade.
// Token colours become deterministic class names plus one framework stylesheet beside them.

import { createHighlighter, type Highlighter } from "shiki";
import { h, t, type HElement, type HNode } from "./html.js";
import type { ContentProfile } from "./profile.js";
import { compareCodePoints } from "../util/order.js";
import { displayLanguage, resolveLanguage } from "./languages.js";

let highlighter: Highlighter | undefined;

export async function getHighlighter(profile: ContentProfile): Promise<Highlighter> {
  if (!highlighter) {
    highlighter = await createHighlighter({
      themes: [profile.highlighting.theme, profile.highlighting.darkTheme],
      langs: profile.highlighting.languages,
    });
  }
  return highlighter;
}

export function disposeHighlighter(): void {
  highlighter?.dispose();
  highlighter = undefined;
}

/**
 * The code surface in each theme: the design's `--chip` values. They are not
 * consumer-configurable - a theme preset can move the accent and the border, not the code
 * background - so a build-time contrast decision made against them stays true in the browser.
 */
const CODE_BG = { light: "#eceae2", dark: "#202a36" } as const;

/** WCAG AA for body text. Code is small text, so this is the right threshold. */
const MIN_CONTRAST = 4.5;

function channels(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function toHex(rgb: readonly number[]): string {
  return `#${rgb
    .map((c) =>
      Math.max(0, Math.min(255, Math.round(c)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const HEX = /^#[0-9a-f]{6}$/;

/**
 * Pull a token colour towards the readable side of its own background. Upstream themes are
 * authored for their own editor backgrounds - GitHub's light theme assumes white, the portal's
 * code surface is a warm grey - so a few of their colours land just under 4.5:1 here. Rather
 * than hand-pick a palette that drifts when the theme is updated, each colour is walked toward
 * black (light) or white (dark) in one-percent steps until readable. An already readable colour
 * is returned untouched, and the function is pure, so the artifact stays reproducible.
 */
function readableOn(colour: string, mode: "light" | "dark"): string {
  const hex = colour.toLowerCase();
  if (!HEX.test(hex)) return hex;
  const bg = CODE_BG[mode];
  if (contrast(hex, bg) >= MIN_CONTRAST) return hex;
  const target = mode === "light" ? 0 : 255;
  const start = channels(hex);
  for (let step = 1; step <= 100; step += 1) {
    const k = step / 100;
    const candidate = toHex(start.map((c) => c + (target - c) * k));
    if (contrast(candidate, bg) >= MIN_CONTRAST) return candidate;
  }
  return toHex([target, target, target]);
}

/**
 * One deterministic class per distinct colour pair, collected for the stylesheet. A pair, not
 * a colour: the portal has a light and a dark theme, and code readable in one is frequently
 * unreadable in the other. Both passes produce the same tokens for the same grammar, so a
 * token's light and dark colours share one class whose second definition sits under
 * `[data-theme="dark"]`. The output stays class-only - no inline style, so no
 * `style-src 'unsafe-inline'` - while each theme keeps its own palette.
 */
export class CodeStyleSheet {
  private readonly pairs = new Map<string, { light: string; dark: string; cls: string }>();

  constructor(private readonly prefix: string) {}

  classFor(light: string, dark?: string): string {
    const lightKey = readableOn(light, "light");
    const darkKey = readableOn(dark ?? light, "dark");
    const key = `${lightKey}|${darkKey}`;
    const existing = this.pairs.get(key);
    if (existing) return existing.cls;
    const cls = `${this.prefix}${lightKey.replace("#", "").slice(0, 6)}${darkKey.replace("#", "").slice(0, 6)}`;
    this.pairs.set(key, { light: lightKey, dark: darkKey, cls });
    return cls;
  }

  get used(): boolean {
    return this.pairs.size > 0;
  }

  css(): string {
    const entries = [...this.pairs.entries()].sort(([a], [b]) => compareCodePoints(a, b));
    const light = entries.map(([, v]) => `.${v.cls}{color:${v.light}}`).join("\n");
    const dark = entries
      .filter(([, v]) => v.dark !== v.light)
      .map(([, v]) => `:root[data-theme="dark"] .${v.cls}{color:${v.dark}}`)
      .join("\n");
    return dark ? `${light}\n${dark}` : light;
  }
}

export interface HighlightResult {
  node: HElement;
  unknownLanguage?: string;
}

/**
 * The identity a runnable block was registered under at build time: a name and a digest, never
 * the source, which is already in the document in the copy control. What the button carries is
 * what the interpreter will be ASKED for, plus the digest naming the bytes the build approved,
 * so a page whose markup was edited after the build cannot talk a matching interpreter into
 * running something else.
 */
export interface RunnableExample {
  id: string;
  sha256: string;
}

export async function highlight(
  code: string,
  lang: string | undefined,
  profile: ContentProfile,
  sheet: CodeStyleSheet,
  title?: string,
  runnable?: RunnableExample,
): Promise<HighlightResult> {
  const prefix = profile.highlighting.classPrefix;
  const resolved = resolveLanguage(lang, profile.highlighting.languages);

  /**
   * The copy control. Emitted at build time next to the code rather than injected by a script,
   * so it is in the document a screen reader reads and a keyboard reaches. It starts `hidden`:
   * without a script it cannot copy anything, and a button that does nothing is worse than no
   * button. The raw source travels in an attribute so the button copies what the author wrote,
   * not the highlighted markup, the line numbers or the button's own label.
   */
  const wrap = (pre: HElement, label: string, raw: string): HElement => {
    // The header names the block and its language. A `title="remap.py"` is what the author
    // called it - a filename, a command, a path - the more useful label, so it takes the
    // front of the bar and the language moves to a quiet tag beside the copy control. The
    // language comes from the same resolved language the highlighter used, so it cannot
    // disagree with the colours, and a snippet whose language you have to infer from its
    // punctuation is one you can copy into the wrong file. The bar sits above the code, so
    // neither ever covers the first line. The title is text, escaped like any text node.
    const head: HNode[] = title
      ? [
          h("span", { class: `${prefix}-title` }, [t(title)]),
          h("span", { class: `${prefix}-lang ${prefix}-lang-secondary` }, [
            t(displayLanguage(label)),
          ]),
        ]
      : [h("span", { class: `${prefix}-lang` }, [t(displayLanguage(label))])];
    const copy = h(
      "button",
      {
        type: "button",
        class: `${prefix}-copy`,
        "data-portal-copy": raw,
        "aria-label": "Copy code",
        hidden: "",
      },
      [
        h("span", { class: `${prefix}-copy-icon`, "aria-hidden": "true" }, []),
        h("span", { class: `${prefix}-copy-label` }, [t("Copy")]),
      ],
    );
    // Try in Python: SECOND, and only on a block the build registered. Copy keeps the front
    // of the row because it always works - no interpreter, no network, no WebAssembly - and
    // must keep working when Python has failed to start; a run control pushing it aside would
    // put the fragile action where the hand already goes. Hidden until a script installs it,
    // exactly as Copy is. The two data attributes are what the press will send - a name and a
    // digest, never the source. An UNMARKED block emits none of this - not an empty wrapper,
    // not a group element, nothing - so its head is byte-for-byte the head of an ordinary
    // code block, which is what makes the absence testable.
    const actions = runnable
      ? [
          h("div", { class: `${prefix}-actions` }, [
            copy,
            h(
              "button",
              {
                type: "button",
                class: `${prefix}-run`,
                "data-portal-run": "",
                "data-portal-example": runnable.id,
                "data-portal-digest": runnable.sha256,
                "aria-label": "Try this code in Python",
                hidden: "",
              },
              [
                h("span", { class: `${prefix}-run-icon`, "aria-hidden": "true" }, []),
                h("span", { class: `${prefix}-run-label` }, [t("Try in Python")]),
              ],
            ),
          ]),
        ]
      : [copy];
    const figure = h("div", { class: `${prefix}-figure`, "data-portal-code": label }, [
      h("div", { class: `${prefix}-head` }, [...head, ...actions]),
      pre,
    ]);
    // Named so the sanitizer can tell this chrome from anything an author wrote.
    figure.generatedBy = "portal-code";
    return figure;
  };

  if (!resolved.grammar) {
    // No grammar: readable plain text, escaped. Never guessed into a language merely to
    // produce more colour.
    const node = h("pre", { class: `${prefix}-block`, "data-portal-language": resolved.label }, [
      h("code", { class: `${prefix}` }, [t(code)]),
    ]);
    const result: HighlightResult = { node: wrap(node, resolved.label, code) };
    if (resolved.unknown && lang !== undefined) result.unknownLanguage = lang;
    return result;
  }

  const hl = await getHighlighter(profile);
  type TokenOptions = Parameters<typeof hl.codeToTokens>[1];
  const grammar = resolved.grammar as NonNullable<TokenOptions["lang"]>;
  const lightPass = hl.codeToTokens(code, {
    lang: grammar,
    theme: profile.highlighting.theme,
  } as TokenOptions);
  const darkPass = hl.codeToTokens(code, {
    lang: grammar,
    theme: profile.highlighting.darkTheme,
  } as TokenOptions);

  const lines = lightPass.tokens.map((line, lineIndex) =>
    h(
      "span",
      { class: `${prefix}-line` },
      line.map((token, tokenIndex) => {
        const darkToken = darkPass.tokens[lineIndex]?.[tokenIndex];
        // The two passes tokenize the same grammar over the same text, so a token matches by
        // position. When it does not - the themes disagreeing about the grammar - the light
        // colour is used for both rather than pairing colours that belong to different text.
        const dark =
          darkToken && darkToken.content === token.content ? (darkToken.color ?? "") : "";
        return token.color
          ? h("span", { class: sheet.classFor(token.color, dark || token.color) }, [
              t(token.content),
            ])
          : h("span", {}, [t(token.content)]);
      }),
    ),
  );

  const children: HElement["children"] = [];
  lines.forEach((line, index) => {
    if (index > 0) children.push(t("\n"));
    children.push(line);
  });

  const pre = h("pre", { class: `${prefix}-block`, "data-portal-language": resolved.label }, [
    h("code", { class: prefix, "data-portal-language": resolved.label }, children),
  ]);
  return { node: wrap(pre, resolved.label, code) };
}
