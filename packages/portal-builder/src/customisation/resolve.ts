// The customisation surface, resolved: typed layout options, local fonts and images, the
// portal-style-v1 stylesheet and the portal-template-v1 slots.
//
// Everything here changes how the portal looks and where things sit. Nothing here can enable a
// feature, change an endpoint or own a route: parts render only what the configuration enabled,
// links go through the same resolver as every other link, files come only from the source root
// and are published under the portal's own origin, and a portal that uses none of it gets no
// `customisation` in its model at all, so its output is unchanged.

import { readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { createHash } from "node:crypto";
import type { DiagnosticBag, SourcePosition } from "../diagnostics.js";
import { PathViolation, resolveContained } from "../config/paths.js";
import type {
  LandingDocument,
  PortalConfig,
  RawBackground,
  RawBlockPlacement,
  RawImageWithVariants,
  RawLandingSection,
  SlotName,
} from "../config/types.js";
import type { ContentProfile } from "../rendering/profile.js";
import { sanitizeSvgFile } from "../rendering/svg.js";
import { mimeForAsset } from "../model/assets.js";
import { resolveLink, type LinkContext } from "../model/links.js";
import type {
  CustomisationEvidence,
  InputRecord,
  ResolvedBackground,
  ResolvedCustomisation,
  ResolvedImageVariants,
  ResolvedLandingSection,
  ResolvedLink,
  ResolvedPlacement,
  ResolvedRoute,
  ResolvedStaticFile,
  Segment,
} from "../model/types.js";
import { sha256 } from "../util/package.js";
import { slotsApi, styleApi } from "./api.js";
import { checkStylesheet } from "./style.js";
import { compileTemplate, renderTemplate, type CompiledTemplate } from "./template.js";

const IMAGE_EXTENSIONS = new Set([".svg", ".png", ".jpg", ".jpeg", ".webp", ".avif", ".gif"]);
const NEW_TOKENS = [
  "fontBody",
  "fontHeading",
  "fontMono",
  "typeScale",
  "spaceScale",
  "contentWidth",
  "radius",
  "borderWidth",
  "shadow",
] as const;

/** The implicit section of blocks that name none. Not a valid instance id, so it cannot clash. */
export const DEFAULT_SECTION = "_default";

/** The theme tokens the preset registry knows, without this capability's additions. */
export function stripExtendedTokens(
  tokens: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!tokens) return tokens;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(tokens)) {
    if ((NEW_TOKENS as readonly string[]).includes(key)) continue;
    if ((key === "light" || key === "dark") && value && typeof value === "object") {
      const { shadow: _shadow, ...rest } = value as Record<string, unknown>;
      void _shadow;
      out[key] = rest;
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** Does this configuration use any customisation option? Landing layout is checked separately. */
export function configUsesCustomisation(config: PortalConfig): boolean {
  const theme = config.theme;
  const header = config.chrome?.header;
  const footer = config.chrome?.footer;
  const tokens = theme?.tokens ?? {};
  return Boolean(
    theme?.fonts?.length ||
    theme?.stylesheet ||
    NEW_TOKENS.some((name) => tokens[name] !== undefined) ||
    (tokens.light as { shadow?: string } | undefined)?.shadow ||
    (tokens.dark as { shadow?: string } | undefined)?.shadow ||
    header?.variant ||
    header?.sticky !== undefined ||
    header?.transparentOverHero !== undefined ||
    header?.logo ||
    header?.items ||
    footer?.variant ||
    footer?.columns !== undefined ||
    footer?.logos ||
    footer?.order ||
    (config.chrome?.slots && Object.keys(config.chrome.slots).length > 0) ||
    config.navigation?.placement,
  );
}

export function landingUsesLayout(doc: LandingDocument): boolean {
  return Boolean(
    doc.layout ||
    doc.blocks.some(
      (block) =>
        block.section !== undefined ||
        block.span !== undefined ||
        block.width !== undefined ||
        block.align !== undefined ||
        block.background !== undefined,
    ),
  );
}

const TYPE_SCALE: Record<string, string> = {
  small: "0.93",
  regular: "1",
  large: "1.07",
  "x-large": "1.15",
};
const SPACE_SCALE: Record<string, string> = { tight: "0.75", regular: "1", loose: "1.35" };
const BORDER_WIDTH: Record<string, string> = { none: "0", regular: "1px", thick: "2px" };
const RADII = [6, 8, 9, 10, 11, 12, 14, 16];
const RADIUS_FACTOR: Record<string, number> = { none: 0, small: 0.5, regular: 1, large: 1.5 };
const SHADOWS: Record<string, { card: string; panel: string; footer: string }> = {
  none: { card: "none", panel: "none", footer: "none" },
  soft: {
    card: "0 1px 2px rgba(20, 32, 44, 0.03), 0 10px 24px -20px rgba(20, 32, 44, 0.18)",
    panel: "0 8px 20px rgba(20, 32, 44, 0.08)",
    footer: "0 -8px 20px -18px rgba(20, 32, 44, 0.35)",
  },
  regular: {
    card: "0 1px 2px rgba(20, 32, 44, 0.04), 0 18px 40px -28px rgba(20, 32, 44, 0.28)",
    panel: "0 14px 34px rgba(20, 32, 44, 0.12)",
    footer: "0 -14px 34px -24px rgba(20, 32, 44, 0.55)",
  },
  strong: {
    card: "0 2px 4px rgba(20, 32, 44, 0.08), 0 24px 48px -24px rgba(20, 32, 44, 0.45)",
    panel: "0 18px 40px rgba(20, 32, 44, 0.22)",
    footer: "0 -18px 40px -20px rgba(20, 32, 44, 0.7)",
  },
};
const UI_FALLBACK =
  'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const MONO_FALLBACK = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';

// Element sizes that follow the scale tokens. Emitted only when a token is set, so an unset
// scale leaves the design's own rules, media queries included, untouched.
const TYPE_SCALE_RULES = `.portal-prose {
  font-size: calc(16px * var(--portal-type-scale, 1));
}
.portal-hero-heading {
  font-size: calc(clamp(38px, 3.6vw, 64px) * var(--portal-type-scale, 1));
}
.portal-hero-text {
  font-size: calc(clamp(16.5px, 1.1vw, 18.5px) * var(--portal-type-scale, 1));
}
.portal-document-title {
  font-size: calc(clamp(28px, 2.4vw, 40px) * var(--portal-type-scale, 1));
}
.portal-block-heading {
  font-size: calc(17px * var(--portal-type-scale, 1));
}
.portal-card-link {
  font-size: calc(14.5px * var(--portal-type-scale, 1));
}
.portal-card-text {
  font-size: calc(13px * var(--portal-type-scale, 1));
}`;
const SPACE_SCALE_RULES = `.portal-landing,
.portal-document,
.portal-sandbox,
.portal-error {
  padding: calc(clamp(28px, 4vw, 56px) * var(--portal-space-scale, 1)) var(--shell-pad)
    calc(40px * var(--portal-space-scale, 1));
}
.portal-hero,
.portal-search-block,
.portal-content-block,
.portal-cards,
.portal-links,
.portal-feature-link {
  margin-bottom: calc(clamp(28px, 3.4vw, 56px) * var(--portal-space-scale, 1));
}`;
const BORDER_WIDTH_RULES = `.portal-card,
.portal-search-block,
.portal-admonition {
  border-width: var(--portal-border-width, 1px);
}`;

/**
 * The typed tokens this capability adds, as custom properties on the design's own names. Emitted
 * into the theme stylesheet only when one of them is set.
 */
export function extendedTokenCss(tokens: Record<string, unknown>): string {
  const root: string[] = [];
  const dark: string[] = [];
  const font = (value: unknown): string => `"${String(value)}"`;
  if (tokens.fontBody) root.push(`  --font-ui: ${font(tokens.fontBody)}, ${UI_FALLBACK};`);
  if (tokens.fontHeading)
    root.push(`  --font-display: ${font(tokens.fontHeading)}, var(--font-ui);`);
  if (tokens.fontMono) root.push(`  --font-mono: ${font(tokens.fontMono)}, ${MONO_FALLBACK};`);
  if (typeof tokens.typeScale === "string")
    root.push(`  --portal-type-scale: ${TYPE_SCALE[tokens.typeScale]};`);
  if (typeof tokens.spaceScale === "string")
    root.push(`  --portal-space-scale: ${SPACE_SCALE[tokens.spaceScale]};`);
  if (typeof tokens.borderWidth === "string")
    root.push(`  --portal-border-width: ${BORDER_WIDTH[tokens.borderWidth]};`);
  if (typeof tokens.contentWidth === "number")
    root.push(`  --content-max: ${tokens.contentWidth}px;`);
  if (typeof tokens.radius === "string") {
    const factor = RADIUS_FACTOR[tokens.radius] ?? 1;
    for (const r of RADII) root.push(`  --r-${r}: ${Math.round(r * factor * 10) / 10}px;`);
  }
  const shadow = (sink: string[], name: unknown): void => {
    const set = typeof name === "string" ? SHADOWS[name] : undefined;
    if (!set) return;
    sink.push(
      `  --shadow-card: ${set.card};`,
      `  --shadow-panel: ${set.panel};`,
      `  --shadow-footer: ${set.footer};`,
    );
  };
  shadow(root, tokens.shadow);
  const light = tokens.light as { shadow?: string } | undefined;
  const darkTokens = tokens.dark as { shadow?: string } | undefined;
  const lightBlock: string[] = [];
  shadow(lightBlock, light?.shadow);
  shadow(dark, darkTokens?.shadow);
  const blocks: string[] = [];
  if (root.length > 0) blocks.push(`:root {\n${root.join("\n")}\n}`);
  if (lightBlock.length > 0)
    blocks.push(`:root:not([data-theme="dark"]) {\n${lightBlock.join("\n")}\n}`);
  if (dark.length > 0) blocks.push(`:root[data-theme="dark"] {\n${dark.join("\n")}\n}`);
  if (typeof tokens.typeScale === "string") blocks.push(TYPE_SCALE_RULES);
  if (typeof tokens.spaceScale === "string") blocks.push(SPACE_SCALE_RULES);
  if (typeof tokens.borderWidth === "string") blocks.push(BORDER_WIDTH_RULES);
  return blocks.length > 0 ? `${blocks.join("\n")}\n` : "";
}

export interface CustomisationDeps {
  config: PortalConfig;
  configRel: string;
  configPath: string;
  sourceRoot: string;
  basePath: string;
  profile: ContentProfile;
  bag: DiagnosticBag;
  contents: Map<string, Buffer>;
  inputs: InputRecord[];
}

interface Located {
  file: string;
  pointer?: string;
  position?: SourcePosition;
}

/** Collects what the customisation publishes while the model resolves, then assembles it. */
export class CustomisationBuilder {
  readonly files: ResolvedStaticFile[] = [];
  private readonly published = new Map<string, string>();
  private readonly backgrounds = new Map<string, string>();
  private readonly fontFaces: string[] = [];

  constructor(private readonly deps: CustomisationDeps) {}

  private where(at: Located): { file: string; pointer?: string; position?: SourcePosition } {
    return {
      file: at.file,
      ...(at.pointer ? { pointer: at.pointer } : {}),
      ...(at.position ? { position: at.position } : {}),
    };
  }

  /** Resolve a declared local path, relative to the file that declares it, inside the root. */
  private contained(
    declared: string,
    declaringFile: string,
    at: Located,
  ): { absolute: string; relative: string } | undefined {
    try {
      return resolveContained(this.deps.sourceRoot, declaringFile, declared, { mustExist: true });
    } catch (error) {
      if (error instanceof PathViolation) {
        this.deps.bag.error(error.code, error.message, this.where(at));
        return undefined;
      }
      throw error;
    }
  }

  private publish(
    bytes: Buffer,
    source: string,
    original: Buffer,
    directory: string,
    stem: string,
    extension: string,
    mime: string,
    role: InputRecord["role"],
  ): string {
    const digest = createHash("sha256").update(bytes).digest("hex");
    const key = `${directory}/${stem}:${digest}`;
    const known = this.published.get(key);
    this.deps.inputs.push({
      path: source,
      role,
      digest: sha256(original),
      bytes: original.byteLength,
    });
    if (known) return known;
    const file = `_portal/${directory}/${stem}.${digest.slice(0, 8)}${extension}`;
    const url = `${this.deps.basePath}${file}`;
    this.deps.contents.set(file, bytes);
    this.files.push({
      file,
      url,
      source,
      mimeType: mime,
      bytes: bytes.byteLength,
      digest: sha256(bytes),
      cacheClass: "immutable",
      kind: "asset",
    });
    this.published.set(key, url);
    return url;
  }

  /** A local image, published as a hashed same-origin file. SVG goes through the sanitizer. */
  image(declared: string, declaringFile: string, at: Located): string | undefined {
    const path = this.contained(declared, declaringFile, at);
    if (!path) return undefined;
    const extension = extname(path.absolute).toLowerCase();
    const mime = mimeForAsset(path.absolute, this.deps.profile);
    if (!IMAGE_EXTENSIONS.has(extension) || !mime) {
      this.deps.bag.error(
        "FP1907",
        `'${path.relative}' is not an image portal customisation accepts (svg, png, jpg, webp, avif, gif).`,
        this.where(at),
      );
      return undefined;
    }
    const original = readFileSync(path.absolute);
    let bytes = original;
    if (extension === ".svg") {
      const result = sanitizeSvgFile(original, path.relative, this.deps.profile);
      this.deps.bag.merge(result.diagnostics);
      if (!result.ok) return undefined;
      bytes = Buffer.from(result.svg, "utf8");
    }
    return this.publish(
      bytes,
      path.relative,
      original,
      "site",
      slug(basename(path.absolute, extension)),
      extension === ".jpeg" ? ".jpg" : extension,
      mime,
      "customisation-asset",
    );
  }

  /** A local WOFF2 font. */
  font(
    declared: string,
    declaringFile: string,
    at: Located,
    role: InputRecord["role"] = "font",
  ): string | undefined {
    const path = this.contained(declared, declaringFile, at);
    if (!path) return undefined;
    const original = readFileSync(path.absolute);
    if (
      extname(path.absolute).toLowerCase() !== ".woff2" ||
      original.subarray(0, 4).toString("latin1") !== "wOF2"
    ) {
      this.deps.bag.error("FP1231", `'${path.relative}' is not a WOFF2 font file.`, this.where(at));
      return undefined;
    }
    return this.publish(
      original,
      path.relative,
      original,
      "site/fonts",
      slug(basename(path.absolute, ".woff2")),
      ".woff2",
      "font/woff2",
      role,
    );
  }

  imageVariants(raw: RawImageWithVariants, pointer: string): ResolvedImageVariants | undefined {
    const at = { file: this.deps.configRel, pointer };
    const src = this.image(raw.src, this.deps.configPath, { ...at, pointer: `${pointer}/src` });
    if (!src) return undefined;
    const light = raw.light
      ? this.image(raw.light, this.deps.configPath, { ...at, pointer: `${pointer}/light` })
      : undefined;
    const dark = raw.dark
      ? this.image(raw.dark, this.deps.configPath, { ...at, pointer: `${pointer}/dark` })
      : undefined;
    return {
      src,
      ...(light ? { light } : {}),
      ...(dark ? { dark } : {}),
      ...(raw.alt ? { alt: raw.alt } : {}),
    };
  }

  background(
    raw: RawBackground | undefined,
    declaringFile: string,
    at: Located,
  ): ResolvedBackground | undefined {
    if (raw === undefined) return undefined;
    if (typeof raw === "string") return { fill: raw };
    const url = this.image(raw.image, declaringFile, at);
    if (!url) return undefined;
    const id = createHash("sha256").update(url).digest("hex").slice(0, 10);
    this.backgrounds.set(id, url);
    return { image: id };
  }

  sections(doc: LandingDocument, landingFile: string): ResolvedLandingSection[] {
    const absolute = join(this.deps.sourceRoot, landingFile);
    return (doc.layout?.sections ?? []).map((section: RawLandingSection, index) => {
      const background = this.background(section.background, absolute, {
        file: landingFile,
        pointer: `/layout/sections/${index}/background`,
      });
      return {
        id: section.id,
        ...(section.heading ? { heading: section.heading } : {}),
        ...(section.width ? { width: section.width } : {}),
        ...(section.align ? { align: section.align } : {}),
        ...(background ? { background } : {}),
      };
    });
  }

  placement(
    raw: RawBlockPlacement,
    landingFile: string,
    pointer: string,
    sections: Set<string>,
  ): ResolvedPlacement {
    if (raw.section !== undefined && !sections.has(raw.section)) {
      this.deps.bag.error("FP1201", `Block placed in the undeclared section '${raw.section}'.`, {
        file: landingFile,
        pointer: `${pointer}/section`,
        hint: "Declare it under layout.sections.",
      });
    }
    const base = raw.span?.base ?? 12;
    const md = raw.span?.md ?? base;
    const lg = raw.span?.lg ?? md;
    const background = this.background(raw.background, join(this.deps.sourceRoot, landingFile), {
      file: landingFile,
      pointer: `${pointer}/background`,
    });
    return {
      ...(raw.section ? { section: raw.section } : {}),
      span: { base, md, lg },
      ...(raw.width ? { width: raw.width } : {}),
      ...(raw.align ? { align: raw.align } : {}),
      ...(background ? { background } : {}),
    };
  }

  /** `@font-face` rules for `theme.fonts`. */
  fonts(): void {
    for (const [index, entry] of (this.deps.config.theme?.fonts ?? []).entries()) {
      const url = this.font(entry.src, this.deps.configPath, {
        file: this.deps.configRel,
        pointer: `/theme/fonts/${index}/src`,
      });
      if (!url) continue;
      this.fontFaces.push(
        `@font-face {\n  font-family: "${entry.family}";\n  src: url("${url}") format("woff2");\n  font-weight: ${entry.weight ?? 400};\n  font-style: ${entry.style ?? "normal"};\n  font-display: swap;\n}`,
      );
    }
  }

  /** Builder-generated rules: font faces and layout background images. */
  generatedCss(): string {
    const rules = [...this.fontFaces];
    for (const [id, url] of [...this.backgrounds].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )) {
      rules.push(
        `[data-portal-background="${id}"] {\n  background-image: url("${url}");\n  background-size: cover;\n  background-position: center;\n}`,
      );
    }
    return rules.join("\n");
  }
}

export interface FinishInputs {
  builder: CustomisationBuilder;
  routes: ResolvedRoute[];
  links: {
    header: ResolvedLink[];
    legal: ResolvedLink[];
    groups: { title: string; links: ResolvedLink[] }[];
  };
  linkContext: LinkContext;
  site: {
    title: string;
    subtitle?: string;
    language: string;
    institution?: { name: string; url?: string };
  };
  siteLogo: { url: string };
  enabled: {
    search: boolean;
    auth: boolean;
    badge: boolean;
    datasetTree: boolean;
    databrowser: boolean;
    announcementFeed: boolean;
  };
  sourceDateEpoch?: number;
  landings: { id: string; path: string; source: string; sections: ResolvedLandingSection[] }[];
}

export interface FinishResult {
  customisation: ResolvedCustomisation;
  evidence?: CustomisationEvidence;
}

const SLOT_ORDER: SlotName[] = [
  "headerBrand",
  "headerExtra",
  "footerTop",
  "footerColumns",
  "footerBottom",
  "landingSectionShell",
  "proseAside",
];

/** Element ids the shell writes on every page; `#top` is the document's own start. */
const SHELL_FRAGMENTS = ["top", "portal-main", "portal-shell"];

const PART_FEATURE: Record<string, keyof FinishInputs["enabled"]> = {
  search: "search",
  auth: "auth",
};

/** Resolve everything that needs the finished routes: slots, the stylesheet, the header rules. */
export function finishCustomisation(inputs: FinishInputs, deps: CustomisationDeps): FinishResult {
  const { config, bag, configRel } = deps;
  const api = slotsApi();
  const builder = inputs.builder;
  const header = config.chrome?.header;
  const footer = config.chrome?.footer;
  const navPlacement = config.navigation?.placement ?? "header";
  const shellFragments = new Set([
    ...SHELL_FRAGMENTS,
    ...(header?.enabled !== false ? ["portal-header"] : []),
  ]);

  // Header items: auth and the small-screen menu can never be dropped.
  const items = header?.items;
  if (items) {
    if (!items.includes("navToggle")) {
      bag.error(
        "FP1230",
        "chrome.header.items must include navToggle: the small-screen menu cannot be hidden.",
        {
          file: configRel,
          pointer: "/chrome/header/items",
        },
      );
    }
    if (!items.includes("links") && navPlacement === "header") {
      bag.error(
        "FP1230",
        "chrome.header.items leaves out links, so wide screens would have no navigation. Set navigation.placement to side or both.",
        { file: configRel, pointer: "/chrome/header/items" },
      );
    }
    if (items.includes("search") && !inputs.enabled.search) {
      bag.info(
        "FP1915",
        "chrome.header.items lists search, but the header search is not enabled; nothing renders there.",
        {
          file: configRel,
          pointer: "/chrome/header/items",
        },
      );
    }
  }
  // The tabs and the menu button are one navigation landmark, which the shell island drives as a
  // unit, so they sit side by side; another item between them would be silently moved.
  if (items?.includes("links") && items.includes("navToggle")) {
    const at = [items.indexOf("links"), items.indexOf("navToggle")].sort((a, b) => a - b);
    if (at[1]! - at[0]! !== 1) {
      bag.error(
        "FP1234",
        `chrome.header.items puts '${items.slice(at[0]! + 1, at[1]).join("', '")}' between links and navToggle. They form one navigation landmark and are listed next to each other.`,
        { file: configRel, pointer: "/chrome/header/items" },
      );
    }
  }
  if (config.chrome?.header?.enabled === false && navPlacement === "header" && items) {
    bag.warn("FP1233", "chrome.header.items has no effect: the header is disabled.", {
      file: configRel,
      pointer: "/chrome/header/items",
    });
  }

  const headerLogo = header?.logo
    ? builder.imageVariants(header.logo, "/chrome/header/logo")
    : undefined;
  const logos: ResolvedCustomisation["footer"]["logos"] = [];
  for (const [index, logo] of (footer?.logos ?? []).entries()) {
    const pointer = `/chrome/footer/logos/${index}`;
    const src = builder.image(logo.src, deps.configPath, {
      file: configRel,
      pointer: `${pointer}/src`,
    });
    if (!src) continue;
    let href: ResolvedLink | undefined;
    if (logo.href) {
      const result = resolveLink(
        { label: logo.alt, href: logo.href },
        { ...inputs.linkContext, pointer: `${pointer}/href`, file: configRel },
      );
      bag.merge(result.diagnostics);
      href = result.link;
      if (!href) continue;
    }
    logos.push({
      src,
      alt: logo.alt,
      ...(href ? { href: href.href } : {}),
      external: href?.external ?? false,
    });
  }

  // Slot templates: compiled once, rendered per route against that route's context.
  const compiled = new Map<SlotName, CompiledTemplate>();
  const evidenceTemplates: CustomisationEvidence["templates"] = [];
  for (const slot of SLOT_ORDER) {
    const declared = config.chrome?.slots?.[slot];
    if (!declared) continue;
    const pointer = `/chrome/slots/${slot}`;
    let path: { absolute: string; relative: string };
    try {
      path = resolveContained(deps.sourceRoot, deps.configPath, declared, { mustExist: true });
    } catch (error) {
      if (error instanceof PathViolation) {
        bag.error(error.code, error.message, { file: configRel, pointer });
        continue;
      }
      throw error;
    }
    const bytes = readFileSync(path.absolute);
    deps.inputs.push({
      path: path.relative,
      role: "template",
      digest: sha256(bytes),
      bytes: bytes.byteLength,
    });
    const result = compileTemplate(bytes.toString("utf8"), {
      slot,
      file: path.relative,
      api,
      resolveHref: (value, position) => {
        // A fragment refers to the page the slot renders on, which is every page of its kind, so
        // only ids the shell writes on every page are known to exist.
        if (value.startsWith("#")) {
          if (shellFragments.has(value.slice(1))) return value;
          bag.error(
            "FP1917",
            `Fragment '${value}' is not on every page this slot renders on. Use one of: ${[...shellFragments].map((id) => `#${id}`).join(", ")}.`,
            { file: path.relative, position },
          );
          return undefined;
        }
        const link = resolveLink(
          { label: value, href: value },
          { ...inputs.linkContext, pointer: "", file: path.relative },
        );
        for (const d of link.diagnostics) {
          bag.add({
            code: d.severity === "error" ? "FP1917" : d.code,
            severity: d.severity,
            message: d.message,
            file: path.relative,
            position,
            ...(d.hint ? { hint: d.hint } : {}),
          });
        }
        return link.link?.href;
      },
      resolveSrc: (value, position) =>
        builder.image(value, path.absolute, { file: path.relative, position }),
    });
    bag.merge(result.diagnostics);
    if (!result.template) continue;
    compiled.set(slot, result.template);
    const emptyParts = result.template.parts
      .filter((part) => PART_FEATURE[part] && !inputs.enabled[PART_FEATURE[part]!])
      .map((part) => ({ part, feature: api.parts[part]?.feature ?? part }));
    for (const empty of emptyParts) {
      bag.info(
        "FP1915",
        `{% part "${empty.part}" %} renders nothing: ${empty.feature} is not enabled.`,
        { file: path.relative },
      );
    }
    evidenceTemplates.push({
      slot,
      source: path.relative,
      parts: [...result.template.parts],
      emptyParts,
    });
  }

  // Where a footer slot renders. `bar-only` has no index; `footerColumns` is a column of the
  // groups section, which `minimal` and an order without `groups` leave out.
  const footerEnabled = config.chrome?.footer?.enabled !== false;
  const footerSlotProblem = (slot: SlotName): string | undefined => {
    if (footer?.variant === "bar-only") return "the bar-only footer has no site index";
    if (slot !== "footerColumns") return undefined;
    if (footer?.variant === "minimal") return "the minimal footer has no link groups";
    if (footer?.order && !footer.order.includes("groups"))
      return "chrome.footer.order leaves out groups";
    return undefined;
  };
  const footerSlotRenders = (slot: SlotName): boolean =>
    footerEnabled && footerSlotProblem(slot) === undefined;
  for (const slot of ["footerTop", "footerColumns", "footerBottom"] as SlotName[]) {
    if (!config.chrome?.slots?.[slot]) continue;
    const problem = footerSlotProblem(slot);
    if (problem) {
      bag.error("FP1913", `The ${slot} slot has nowhere to render: ${problem}.`, {
        file: configRel,
        pointer: `/chrome/slots/${slot}`,
      });
    } else if (!footerEnabled) {
      bag.warn("FP1233", `The ${slot} slot has no effect: the footer is disabled.`, {
        file: configRel,
        pointer: `/chrome/slots/${slot}`,
      });
    }
  }
  if (footer?.variant === "minimal") {
    for (const name of footer.order ?? []) {
      if (name === "groups" || name === "logos") {
        bag.warn(
          "FP1233",
          `The minimal footer shows the institution, legal links and prose; '${name}' is not rendered.`,
          {
            file: configRel,
            pointer: "/chrome/footer/order",
          },
        );
      }
    }
  }

  // A sealed part a header or footer slot placed leaves its default position.
  const moved = new Set<string>();
  for (const slot of ["headerExtra"] as SlotName[]) {
    for (const part of compiled.get(slot)?.parts ?? []) {
      if (["search", "theme-toggle", "auth"].includes(part)) moved.add(part);
    }
  }
  // The footer's legal links, placed by a footer template, leave the index's legal section.
  // Only a slot that renders can take a part away from its default place.
  for (const slot of ["footerTop", "footerColumns", "footerBottom"] as SlotName[]) {
    if (footerSlotRenders(slot) && compiled.get(slot)?.parts.includes("legal-links")) {
      moved.add("legal-links");
    }
  }
  if (items && inputs.enabled.auth && !items.includes("auth") && !moved.has("auth")) {
    bag.error(
      "FP1230",
      "Auth is enabled, so the account control must stay: list auth in chrome.header.items or place it with the headerExtra template.",
      { file: configRel, pointer: "/chrome/header/items" },
    );
  }
  if (items) {
    const asItem: Record<string, string> = {
      search: "search",
      "theme-toggle": "themeToggle",
      auth: "auth",
    };
    for (const part of moved) {
      if (asItem[part] && items.includes(asItem[part] as never)) {
        bag.error(
          "FP1913",
          `'${part}' is placed by the headerExtra template and also listed in chrome.header.items.`,
          {
            file: configRel,
            pointer: "/chrome/header/items",
          },
        );
      }
    }
  }

  const partEnabled = (part: string): boolean => {
    const feature = PART_FEATURE[part];
    return feature ? inputs.enabled[feature] : true;
  };
  const year = inputs.sourceDateEpoch
    ? String(new Date(inputs.sourceDateEpoch * 1000).getUTCFullYear())
    : "";
  const linkValue = (link: ResolvedLink, current: string): Record<string, unknown> => ({
    label: link.label,
    href: link.href,
    external: link.external,
    current: link.href === current,
  });
  const logoValue = headerLogo
    ? {
        src: headerLogo.src,
        light: headerLogo.light ?? "",
        dark: headerLogo.dark ?? "",
        alt: headerLogo.alt ?? "",
      }
    : { src: inputs.siteLogo.url, light: "", dark: "", alt: "" };
  const render = (slot: SlotName, context: Record<string, unknown>): Segment[] | undefined => {
    const template = compiled.get(slot);
    if (!template) return undefined;
    const result = renderTemplate(template, context, { profile: deps.profile, api, partEnabled });
    bag.merge(result.diagnostics);
    return result.segments;
  };
  for (const route of inputs.routes) {
    const current = route.url.replace(/^https:\/\/[^/]+/, "");
    const base: Record<string, unknown> = {
      site: {
        title: inputs.site.title,
        subtitle: inputs.site.subtitle ?? "",
        language: inputs.site.language,
        institution: {
          name: inputs.site.institution?.name ?? "",
          url: inputs.site.institution?.url ?? "",
        },
      },
      logo: logoValue,
      route: { path: route.path, title: route.title, kind: route.kind, isHome: route.path === "/" },
      links: inputs.links.header.map((link) => linkValue(link, current)),
      footer: {
        groups: inputs.links.groups.map((group) => ({
          title: group.title,
          links: group.links.map((l) => linkValue(l, current)),
        })),
        legal: inputs.links.legal.map((link) => linkValue(link, current)),
        logos: logos.map((logo) => ({ src: logo.src, alt: logo.alt, href: logo.href ?? "" })),
      },
      build: { year },
    };
    const slots: Partial<Record<string, Segment[]>> = {};
    for (const slot of [
      "headerBrand",
      "headerExtra",
      "footerTop",
      "footerColumns",
      "footerBottom",
    ] as SlotName[]) {
      const segments = render(slot, base);
      if (segments) slots[slot] = segments;
    }
    if (route.kind === "content") {
      const segments = render("proseAside", {
        ...base,
        page: {
          title: route.title,
          headings: (route.toc ?? []).map((heading) => ({
            text: heading.text,
            href: `#${heading.id}`,
          })),
        },
      });
      if (segments) slots.proseAside = segments;
    }
    if (Object.keys(slots).length > 0) route.slots = slots;
    const landing = route.landingId
      ? inputs.landings.find((l) => l.id === route.landingId)
      : undefined;
    if (landing && compiled.has("landingSectionShell")) {
      const shells: Record<string, Segment[]> = {};
      for (const section of [{ id: DEFAULT_SECTION }, ...landing.sections]) {
        const segments = render("landingSectionShell", {
          ...base,
          section: { id: section.id, heading: "heading" in section ? (section.heading ?? "") : "" },
        });
        if (segments) shells[section.id] = segments;
      }
      route.sectionShells = shells;
    }
  }

  // The stylesheet.
  const style = styleApi();
  let consumerCss: string | undefined;
  let stylesheetEvidence: CustomisationEvidence["stylesheet"] = null;
  const stylesheet = config.theme?.stylesheet;
  let stylesheetSource: string | undefined;
  if (stylesheet) {
    const pointer = "/theme/stylesheet/path";
    let path: { absolute: string; relative: string } | undefined;
    try {
      path = resolveContained(deps.sourceRoot, deps.configPath, stylesheet.path, {
        mustExist: true,
      });
    } catch (error) {
      if (!(error instanceof PathViolation)) throw error;
      bag.error(error.code, error.message, { file: configRel, pointer });
    }
    if (path) {
      const resolvedPath = path;
      const bytes = readFileSync(path.absolute);
      deps.inputs.push({
        path: path.relative,
        role: "stylesheet",
        digest: sha256(bytes),
        bytes: bytes.byteLength,
      });
      stylesheetSource = path.relative;
      const disabled = new Set<string>();
      if (!inputs.enabled.search) disabled.add("site-search");
      if (!inputs.enabled.auth) disabled.add("auth");
      if (!inputs.enabled.badge) disabled.add("footer-badge");
      if (!inputs.enabled.datasetTree) disabled.add("dataset-tree");
      if (!inputs.enabled.databrowser) disabled.add("databrowser");
      const protectedClasses = new Set<string>();
      const dynamicProtected = new Set<string>();
      for (const [slot, template] of compiled) {
        for (const c of template.protectedSiteClasses) protectedClasses.add(c);
        if (template.parts.includes("auth") && slot === "headerExtra")
          dynamicProtected.add("header-extra");
      }
      const result = checkStylesheet(bytes.toString("utf8"), {
        file: path.relative,
        disabledFeatures: disabled,
        dynamicProtectedParts: dynamicProtected,
        protectedSiteClasses: protectedClasses,
        resolveAsset: (ref, kind, position) =>
          kind === "font"
            ? builder.font(
                ref,
                resolvedPath.absolute,
                { file: resolvedPath.relative, position },
                "customisation-asset",
              )
            : builder.image(ref, resolvedPath.absolute, { file: resolvedPath.relative, position }),
      });
      bag.merge(result.diagnostics);
      consumerCss = result.css;
      stylesheetEvidence = { source: path.relative, file: "", prunedRules: result.pruned };
    }
  }

  // One published stylesheet: font faces and backgrounds (unlayered), then the consumer layer.
  builder.fonts();
  const generated = builder.generatedCss();
  let published: ResolvedCustomisation["stylesheet"];
  if (generated || consumerCss !== undefined) {
    const parts: string[] = [];
    if (consumerCss !== undefined) parts.push(`@layer ${style.frameworkLayer}, ${style.layer};`);
    if (generated) parts.push(generated);
    if (consumerCss !== undefined) parts.push(`@layer ${style.layer} {\n${consumerCss}\n}`);
    const css = `${parts.join("\n")}\n`;
    const bytes = Buffer.from(css, "utf8");
    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 8);
    const file = `_portal/site-style.${hash}.css`;
    deps.contents.set(file, bytes);
    builder.files.push({
      file,
      url: `${deps.basePath}${file}`,
      source: stylesheetSource ?? deps.configRel,
      mimeType: "text/css; charset=utf-8",
      bytes: bytes.byteLength,
      digest: sha256(bytes),
      cacheClass: "immutable",
      kind: "asset",
    });
    published = { url: `${deps.basePath}${file}`, file };
    if (stylesheetEvidence) stylesheetEvidence.file = file;
  }

  const customisation: ResolvedCustomisation = {
    header: {
      ...(header?.variant ? { variant: header.variant } : {}),
      sticky: header?.sticky ?? true,
      transparentOverHero: header?.transparentOverHero ?? false,
      ...(headerLogo ? { logo: headerLogo } : {}),
      ...(items ? { items: [...items] } : {}),
    },
    footer: {
      ...(footer?.variant ? { variant: footer.variant } : {}),
      ...(footer?.columns !== undefined ? { columns: footer.columns } : {}),
      logos,
      ...(footer?.order ? { order: [...footer.order] } : {}),
    },
    navPlacement,
    ...(published ? { stylesheet: published } : {}),
    layered: consumerCss !== undefined,
    movedParts: [...moved].sort(),
  };
  const evidence =
    stylesheetEvidence || evidenceTemplates.length > 0
      ? { stylesheet: stylesheetEvidence, templates: evidenceTemplates }
      : undefined;
  return { customisation, ...(evidence ? { evidence } : {}) };
}

function slug(name: string): string {
  const s = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return s || "file";
}
