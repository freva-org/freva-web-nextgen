/**
 * The one YAML door into the builder. Three things are not left to the library's defaults:
 *
 *  - YAML 1.2 *core* scalar semantics, so `yes` is the string "yes" and `2026-08-18` is the
 *    string "2026-08-18"; a value must not change type with the spelling YAML 1.1 prefers.
 *  - anchors, aliases, merge keys and custom tags are refused, not resolved: they let one
 *    reviewed document expand into another.
 *  - duplicate keys are an error, not a last-one-wins silent override.
 */

import {
  LineCounter,
  parseDocument,
  isAlias,
  isCollection,
  isMap,
  isPair,
  isScalar,
  isSeq,
  visit,
} from "yaml";
import type { Node } from "yaml";
import type { Diagnostic, SourcePosition } from "../diagnostics.js";

export interface YamlLoadResult<T = unknown> {
  value: T | undefined;
  diagnostics: Diagnostic[];
  /** Resolves a JSON Pointer to a source position, for schema diagnostics. */
  positionOf(pointer: string): SourcePosition | undefined;
}

const DEFAULT_TAGS = new Set([
  "tag:yaml.org,2002:str",
  "tag:yaml.org,2002:int",
  "tag:yaml.org,2002:float",
  "tag:yaml.org,2002:bool",
  "tag:yaml.org,2002:null",
  "tag:yaml.org,2002:map",
  "tag:yaml.org,2002:seq",
]);

function positionFromOffset(
  lc: LineCounter,
  offset: number | undefined,
): SourcePosition | undefined {
  if (offset === undefined) return undefined;
  const p = lc.linePos(offset);
  return { line: p.line, column: p.col };
}

/** Spread helper: an absent position must not become `position: undefined`. */
function at(position: SourcePosition | undefined): { position?: SourcePosition } {
  return position ? { position } : {};
}

/**
 * Parse one configuration document. `file` is the source-root-relative path used in diagnostics;
 * the caller has already contained it.
 */
export function loadYaml<T = unknown>(text: string, file: string): YamlLoadResult<T> {
  const diagnostics: Diagnostic[] = [];
  const lineCounter = new LineCounter();

  const doc = parseDocument(text, {
    version: "1.2",
    schema: "core",
    uniqueKeys: true,
    merge: false,
    keepSourceTokens: false,
    lineCounter,
    customTags: [],
    strict: true,
  });

  for (const err of doc.errors) {
    diagnostics.push({
      code: err.code === "DUPLICATE_KEY" ? "FP1103" : "FP1101",
      severity: "error",
      message: err.message,
      file,
      ...at(positionFromOffset(lineCounter, err.pos[0])),
    });
  }
  for (const warn of doc.warnings) {
    diagnostics.push({
      code: "FP1102",
      severity: "error",
      message: warn.message,
      file,
      ...at(positionFromOffset(lineCounter, warn.pos[0])),
      hint: "portal.yaml accepts plain YAML 1.2 core values only.",
    });
  }

  // Anchors, aliases, merge keys and explicit tags: refused, never resolved.
  visit(doc, {
    Alias(_key, node) {
      diagnostics.push({
        code: "FP1102",
        severity: "error",
        message: `YAML aliases are forbidden in portal configuration (*${node.source}).`,
        file,
        ...at(positionFromOffset(lineCounter, node.range?.[0])),
        hint: "Write the value out. A reviewed configuration should read the way it behaves.",
      });
    },
    Node(_key, node) {
      const anchor = (node as { anchor?: string }).anchor;
      if (anchor) {
        diagnostics.push({
          code: "FP1102",
          severity: "error",
          message: `YAML anchors are forbidden in portal configuration (&${anchor}).`,
          file,
          ...at(positionFromOffset(lineCounter, node.range?.[0])),
        });
      }
      const tag = (node as { tag?: string }).tag;
      if (tag && !DEFAULT_TAGS.has(tag)) {
        diagnostics.push({
          code: "FP1102",
          severity: "error",
          message: `YAML tag ${tag} is forbidden in portal configuration.`,
          file,
          ...at(positionFromOffset(lineCounter, node.range?.[0])),
        });
      }
    },
    Pair(_key, pair) {
      const k = pair.key;
      if (isScalar(k) && k.value === "<<") {
        diagnostics.push({
          code: "FP1102",
          severity: "error",
          message: "YAML merge keys (<<) are forbidden in portal configuration.",
          file,
          ...at(positionFromOffset(lineCounter, k.range?.[0])),
        });
      }
    },
  });

  const value = diagnostics.some((d) => d.severity === "error")
    ? undefined
    : (doc.toJS({ maxAliasCount: 0 }) as T);

  const positionOf = (pointer: string): SourcePosition | undefined => {
    const segments = pointer
      .split("/")
      .slice(1)
      .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
    let node: Node | null = (doc.contents as Node | null) ?? null;
    let best = node;
    for (const seg of segments) {
      if (!node || !isCollection(node)) break;
      let next: Node | null = null;
      if (isMap(node)) {
        for (const item of node.items) {
          if (isPair(item) && isScalar(item.key) && String(item.key.value) === seg) {
            next = (item.value as Node) ?? (item.key as Node);
            break;
          }
        }
      } else if (isSeq(node)) {
        const idx = Number(seg);
        next = Number.isInteger(idx) ? ((node.items[idx] as Node) ?? null) : null;
      }
      if (!next || isAlias(next)) break;
      node = next;
      best = node;
    }
    return positionFromOffset(lineCounter, best?.range?.[0]);
  };

  return { value, diagnostics, positionOf };
}
