// Build-time mathematics.
//
// KaTeX runs during the build and the artifact ships the resulting markup, so a reader with
// JavaScript disabled still sees the formula and no maths engine is downloaded. `strict` and
// `throwOnError` are on: a TeX command outside the pinned support surface is a source-located
// build error rather than a red "\\undefined" nobody notices until a reader reports it.

import katex from "katex";
import type { Diagnostic } from "../diagnostics.js";
import type { HNode } from "./html.js";
import type { ContentProfile } from "./profile.js";
import { parseXml, XmlError } from "./xml.js";

export interface MathResult {
  nodes: HNode[];
  diagnostics: Diagnostic[];
}

function tag(nodes: HNode[]): HNode[] {
  for (const node of nodes) if (node.type === "element") node.generatedBy = "katex";
  return nodes;
}

export function renderMath(
  tex: string,
  displayMode: boolean,
  file: string,
  line: number | undefined,
  profile: ContentProfile,
): MathResult {
  try {
    const html = katex.renderToString(tex, {
      displayMode,
      output: "htmlAndMathml",
      throwOnError: profile.math.throwOnError,
      strict: profile.math.strict ? "error" : "ignore",
      trust: profile.math.trust,
    });
    return { nodes: tag(parseXml(html)), diagnostics: [] };
  } catch (err) {
    const message =
      err instanceof XmlError
        ? `KaTeX produced markup the sanitizer could not read: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    const d: Diagnostic = {
      code: "PC1011",
      severity: "error",
      message: `Invalid mathematics: ${message}`,
      file,
    };
    if (line !== undefined) d.position = { line };
    return { nodes: [], diagnostics: [d] };
  }
}
