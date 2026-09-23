// Normalizing the block spellings a consumer's documentation already uses.
//
// The Markdown pipeline understands one block syntax: the container directive,
// `:::note[Title]`. Real documentation is written for Material for MkDocs (`!!! note "Title"`,
// `??? note`, `/// caption`), for MyST (`:::{note}`, `:::{figure}`, `:::{table}`) or for
// GitHub (`> [!NOTE]`), so the portal reads their documentation rather than asking them to
// rewrite it.
//
// This runs on the source text, before the parser, and rewrites only the block *openers*,
// never the body: a fenced code block is skipped in its entirety, so `!!! note` inside a
// snippet about MkDocs stays one; an indented body is dedented by exactly the indentation the
// opener established, so lists, nested admonitions, code fences and mathematics inside it
// survive as themselves; and nesting works because the rewrite recurses over the dedented body.
//
// Line and column numbers shift, so the returned `lineMap` maps each output line back to the
// line the author wrote and a diagnostic still points at their file.

export interface NormalizedSource {
  text: string;
  /** Output line (0-based) to source line (1-based). */
  lineMap: number[];
  /**
   * What the rewrite refused, with the author's own line. A block spelling this pass
   * recognizes but cannot accept must not fall through to the parser, where it is simply
   * prose: the reader sees `/// caption` printed in the middle of their page and nothing says
   * why. The caller raises these as diagnostics.
   */
  problems: NormalizationProblem[];
}

export interface NormalizationProblem {
  code: string;
  line: number;
  message: string;
  hint?: string;
}

/** `!!! note "Title"`, `??? note "Title"`, `???+ note "Title"`. */
const MKDOCS =
  /^(\s*)(!!!|\?\?\?\+?)\s+([A-Za-z][\w-]*)((?:\s+[A-Za-z][\w-]*)*)\s*(?:"([^"]*)")?\s*$/;
/** MyST: `:::{note}` or `:::{note} Title`, with any fence length >= 3. */
const MYST = /^(\s*)(:{3,})\{([A-Za-z][\w-]*)\}\s*(.*)$/;
/**
 * The profile's own spelling, `:::note[Title]`, with any fence length >= 3. Already valid
 * input, but it still has to be *re-fenced*: a caption emitted inside one of these would
 * otherwise be written with three colons too, and the first `:::` line would close the
 * admonition instead of the caption, stranding the real closer as a paragraph reading `:::`.
 */
const DIRECTIVE = /^(\s*)(:{3,})([A-Za-z][\w-]*)(.*)$/;
/** A list item marker, which changes what four spaces of indentation mean. */
const LIST_ITEM = /^\s*(?:[-*+]|\d{1,9}[.)])(?:\s|$)/;
/** A fenced code block, so its contents are never rewritten. */
const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/;
/** GitHub alerts: a blockquote whose first line is `> [!NOTE]`. */
const GITHUB = /^(\s*)>\s*\[!([A-Za-z]+)\]\s*$/;
/**
 * PyMdown Blocks: `/// caption`, closed by a line of exactly `///`. The name is captured
 * rather than matched, so a block this profile does not support - `/// tab`, `/// html`,
 * `/// define` - is *recognized* and refused with a diagnostic instead of printed as prose.
 */
const PYMDOWN = /^(\s*)\/\/\/[ \t]*(\S*)[ \t]*(.*)$/;
/** The internal directive names the rewrite emits. Not authored vocabulary. */
export const CAPTION_DIRECTIVE = "portal-caption";
export const FIGURE_DIRECTIVE = "portal-figure";
export const LEGEND_DIRECTIVE = "portal-legend";
/** `:alt: text` - one MyST directive option. */
const MYST_OPTION = /^:([A-Za-z][\w-]*):[ \t]*(.*)$/;
/** The MyST directive options this profile accepts on a figure. */
const FIGURE_OPTIONS = new Set(["alt", "width", "align", "name"]);
/** `align:` values that mean something to the theme. */
const FIGURE_ALIGN = new Set(["left", "center", "right"]);
/** A `name:` becomes an id, so it has to be one the sanitizer would accept. */
const SAFE_NAME = /^[A-Za-z][\w:.-]*$/;

/**
 * The directive fence for a block whose deepest nested child is `height` levels below it.
 * Longer on the *outside*, not the inside: a container directive is closed by the first fence
 * at least as long as its own opener, so an inner `::::` inside an outer `:::` would close the
 * outer block and strand its real closer as literal text. Heights are computed bottom-up - a
 * leaf gets three colons, every ancestor one more than its deepest child.
 */
function fenceFor(height: number): string {
  return ":".repeat(3 + height);
}

function isBlank(line: string): boolean {
  return line.trim() === "";
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** Everything up to the block's own closing marker, dedented by the opener. */
function takeUntil(
  lines: string[],
  from: number,
  indent: string,
  isCloser: (line: string) => boolean,
): { body: string[]; next: number; closed: boolean } {
  const body: string[] = [];
  let i = from;
  while (i < lines.length && !isCloser(lines[i]!)) {
    body.push(lines[i]!.startsWith(indent) ? lines[i]!.slice(indent.length) : lines[i]!);
    i += 1;
  }
  const closed = i < lines.length;
  return { body, next: closed ? i + 1 : i, closed };
}

/** Trim leading and trailing blank lines, keeping the source indices aligned. */
function trimBlank(body: string[], sources: number[]): void {
  while (body.length > 0 && isBlank(body[0]!)) {
    body.shift();
    sources.shift();
  }
  while (body.length > 0 && isBlank(body[body.length - 1]!)) {
    body.pop();
    sources.pop();
  }
}

/** `key="value"` for a directive attribute list, with the value escaped. */
function attribute(key: string, value: string): string {
  return `${key}="${value.replace(/["\\]/g, (c) => `\\${c}`)}"`;
}

/**
 * Rewrite one block of lines. Returns the height of the tallest admonition emitted at this
 * level, or -1 when this level contained none, so a caller can pick a fence longer than every
 * fence inside it.
 */
function rewrite(
  lines: string[],
  sourceStart: number,
  out: string[],
  map: number[],
  problems: NormalizationProblem[],
): number {
  let i = 0;
  let tallest = -1;

  const emit = (text: string, sourceLine: number): void => {
    out.push(text);
    map.push(sourceLine);
  };

  const refuse = (line: number, code: string, message: string, hint?: string): void => {
    problems.push({ code, line, message, ...(hint ? { hint } : {}) });
  };

  /**
   * Emit a nested block at the indentation its opener was written at. The indentation matters:
   * a caption written inside a list item arrives here dedented, and emitting it at column zero
   * would end the list and leave the caption describing the list rather than the image in it.
   */
  const emitBlock = (
    opener: (fence: string) => string,
    body: string[],
    bodySources: number[],
    sourceLine: number,
    indent = "",
  ): void => {
    const inner: string[] = [];
    const innerMap: number[] = [];
    const height = rewrite(body, 0, inner, innerMap, problems) + 1;
    tallest = Math.max(tallest, height);
    const fence = fenceFor(height);
    const at = (text: string): string => (text === "" ? "" : `${indent}${text}`);
    emit(at(opener(fence)), sourceLine);
    inner.forEach((text, index) => emit(at(text), bodySources[innerMap[index]!] ?? sourceLine));
    emit(at(fence), sourceLine);
  };

  // Where an indented code block could begin. CommonMark starts one at four spaces of
  // indentation, but only where a new block could start - not as the continuation of a
  // paragraph, and not inside a list, where four spaces is the item's own content. Tracking
  // those two facts is what leaves `    /// caption` in a snippet alone.
  let afterBlank = true;
  let inList = false;

  while (i < lines.length) {
    const line = lines[i]!;
    const sourceLine = sourceStart + i;

    if (isBlank(line)) {
      afterBlank = true;
      emit(line, sourceLine);
      i += 1;
      continue;
    }
    const lineIndent = indentOf(line);
    if (afterBlank && !inList && lineIndent >= 4) {
      // An indented code block: everything through the last line before a non-blank line
      // that is indented less.
      while (i < lines.length && (isBlank(lines[i]!) || indentOf(lines[i]!) >= 4)) {
        emit(lines[i]!, sourceStart + i);
        i += 1;
      }
      afterBlank = false;
      continue;
    }
    if (LIST_ITEM.test(line)) inList = true;
    else if (lineIndent === 0) inList = false;
    afterBlank = false;

    // A code fence is copied through untouched, opener to closer.
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[2]!;
      const info = fenceMatch[3]!.trim();
      // Unless the info string names a directive. MyST writes the same block two ways -
      // ```{figure} and :::{figure} - and a consumer's file may carry either. Rewriting the
      // backtick form into the colon form and re-entering costs one pass and keeps the two
      // from drifting apart.
      const braced = /^\{([A-Za-z][\w-]*)\}[ \t]*(.*)$/.exec(info);
      if (braced) {
        const indent = fenceMatch[1]!;
        const body: string[] = [];
        const bodySources: number[] = [];
        let cursor = i + 1;
        while (cursor < lines.length && !lines[cursor]!.trim().startsWith(marker)) {
          body.push(
            lines[cursor]!.startsWith(indent)
              ? lines[cursor]!.slice(indent.length)
              : lines[cursor]!,
          );
          bodySources.push(sourceStart + cursor);
          cursor += 1;
        }
        if (cursor >= lines.length) {
          refuse(
            sourceLine,
            "PC1020",
            `This \`${marker}{${braced[1]!}}\` block is never closed.`,
            `Close it with \`${marker}\`.`,
          );
          i = cursor;
          continue;
        }
        const colonForm = [`:::{${braced[1]!}} ${braced[2]!}`.trimEnd(), ...body, ":::"];
        const colonSources = [sourceLine, ...bodySources, sourceStart + cursor];
        const inner: string[] = [];
        const innerMap: number[] = [];
        const height = rewrite(colonForm, 0, inner, innerMap, problems);
        tallest = Math.max(tallest, height);
        inner.forEach((text, index) => emit(text, colonSources[innerMap[index]!] ?? sourceLine));
        i = cursor + 1;
        continue;
      }
      emit(line, sourceLine);
      i += 1;
      while (i < lines.length) {
        emit(lines[i]!, sourceStart + i);
        if (lines[i]!.trim().startsWith(marker)) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    // PyMdown Blocks: `/// caption`. Recognized here rather than left to the parser precisely
    // so a form this profile does not support is *refused* instead of printed. The caption is
    // emitted as a container directive after a blank line, because a `:::` line written
    // directly under a paragraph would be swallowed by it rather than open a block.
    const pymdown = PYMDOWN.exec(line);
    if (pymdown) {
      const indent = pymdown[1]!;
      const name = pymdown[2]!;
      const rest = pymdown[3]!.trim();
      // A bare `///` here is a closer with no opener: an opener would have consumed it.
      if (name === "" && rest === "") {
        refuse(
          sourceLine,
          "PC1020",
          "A `///` closes a block that was never opened.",
          "A caption block is `/// caption`, its text, then a line of `///`.",
        );
        i += 1;
        continue;
      }
      // A refused opener still consumes its body and its closer. One mistake should produce
      // one diagnostic: leaving the `///` behind would report it again as a closer with no
      // opener, and leave the body as prose.
      const skip = (): number => takeUntil(lines, i + 1, indent, (l) => l.trim() === "///").next;
      if (name !== "caption") {
        refuse(
          sourceLine,
          "PC1020",
          `Block '/// ${name}' is not part of portal-content-v1.`,
          "Only `/// caption` is supported.",
        );
        i = skip();
        continue;
      }
      if (rest !== "") {
        refuse(
          sourceLine,
          "PC1020",
          "A caption block takes no arguments or attributes.",
          "Write `/// caption` on its own line; the caption text goes on the lines below it.",
        );
        i = skip();
        continue;
      }
      const taken = takeUntil(lines, i + 1, indent, (l) => l.trim() === "///");
      const bodySources = taken.body.map((_, index) => sourceStart + i + 1 + index);
      if (!taken.closed) {
        refuse(sourceLine, "PC1020", "This caption block is never closed.", "Close it with `///`.");
        i = taken.next;
        continue;
      }
      trimBlank(taken.body, bodySources);
      if (taken.body.length === 0) {
        refuse(sourceLine, "PC1020", "This caption block is empty.");
        i = taken.next;
        continue;
      }
      // The blank line is what makes the directive a block of its own rather than the last
      // line of the paragraph above it.
      emit("", sourceLine);
      emitBlock(
        (fence) => `${fence}${CAPTION_DIRECTIVE}`,
        taken.body,
        bodySources,
        sourceLine,
        indent,
      );
      i = taken.next;
      continue;
    }

    const github = GITHUB.exec(line);
    if (github) {
      const type = github[2]!;
      // Collect the rest of the blockquote and strip one level of `>`.
      const body: string[] = [];
      const bodySources: number[] = [];
      i += 1;
      while (i < lines.length && /^\s*>/.test(lines[i]!)) {
        body.push(lines[i]!.replace(/^\s*>\s?/, ""));
        bodySources.push(sourceStart + i);
        i += 1;
      }
      const inner: string[] = [];
      const innerMap: number[] = [];
      const height = rewrite(body, 0, inner, innerMap, problems) + 1;
      tallest = Math.max(tallest, height);
      const fence = fenceFor(height);
      emit(`${fence}${type.toLowerCase()}`, sourceLine);
      inner.forEach((text, index) => emit(text, bodySources[innerMap[index]!] ?? sourceLine));
      emit(fence, sourceLine);
      continue;
    }

    // The closed MyST subset: `:::{figure}` and `:::{table}`. Handled before the admonition
    // branch, which would otherwise read `:::{figure} path` as an admonition named "figure"
    // titled with the path. Both are rewritten into shapes the pipeline already carries: a
    // figure becomes one directive holding its image, caption and legend, and a table caption
    // becomes an ordinary caption block placed *after* the table, where the attachment pass
    // looks for one.
    const mystDirective = MYST.exec(line);
    if (mystDirective && (mystDirective[3] === "figure" || mystDirective[3] === "table")) {
      const indent = mystDirective[1]!;
      const closer = mystDirective[2]!;
      const kind = mystDirective[3]!;
      const argument = mystDirective[4]!.trim();
      const taken = takeUntil(lines, i + 1, indent, (l) => l.trim() === closer);
      const bodySources = taken.body.map((_, index) => sourceStart + i + 1 + index);
      if (!taken.closed) {
        refuse(
          sourceLine,
          "PC1020",
          `This \`:::{${kind}}\` block is never closed.`,
          `Close it with \`${closer}\`.`,
        );
        i = taken.next;
        continue;
      }
      i = taken.next;

      if (kind === "table") {
        if (!argument) {
          refuse(
            sourceLine,
            "PC1020",
            "`:::{table}` needs its caption on the opening line.",
            "Write `:::{table} Dataset availability`.",
          );
          continue;
        }
        trimBlank(taken.body, bodySources);
        // The table first, then its caption: the attachment pass reads backwards from a
        // caption to the block it belongs to.
        taken.body.forEach((text, index) => emit(text, bodySources[index] ?? sourceLine));
        emit("", sourceLine);
        emitBlock((fence) => `${fence}${CAPTION_DIRECTIVE}`, [argument], [sourceLine], sourceLine);
        continue;
      }

      // `:::{figure} src`, then `:option: value` lines, then caption and legend.
      if (!argument) {
        refuse(
          sourceLine,
          "PC1020",
          "`:::{figure}` needs the image path on the opening line.",
          "Write `:::{figure} assets/example.png`.",
        );
        continue;
      }
      const options: Record<string, string> = {};
      let cursor = 0;
      let rejected = false;
      while (cursor < taken.body.length) {
        const candidate = taken.body[cursor]!;
        if (isBlank(candidate)) {
          cursor += 1;
          continue;
        }
        const option = MYST_OPTION.exec(candidate.trim());
        if (!option) break;
        const key = option[1]!.toLowerCase();
        const value = option[2]!.trim();
        const at = bodySources[cursor] ?? sourceLine;
        if (!FIGURE_OPTIONS.has(key)) {
          refuse(
            at,
            "PC1020",
            `Figure option ':${key}:' is not part of portal-content-v1.`,
            `Supported options: ${[...FIGURE_OPTIONS].sort().join(", ")}.`,
          );
          rejected = true;
        } else if (key === "align" && !FIGURE_ALIGN.has(value)) {
          refuse(at, "PC1020", `Figure ':align:' accepts left, center or right, not '${value}'.`);
          rejected = true;
        } else if (key === "name" && !SAFE_NAME.test(value)) {
          refuse(
            at,
            "PC1020",
            `Figure ':name:' must be a plain identifier, not '${value}'.`,
            "It becomes the element's id.",
          );
          rejected = true;
        } else {
          options[key] = value;
        }
        cursor += 1;
      }
      if (rejected) continue;
      const body = taken.body.slice(cursor);
      const sources = bodySources.slice(cursor);
      trimBlank(body, sources);
      const attributes = [attribute("src", argument)];
      for (const key of [...FIGURE_OPTIONS].sort()) {
        const value = options[key];
        if (value !== undefined) attributes.push(attribute(key, value));
      }
      // The first paragraph is the caption and the rest is the legend, the docutils rule for
      // `.. figure::` that MyST inherits. They are emitted as two nested directives so the
      // lowering does not have to guess which paragraph was which.
      const breakAt = body.findIndex((text) => isBlank(text));
      const captionLines = breakAt === -1 ? body : body.slice(0, breakAt);
      const captionSources = breakAt === -1 ? sources : sources.slice(0, breakAt);
      const legendLines = breakAt === -1 ? [] : body.slice(breakAt + 1);
      const legendSources = breakAt === -1 ? [] : sources.slice(breakAt + 1);
      trimBlank(legendLines, legendSources);

      const inner: string[] = [];
      const innerSources: number[] = [];
      if (captionLines.length > 0) {
        inner.push(`${CAPTION_DIRECTIVE}-open`);
        innerSources.push(sourceLine);
        captionLines.forEach((text, index) => {
          inner.push(text);
          innerSources.push(captionSources[index] ?? sourceLine);
        });
        inner.push(`${CAPTION_DIRECTIVE}-close`);
        innerSources.push(sourceLine);
      }
      if (legendLines.length > 0) {
        inner.push(`${LEGEND_DIRECTIVE}-open`);
        innerSources.push(sourceLine);
        legendLines.forEach((text, index) => {
          inner.push(text);
          innerSources.push(legendSources[index] ?? sourceLine);
        });
        inner.push(`${LEGEND_DIRECTIVE}-close`);
        innerSources.push(sourceLine);
      }
      // The placeholders above become real fences here, once the nesting depth of everything
      // inside is known.
      const materialized: string[] = [];
      const materializedSources: number[] = [];
      const nested: string[] = [];
      const nestedMap: number[] = [];
      const innerHeight = rewrite(inner, 0, nested, nestedMap, problems);
      const childFence = fenceFor(innerHeight + 1);
      nested.forEach((text, index) => {
        const source = innerSources[nestedMap[index]!] ?? sourceLine;
        if (text === `${CAPTION_DIRECTIVE}-open`) {
          materialized.push(`${childFence}${CAPTION_DIRECTIVE}`);
        } else if (text === `${LEGEND_DIRECTIVE}-open`) {
          materialized.push(`${childFence}${LEGEND_DIRECTIVE}`);
        } else if (text === `${CAPTION_DIRECTIVE}-close` || text === `${LEGEND_DIRECTIVE}-close`) {
          materialized.push(childFence);
        } else {
          materialized.push(text);
        }
        materializedSources.push(source);
      });
      const outerFence = fenceFor(innerHeight + 2);
      tallest = Math.max(tallest, innerHeight + 2);
      emit(`${outerFence}${FIGURE_DIRECTIVE}{${attributes.join(" ")}}`, sourceLine);
      materialized.forEach((text, index) => emit(text, materializedSources[index] ?? sourceLine));
      emit(outerFence, sourceLine);
      continue;
    }

    const myst = MYST.exec(line);
    if (myst) {
      const indent = myst[1]!;
      const closer = myst[2]!;
      const type = myst[3]!;
      const title = myst[4]!.trim();
      const body: string[] = [];
      const bodySources: number[] = [];
      i += 1;
      while (i < lines.length && lines[i]!.trim() !== closer) {
        body.push(lines[i]!.startsWith(indent) ? lines[i]!.slice(indent.length) : lines[i]!);
        bodySources.push(sourceStart + i);
        i += 1;
      }
      if (i < lines.length) i += 1; // the closing fence
      const inner: string[] = [];
      const innerMap: number[] = [];
      const height = rewrite(body, 0, inner, innerMap, problems) + 1;
      tallest = Math.max(tallest, height);
      const fence = fenceFor(height);
      emit(`${fence}${type}${title ? `[${title}]` : ""}`, sourceLine);
      inner.forEach((text, index) => emit(text, bodySources[innerMap[index]!] ?? sourceLine));
      emit(fence, sourceLine);
      continue;
    }

    const directive = DIRECTIVE.exec(line);
    if (directive) {
      const indent = directive[1]!;
      const closer = directive[2]!;
      const suffix = `${directive[3]!}${directive[4]!}`;
      const body: string[] = [];
      const bodySources: number[] = [];
      i += 1;
      while (i < lines.length && lines[i]!.trim() !== closer) {
        body.push(lines[i]!.startsWith(indent) ? lines[i]!.slice(indent.length) : lines[i]!);
        bodySources.push(sourceStart + i);
        i += 1;
      }
      if (i < lines.length) i += 1; // the closing fence
      const inner: string[] = [];
      const innerMap: number[] = [];
      const height = rewrite(body, 0, inner, innerMap, problems) + 1;
      tallest = Math.max(tallest, height);
      const fence = fenceFor(height);
      emit(`${fence}${suffix}`, sourceLine);
      inner.forEach((text, index) => emit(text, bodySources[innerMap[index]!] ?? sourceLine));
      emit(fence, sourceLine);
      continue;
    }

    const mkdocs = MKDOCS.exec(line);
    if (mkdocs) {
      const openerIndent = mkdocs[1]!.length;
      const marker = mkdocs[2]!;
      const type = mkdocs[3]!;
      const title = mkdocs[5];
      // Everything more-indented than the opener is the body, blank lines included; the first
      // line at or below the opener's indent ends it.
      const body: string[] = [];
      const bodySources: number[] = [];
      i += 1;
      let bodyIndent = -1;
      while (i < lines.length) {
        const candidate = lines[i]!;
        if (isBlank(candidate)) {
          body.push("");
          bodySources.push(sourceStart + i);
          i += 1;
          continue;
        }
        const indent = indentOf(candidate);
        if (indent <= openerIndent) break;
        if (bodyIndent === -1) bodyIndent = indent;
        body.push(candidate.slice(Math.min(bodyIndent, indent)));
        bodySources.push(sourceStart + i);
        i += 1;
      }
      // Trailing blank lines belong after the block, not inside it.
      while (body.length > 0 && isBlank(body[body.length - 1]!)) {
        body.pop();
        bodySources.pop();
      }

      const collapsible = marker.startsWith("???") ? (marker === "???+" ? "open" : "closed") : "";
      const attributes = collapsible ? `{collapsible="${collapsible}"}` : "";
      const inner: string[] = [];
      const innerMap: number[] = [];
      const height = rewrite(body, 0, inner, innerMap, problems) + 1;
      tallest = Math.max(tallest, height);
      const fence = fenceFor(height);
      emit(`${fence}${type}${title ? `[${title}]` : ""}${attributes}`, sourceLine);
      inner.forEach((text, index) => emit(text, bodySources[innerMap[index]!] ?? sourceLine));
      emit(fence, sourceLine);
      continue;
    }

    emit(line, sourceLine);
    i += 1;
  }
  return tallest;
}

/**
 * Normalize every block spelling in a Markdown source. The result is ordinary Markdown with
 * container directives, which the profile's own parser already understands, plus a map from
 * its lines back to the author's and the list of spellings recognized but refused.
 */
export function normalizeBlockSyntax(source: string): NormalizedSource {
  const lines = source.split("\n");
  const out: string[] = [];
  const map: number[] = [];
  const problems: NormalizationProblem[] = [];
  rewrite(lines, 1, out, map, problems);
  return { text: out.join("\n"), lineMap: map, problems };
}
