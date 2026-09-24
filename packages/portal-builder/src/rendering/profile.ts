// Typed access to `portal-content-v1.profile.json`.
//
// The profile file is the normative document; this module only gives it a shape TypeScript can
// check. Nothing here re-states a value the JSON already fixes: two copies of a security
// allowlist is one copy too many.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SCHEMA_DIR, sha256 } from "../util/package.js";

export interface ContentProfile {
  profile: string;
  profileVersion: number;
  markdown: {
    containerDirectives: string[];
    rawHtml: "reject";
    autolinkLiteral: { bareWwwScheme: string };
  };
  rst: {
    helper: { package: string; version: string };
    docutilsVersion: string;
    protocol: string;
    allowedDirectives: string[];
    forbiddenDirectives: string[];
    allowedRoles: string[];
    settings: Record<string, unknown>;
  };
  frontmatter: {
    allowedKeys: string[];
    maxDescriptionLength: number;
    /** Inclusive bounds for `navOrder`. Bounded so a stray timestamp is a diagnostic, not a sort. */
    navOrderRange: [number, number];
  };
  ir: {
    nodeTypes: string[];
    locationProvenance: {
      perNodeType: Record<
        string,
        { kind: string; fallback?: string; originRule?: string; transform?: string }
      >;
    };
  };
  headings: {
    tocDepth: [number, number];
    tocDefault: boolean;
    slug: {
      unicodeNormalization: string;
      caseFold: string;
      removePunctuation: string;
      keep: string;
      whitespaceReplacement: string;
      emptyFallback: string;
      duplicateStart: number;
      maxLength: number;
    };
    demoteAuthoredH1: boolean;
  };
  highlighting: {
    theme: string;
    /** The second pass, so token colours exist for the dark portal theme too. */
    darkTheme: string;
    languages: string[];
    classPrefix: string;
    colorClassPrefix: string;
    stylesheet: string;
  };
  mermaid: { idPrefix: string; securityLevel: string };
  math: { throwOnError: boolean; strict: boolean; trust: boolean };
  urls: {
    allowedSchemes: string[];
    forbiddenSchemes: string[];
    dataUriMediaTypes: string[];
  };
  html: {
    allowedElements: string[];
    globalAttributes: string[];
    elementAttributes: Record<string, string[]>;
    styleAttribute: {
      authored: string;
      generatedTransforms: string[];
      allowedDeclarations: string[];
      forbiddenValuePatterns: string[];
    };
    classNamespaces: string[];
    classPolicy: { authored: string; generatedTransforms: string[] };
    /** Elements a named framework transform may emit that authors may not. */
    generatedElements?: Record<string, string[]>;
    forbiddenElements: string[];
    forbiddenAttributePatterns: string[];
    reservedIdPrefixes: string[];
    linkRel: { externalHttps: string[] };
  };
  svg: {
    allowedElements: string[];
    allowedAttributes: string[];
    allowedAttributePatterns: string[];
    forbiddenElements: string[];
    forbiddenAttributePatterns: string[];
    forbiddenValuePatterns: string[];
    requireXmlns: boolean;
  };
  tasklist: {
    listItemAttribute: string;
    markerElement: string;
    markerClass: string;
    labelClass: string;
    checkedLabel: string;
    uncheckedLabel: string;
  };
  serialization: {
    voidElements: string[];
    selfClosingVoid: string;
    booleanAttributeNames: string[];
    preserveCaseAttributes: string[];
  };
  assets: {
    embeddableMimeTypes: Record<string, string>;
    forbiddenAssetExtensions: string[];
    sanitizedExtensions: string[];
  };
  downloads: {
    mimeTypes: Record<string, string>;
    unknownExtensionMimeType: string;
    contentDisposition: string;
    xContentTypeOptions: string;
  };
  limits: {
    maxSourceBytes: number;
    maxPages: number;
    maxAssetBytes: number;
    maxTotalAssetBytes: number;
    maxNodesPerDocument: number;
    maxHeadingDepth: number;
    maxDiagramBytes: number;
    maxNestingDepth: number;
    maxRenderedBytesPerPage: number;
    maxDescriptionLength: number;
    maxSubsiteFiles: number;
    maxSubsiteBytes: number;
  };
  diagnostics: { codes: Record<string, string> };
}

export const PROFILE_FILE = "portal-content-v1.profile.json";

let cached: { profile: ContentProfile; digest: string } | undefined;

export function loadProfile(): { profile: ContentProfile; digest: string; name: string } {
  if (!cached) {
    const bytes = readFileSync(join(SCHEMA_DIR, PROFILE_FILE));
    cached = {
      profile: JSON.parse(bytes.toString("utf8")) as ContentProfile,
      digest: sha256(bytes),
    };
  }
  return { ...cached, name: cached.profile.profile };
}

/** Consumer `rendering.limits` may only raise the published guardrails, never lower a security bound. */
export function effectiveLimits(
  profile: ContentProfile,
  overrides: Partial<ContentProfile["limits"]> | undefined,
): ContentProfile["limits"] {
  const out = { ...profile.limits };
  if (!overrides) return out;
  for (const [key, value] of Object.entries(overrides) as [
    keyof ContentProfile["limits"],
    number | undefined,
  ][]) {
    if (typeof value === "number" && value > out[key]) out[key] = value;
  }
  return out;
}
