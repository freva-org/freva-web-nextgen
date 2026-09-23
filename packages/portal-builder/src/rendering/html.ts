// The HTML tree, its final sanitizer and its serializer.
//
// An implementation that produces *different valid HTML* from the same IR is not conforming
// just because a browser draws it the same way, so the serializer is ours: escaping, attribute
// order, void-element spelling and whitespace come from the profile, and two builds of the
// same input produce the same bytes. Sanitization runs last, after mathematics, diagrams and
// link rewriting have added their nodes - the order OWASP asks for, since a transform running
// after the sanitizer can undo it.

import type { Diagnostic } from "../diagnostics.js";
import type { ContentProfile } from "./profile.js";

export interface HText {
  type: "text";
  value: string;
}

export interface HElement {
  type: "element";
  tag: string;
  attrs: [string, string][];
  children: HNode[];
  /**
   * Set only by the pinned math/diagram transforms: the single reason a `style` attribute may
   * survive sanitization. Authored content can never set it.
   */
  generatedBy?: string;
}

export type HNode = HText | HElement;

export function h(
  tag: string,
  attrs: Record<string, string | number | boolean | undefined> = {},
  children: HNode[] = [],
): HElement {
  const list: [string, string][] = [];
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    list.push([k, v === true ? "" : String(v)]);
  }
  return { type: "element", tag, attrs: list, children };
}

export function t(value: string): HText {
  return { type: "text", value };
}

const TEXT_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
const ATTR_ESCAPES: Record<string, string> = { ...TEXT_ESCAPES, '"': "&quot;" };

export function escapeText(value: string): string {
  return value.replace(/[&<>]/g, (c) => TEXT_ESCAPES[c]!);
}

export function escapeAttr(value: string): string {
  return value.replace(/[&<>"]/g, (c) => ATTR_ESCAPES[c]!);
}

/** Elements whose text content must not be escaped and must never be authored. */
const RAW_TEXT = new Set(["style"]);

export function serialize(nodes: HNode[], profile: ContentProfile): string {
  const voids = new Set(profile.serialization.voidElements);
  // Only a genuine boolean attribute collapses: `alt=""` means "decorative", not the same
  // thing as `alt`, so it keeps its quotes.
  const booleans = new Set(profile.serialization.booleanAttributeNames ?? []);
  const out: string[] = [];
  const write = (node: HNode): void => {
    if (node.type === "text") {
      out.push(escapeText(node.value));
      return;
    }
    const attrs = node.attrs
      .map(([name, value]) =>
        value === "" && booleans.has(name.toLowerCase())
          ? ` ${name}`
          : ` ${name}="${escapeAttr(value)}"`,
      )
      .join("");
    if (voids.has(node.tag)) {
      out.push(`<${node.tag}${attrs}${profile.serialization.selfClosingVoid}`);
      return;
    }
    out.push(`<${node.tag}${attrs}>`);
    if (RAW_TEXT.has(node.tag)) {
      // Only a `<style>` from a pinned transform, whose text the sanitizer has constrained.
      for (const child of node.children) if (child.type === "text") out.push(child.value);
    } else {
      for (const child of node.children) write(child);
    }
    out.push(`</${node.tag}>`);
  };
  for (const node of nodes) write(node);
  return out.join("");
}

export interface SanitizeContext {
  profile: ContentProfile;
  file: string;
  diagnostics: Diagnostic[];
  /** `svg` applies the SVG allowlist instead of the HTML one. */
  mode?: "html" | "svg";
}

function attributeAllowed(profile: ContentProfile, tag: string, name: string): boolean {
  if (profile.html.globalAttributes.includes(name)) return true;
  return (profile.html.elementAttributes[tag] ?? []).includes(name);
}

function styleIsSafe(profile: ContentProfile, value: string): boolean {
  for (const pattern of profile.html.styleAttribute.forbiddenValuePatterns) {
    if (new RegExp(pattern, "i").test(value)) return false;
  }
  const allowed = new Set(profile.html.styleAttribute.allowedDeclarations);
  for (const decl of value.split(";")) {
    const trimmed = decl.trim();
    if (!trimmed) continue;
    const name = trimmed.slice(0, trimmed.indexOf(":")).trim().toLowerCase();
    if (!name || !allowed.has(name)) return false;
  }
  return true;
}

function urlIsSafe(profile: ContentProfile, value: string): boolean {
  const v = value.trim();
  if (v === "") return false;
  if (v.startsWith("#") || v.startsWith("/") || v.startsWith("./") || v.startsWith("../"))
    return true;
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(v);
  if (!match) return true; // a relative reference
  const scheme = match[1]!.toLowerCase();
  if (profile.urls.forbiddenSchemes.includes(scheme)) return false;
  return profile.urls.allowedSchemes.includes(scheme);
}

/**
 * The final gate. It removes rather than escapes: a rejected element is a build error with a
 * source-located diagnostic, so nothing depends on a browser's recovery behavior.
 */
export function sanitize(nodes: HNode[], ctx: SanitizeContext): HNode[] {
  const { profile } = ctx;
  const svgMode = ctx.mode === "svg";
  const allowedElements = new Set(
    svgMode ? profile.svg.allowedElements : profile.html.allowedElements,
  );
  const forbiddenElements = new Set(
    svgMode ? profile.svg.forbiddenElements : profile.html.forbiddenElements,
  );
  const forbiddenAttrPatterns = (
    svgMode ? profile.svg.forbiddenAttributePatterns : profile.html.forbiddenAttributePatterns
  ).map((p) => new RegExp(p, "i"));
  const svgAllowedAttrs = new Set(profile.svg.allowedAttributes);
  // Passive metadata such as `data-*` and `aria-*` is matched by pattern, so the allowlist
  // need not grow with every diagram-renderer release.
  const svgAttrPatterns = (profile.svg.allowedAttributePatterns ?? []).map((p) => new RegExp(p));
  const forbiddenValues = (svgMode ? profile.svg.forbiddenValuePatterns : []).map(
    (p) => new RegExp(p, "i"),
  );

  const reject = (code: string, message: string): void => {
    ctx.diagnostics.push({ code, severity: "error", message, file: ctx.file });
  };

  const walk = (
    node: HNode,
    inGenerated: string | undefined,
    inSvg: boolean,
  ): HNode | undefined => {
    if (node.type === "text") return node;
    const generated = node.generatedBy ?? inGenerated;
    // SVG is a different vocabulary for the whole subtree: `<path>` is legitimate inside
    // `<svg>` and nowhere else.
    const svgHere = inSvg || node.tag === "svg";
    const elementAllowed = svgHere ? new Set(profile.svg.allowedElements) : allowedElements;
    const elementForbidden = svgHere ? new Set(profile.svg.forbiddenElements) : forbiddenElements;
    const attrPatterns = svgHere
      ? profile.svg.forbiddenAttributePatterns.map((p) => new RegExp(p, "i"))
      : forbiddenAttrPatterns;
    const valuePatterns = svgHere
      ? profile.svg.forbiddenValuePatterns.map((p) => new RegExp(p, "i"))
      : forbiddenValues;

    if (elementForbidden.has(node.tag) || !elementAllowed.has(node.tag)) {
      // `<style>` inside a generated SVG is the one exception the profile names.
      const generatedStyle =
        node.tag === "style" &&
        svgHere &&
        generated !== undefined &&
        profile.html.styleAttribute.generatedTransforms.includes(generated);
      // A pinned framework transform may emit the elements the profile names for it and no
      // others: the code block's own copy control exists this way while `button` stays
      // forbidden to authored content, which raw-HTML rejection keeps from reaching here.
      const generatedElement =
        generated !== undefined &&
        (profile.html.generatedElements?.[generated] ?? []).includes(node.tag);
      if (!generatedStyle && !generatedElement) {
        reject(
          svgHere ? "PC1018" : "PC1015",
          `Rejected element <${node.tag}>. Authored active content is not part of portal-content-v1.`,
        );
        return undefined;
      }
    }

    const attrs: [string, string][] = [];
    for (const [name, value] of node.attrs) {
      const lower = name.toLowerCase();
      if (attrPatterns.some((r) => r.test(name))) {
        if (lower === "style") {
          if (generated && profile.html.styleAttribute.generatedTransforms.includes(generated)) {
            if (styleIsSafe(profile, value)) {
              attrs.push([name, value]);
              continue;
            }
          }
          reject("PC1015", `Rejected style attribute on <${node.tag}>.`);
          continue;
        }
        reject(svgHere ? "PC1018" : "PC1015", `Rejected attribute '${name}' on <${node.tag}>.`);
        continue;
      }
      if (svgHere) {
        if (!svgAllowedAttrs.has(name) && !svgAttrPatterns.some((r) => r.test(name))) {
          reject("PC1018", `Rejected SVG attribute '${name}' on <${node.tag}>.`);
          continue;
        }
      } else if (!attributeAllowed(profile, node.tag, name)) {
        reject("PC1015", `Rejected attribute '${name}' on <${node.tag}>.`);
        continue;
      }
      if (valuePatterns.some((r) => r.test(value))) {
        reject("PC1018", `Rejected attribute value on ${node.tag}[${name}].`);
        continue;
      }
      if ((lower === "href" || lower === "src") && !urlIsSafe(profile, value)) {
        reject("PC1007", `Rejected URL '${value}' on <${node.tag}>.`);
        continue;
      }
      if (lower === "id" && profile.html.reservedIdPrefixes.some((p) => value.startsWith(p))) {
        reject("PC1015", `Rejected id '${value}': it collides with a portal shell identifier.`);
        continue;
      }
      if (
        lower === "class" &&
        !svgHere &&
        !(generated && profile.html.classPolicy.generatedTransforms.includes(generated))
      ) {
        const requested = value.split(/\s+/).filter(Boolean);
        const kept = requested.filter((c) =>
          profile.html.classNamespaces.some((ns) => c === ns || c.startsWith(ns)),
        );
        if (kept.length !== requested.length) {
          reject(
            "PC1015",
            `Rejected class outside the profile namespaces on <${node.tag}>: '${value}'.`,
          );
          continue;
        }
        attrs.push([name, kept.join(" ")]);
        continue;
      }
      attrs.push([name, value]);
    }

    const children: HNode[] = [];
    for (const child of node.children) {
      const kept = walk(child, generated, svgHere);
      if (kept) children.push(kept);
    }
    const result: HElement = { type: "element", tag: node.tag, attrs, children };
    if (node.generatedBy) result.generatedBy = node.generatedBy;
    return result;
  };

  const out: HNode[] = [];
  for (const node of nodes) {
    const kept = walk(node, undefined, svgMode);
    if (kept) out.push(kept);
  }
  return out;
}
