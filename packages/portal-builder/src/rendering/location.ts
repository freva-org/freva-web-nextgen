// Source-location provenance (AR-002).
//
// Parsers do not report a position for every node, and the honest answer to that is not "use
// the parent's line and call it parser-provided". A location is labelled with how it was
// obtained: reported by the parser, inherited through a rule the profile *names*, or generated
// by a transform. Each rule is resolved by the caller, so a location cannot claim to come from
// `parent-figure` when no figure was involved, and a rule that cannot be satisfied produces
// `generated` rather than a plausible substitute.

import type { SourceLocation } from "./ir.js";
import type { ContentProfile } from "./profile.js";

export interface ParserPosition {
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
}

export interface OriginNode {
  loc: SourceLocation;
  type: string;
}

/**
 * The origins a caller can offer, keyed by the rule name the profile uses. A rule with no entry
 * here is unsatisfiable, which is a real answer.
 */
export interface OriginContext {
  "nearest-ancestor-with-position"?: OriginNode;
  "parent-figure"?: OriginNode;
  "parent-document-first-child"?: OriginNode;
  "origin-code-node"?: OriginNode;
}

export function ruleFor(
  profile: ContentProfile,
  type: string,
): { kind: string; fallback?: string; originRule?: string; transform?: string } {
  const table = profile.ir.locationProvenance.perNodeType;
  return table[type] ?? table["*"] ?? { kind: "parser", fallback: "generated" };
}

function originFor(
  origins: OriginContext | OriginNode | undefined,
  rule: string | undefined,
): { origin: OriginNode | undefined; ruleName: string } {
  const ruleName = rule ?? "nearest-ancestor-with-position";
  if (!origins) return { origin: undefined, ruleName };
  // A bare node is shorthand for "the nearest positioned ancestor".
  if ("loc" in origins && "type" in origins) {
    return {
      origin: ruleName === "nearest-ancestor-with-position" ? (origins as OriginNode) : undefined,
      ruleName,
    };
  }
  return { origin: (origins as OriginContext)[ruleName as keyof OriginContext], ruleName };
}

/**
 * Build the location for one node. `reported` is what the parser said; `origins` is what the
 * caller can offer for each named rule.
 */
export function locationFor(
  profile: ContentProfile,
  type: string,
  file: string,
  reported: ParserPosition | undefined,
  origins: OriginContext | OriginNode | undefined,
): SourceLocation {
  const rule = ruleFor(profile, type);
  const { origin, ruleName } = originFor(origins, rule.originRule);

  if (rule.kind === "generated") {
    const loc: SourceLocation = { kind: "generated", file, transform: rule.transform ?? type };
    if (origin) {
      loc.originType = origin.type;
      const line = lineOf(origin.loc);
      if (line !== undefined) loc.line = line;
    }
    return loc;
  }

  if (reported?.line !== undefined) {
    const loc: SourceLocation = { kind: "parser", file, line: reported.line };
    if (reported.column !== undefined) loc.column = reported.column;
    if (reported.endLine !== undefined) loc.endLine = reported.endLine;
    if (reported.endColumn !== undefined) loc.endColumn = reported.endColumn;
    return loc;
  }

  if (rule.fallback === "inherited" && origin) {
    const line = lineOf(origin.loc);
    if (line !== undefined) {
      const loc: SourceLocation = {
        kind: "inherited",
        file,
        line,
        originRule: ruleName,
        originType: origin.type,
      };
      const column = columnOf(origin.loc);
      if (column !== undefined) loc.column = column;
      return loc;
    }
  }

  // The named rule could not be satisfied. Saying so is the point.
  return { kind: "generated", file, transform: "parser-position-unavailable" };
}

export function lineOf(loc: SourceLocation): number | undefined {
  return loc.kind === "generated" ? loc.line : loc.line;
}

export function columnOf(loc: SourceLocation): number | undefined {
  return loc.kind === "generated" ? undefined : loc.column;
}

/** A node a transform created, naming the transform and its origin when one exists. */
export function generatedLocation(
  file: string,
  transform: string,
  origin?: OriginNode,
): SourceLocation {
  const loc: SourceLocation = { kind: "generated", file, transform };
  if (origin) {
    loc.originType = origin.type;
    const line = lineOf(origin.loc);
    if (line !== undefined) loc.line = line;
  }
  return loc;
}
