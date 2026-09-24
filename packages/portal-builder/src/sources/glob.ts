// The one pinned glob implementation. A dependency would be a second opinion about dotfiles,
// case sensitivity and `**` that could change under us in a patch release and silently add or
// drop a page from every consumer's site. The accepted syntax is deliberately small: `**`,
// `*`, `?` and literals, with POSIX `/` separators.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Diagnostic } from "../diagnostics.js";
import { toPosix } from "../config/paths.js";
import { compareCodePoints } from "../util/order.js";

export { compareCodePoints } from "../util/order.js";

function segmentToRegex(segment: string): string {
  let out = "";
  for (const ch of segment) {
    if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return out;
}

/**
 * Compile one pattern. Dotfiles are excluded unless the *pattern segment* in that position
 * literally starts with `.` — the MkDocs-like behavior that keeps `_fragments/**` and
 * `.git/**` honest.
 */
export function compileGlob(pattern: string): RegExp {
  const segments = pattern.split("/");
  let re = "^";
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const last = i === segments.length - 1;
    if (seg === "**") {
      // `**/` matches zero or more non-dot segments.
      re += last ? "(?:(?!\\.)[^/]+)(?:/(?!\\.)[^/]+)*" : "(?:(?!\\.)[^/]+/)*";
      if (!last) continue;
    } else {
      const dotOk = seg.startsWith(".");
      re += (dotOk ? "" : "(?!\\.)") + segmentToRegex(seg);
      if (!last) re += "/";
    }
  }
  re += "$";
  return new RegExp(re);
}

export function globMatches(pattern: string, relPath: string): boolean {
  return compileGlob(pattern).test(relPath);
}

export interface WalkResult {
  /** Root-relative POSIX paths, sorted by Unicode code point. */
  files: string[];
  diagnostics: Diagnostic[];
}

/**
 * Walk a declared root. Symlinks are never followed and are reported: a project input that is
 * a link is exactly the case the trusted-source-root rule exists to refuse.
 */
export function walkRoot(absRoot: string, rootLabel: string): WalkResult {
  const files: string[] = [];
  const diagnostics: Diagnostic[] = [];

  const walk = (dir: string, prefix: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      compareCodePoints(a.name, b.name),
    );
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        diagnostics.push({
          code: "FP1002",
          severity: "error",
          message: `Symlink in a declared input root: ${rel}`,
          file: `${rootLabel}/${rel}`,
          hint: "Replace the link with the real file, or move the target inside the trusted source root.",
        });
        continue;
      }
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else if (entry.isFile()) files.push(toPosix(rel));
    }
  };

  walk(absRoot, "");
  files.sort(compareCodePoints);
  return { files, diagnostics };
}

export interface SelectOptions {
  include: string[];
  exclude: string[];
}

export function selectFiles(all: string[], opts: SelectOptions): string[] {
  const inc = opts.include.map(compileGlob);
  const exc = opts.exclude.map(compileGlob);
  return all.filter((f) => inc.some((r) => r.test(f)) && !exc.some((r) => r.test(f)));
}
