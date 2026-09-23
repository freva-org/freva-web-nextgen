// The single SVG sanitizer (AR-009).
//
// Identity logos, favicons, prose images, landing images, STAC browser chrome and generated
// diagrams all arrive here. There is deliberately no second entry point, so a future component
// schema cannot introduce a raw-SVG copy path. Only the sanitized derivative is ever published;
// the input bytes stay in the input manifest as provenance and never reach the artifact.

import type { Diagnostic } from "../diagnostics.js";
import { sanitize, serialize, type HElement, type HNode } from "./html.js";
import type { ContentProfile } from "./profile.js";
import { parseXml, XmlError } from "./xml.js";

export interface SvgSanitizeResult {
  ok: boolean;
  /** The sanitized derivative, serialized. Empty when the input was rejected. */
  svg: string;
  /**
   * The same derivative as a tree. Callers that splice the SVG into a document use this rather
   * than re-parsing the serialized form: a round trip through the strict reader would be a
   * second chance to disagree with itself.
   */
  root?: HElement;
  diagnostics: Diagnostic[];
}

function findSvgRoot(nodes: HNode[]): HElement | undefined {
  for (const node of nodes) {
    if (node.type === "element" && node.tag === "svg") return node;
  }
  return undefined;
}

export function sanitizeSvg(
  source: string,
  file: string,
  profile: ContentProfile,
  opts: { generatedBy?: string } = {},
): SvgSanitizeResult {
  const diagnostics: Diagnostic[] = [];
  let parsed: HNode[];
  try {
    parsed = parseXml(source);
  } catch (err) {
    const message = err instanceof XmlError ? err.message : String(err);
    return {
      ok: false,
      svg: "",
      diagnostics: [
        {
          code: "PC1018",
          severity: "error",
          message: `SVG could not be parsed strictly: ${message}`,
          file,
          hint: "Export the file as plain SVG. The sanitizer refuses input it cannot read exactly.",
        },
      ],
    };
  }

  const root = findSvgRoot(parsed);
  if (!root) {
    return {
      ok: false,
      svg: "",
      diagnostics: [
        { code: "PC1018", severity: "error", message: "No <svg> root element found.", file },
      ],
    };
  }

  if (profile.svg.requireXmlns && !root.attrs.some(([n]) => n === "xmlns")) {
    root.attrs.unshift(["xmlns", "http://www.w3.org/2000/svg"]);
  }
  if (opts.generatedBy) root.generatedBy = opts.generatedBy;

  const cleaned = sanitize([root], { profile, file, diagnostics, mode: "svg" });
  const ok = diagnostics.every((d) => d.severity !== "error") && cleaned.length === 1;
  const cleanRoot = cleaned[0];
  return {
    ok,
    svg: ok ? serialize(cleaned, profile) : "",
    ...(ok && cleanRoot && cleanRoot.type === "element" ? { root: cleanRoot } : {}),
    diagnostics,
  };
}

/** A favicon or logo is inlined into the shell; both go through the same door. */
export function sanitizeSvgFile(
  bytes: Buffer,
  file: string,
  profile: ContentProfile,
): SvgSanitizeResult {
  return sanitizeSvg(bytes.toString("utf8"), file, profile);
}
