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
/**
 * Material for MkDocs' card grid: `<div class="grid cards" markdown>` on a line of its own,
 * closed by a line of `</div>`. Raw HTML is otherwise refused, and this is not an exception to
 * that: the line is recognized as a block spelling, like `!!!`, and never reaches the parser as
 * HTML. Captured loosely - class list and attributes - so a near miss can be named precisely.
 */
const MATERIAL_DIV =
  /^(\s*)<div\s+class\s*=\s*"([^"]*)"((?:\s+[A-Za-z-]+(?:\s*=\s*"[^"]*")?)*)\s*>\s*$/;

/** How the card grid is spelled, from the profile. */
export interface CardGridSpelling {
  directive: string;
  materialClassLists: string[];
  materialMarkdownAttribute: string[];
  columns: number[];
  columnsAttribute: string;
  materialColumnsClassPrefix: string;
}

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

/** The column a line's content starts at, a tab advancing to the next multiple of four. */
function columnOf(line: string): number {
  let column = 0;
  for (const c of line) {
    if (c === " ") column += 1;
    else if (c === "\t") column += 4 - (column % 4);
    else break;
  }
  return column;
}

/** A list item marker, the whitespace in front of it and the whitespace after it. */
const LIST_MARKER = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]*)(.*)$/;

/**
 * Where indented code is. CommonMark makes it depend on context: an indented code block begins
 * four columns past the content of the list item it sits in (or past the enclosing block,
 * outside any item), and only where a paragraph is not open - after a blank line, a closed
 * fence, a heading or another block that cannot be continued. Following list items and open
 * paragraphs is enough to read a card's or a list item's own example the way the Markdown
 * parser will read it, so a `</div>`, `!!! note` or `/// caption` shown in one is left alone.
 *
 * Feed it every line of a block in order; lines another scan consumes as a whole (a fence and
 * its contents, a rewritten block) are reported with `closeBlock()` instead.
 */
class IndentedCode {
  /** Content columns of the list items the scan is inside, innermost last. */
  private readonly items: number[] = [];
  private paragraph = false;
  private afterBlank = true;
  private codeFrom: number | undefined;

  constructor(private readonly base = 0) {}

  private contentColumn(): number {
    return this.items[this.items.length - 1] ?? this.base;
  }

  /** Whether `line` is part of an indented code block. Blank lines are never reported as code. */
  isCode(line: string): boolean {
    if (line.trim() === "") {
      this.paragraph = false;
      this.afterBlank = true;
      return false;
    }
    const column = columnOf(line);
    const blank = this.afterBlank;
    this.afterBlank = false;
    // Still inside an indented code block: blank lines were passed over above, and any line at
    // least as deep as the block's own indentation is more of it.
    if (this.codeFrom !== undefined) {
      if (column >= this.codeFrom) return true;
      this.codeFrom = undefined;
    }
    // Leaving list items: after a blank line, a line shallower than an item's content is no
    // longer part of it. Without the blank line it is a lazy paragraph continuation instead.
    if (blank || !this.paragraph) this.leave(column);
    // An indented code block opens only where no paragraph can be continued.
    if (!this.paragraph && column >= this.contentColumn() + 4) {
      this.codeFrom = this.contentColumn() + 4;
      return true;
    }
    const marker = LIST_MARKER.exec(line);
    if (marker && (marker[3] !== "" || marker[4] === "")) {
      this.leave(column);
      const lead = columnOf(marker[1]!) + marker[2]!.length;
      const gap = columnOf(`${" ".repeat(lead)}${marker[3]!}`) - lead;
      // Five or more spaces after the marker make the item start with indented code, and its
      // content column one past the marker; an empty item's content column is also one past.
      const opensCode = marker[4] !== "" && gap >= 5;
      this.items.push(lead + (marker[4] === "" || opensCode ? 1 : gap));
      this.paragraph = !opensCode && marker[4] !== "";
      if (opensCode) this.codeFrom = this.contentColumn() + 4;
      return false;
    }
    // A heading or a thematic break is a whole block; anything else opens or continues a
    // paragraph (or an HTML block, which a blank line ends just the same).
    this.paragraph = !/^(#{1,6}(\s|$)|([-*_])(\s*\3){2,}\s*$)/.test(line.trim());
    return false;
  }

  /** The line just fed opened a block no paragraph continues: a fence, a directive. */
  closeBlock(): void {
    this.paragraph = false;
  }

  private leave(column: number): void {
    while (this.items.length > 0 && column < this.items[this.items.length - 1]!) this.items.pop();
  }
}

/**
 * The closing-tag test for a Material `<div … markdown>` whose opener sits at column `base`.
 * The body runs to the `</div>` that closes THIS div: nested `<div … markdown>` blocks are
 * counted rather than taken for the end of the grid, and nothing inside code - fenced or
 * indented - counts at all: a card that SHOWS an HTML example, `</div>` and all, must not end
 * the grid in the middle of it.
 */
function materialGridCloser(base: number): (line: string) => boolean {
  let depth = 0;
  let fence: string | undefined;
  const code = new IndentedCode(base);
  return (line) => {
    const trimmed = line.trim();
    if (fence !== undefined) {
      // CommonMark: the same character, at least as many of it, and nothing after.
      const closer = /^(`{3,}|~{3,})\s*$/.exec(trimmed);
      if (closer && closer[1]![0] === fence[0] && closer[1]!.length >= fence.length) {
        fence = undefined;
      }
      return false;
    }
    if (code.isCode(line)) return false;
    // A fence opens on its own line or as the first line of a list item.
    const opener = FENCE.exec(line) ?? FENCE.exec(line.replace(LIST_ITEM, ""));
    if (opener) {
      fence = opener[2]!;
      code.closeBlock();
      return false;
    }
    if (/^<div\b/i.test(trimmed)) depth += 1;
    if (trimmed === "</div>") {
      if (depth === 0) return true;
      depth -= 1;
    }
    return false;
  };
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
  cards?: CardGridSpelling,
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
    const height = rewrite(body, 0, inner, innerMap, problems, cards) + 1;
    tallest = Math.max(tallest, height);
    const fence = fenceFor(height);
    const at = (text: string): string => (text === "" ? "" : `${indent}${text}`);
    emit(at(opener(fence)), sourceLine);
    inner.forEach((text, index) => emit(at(text), bodySources[innerMap[index]!] ?? sourceLine));
    emit(at(fence), sourceLine);
  };

  // Indented code is copied through untouched, like fenced code: a `/// caption`, `!!! note` or
  // `<div class="grid cards" markdown>` shown as an example is the example, not a block.
  const code = new IndentedCode();
  // Whether the previous line opened a block that some branch below consumed whole: nothing
  // after such a block continues a paragraph, so indented code may begin right after it.
  let blockEnded = false;

  while (i < lines.length) {
    const line = lines[i]!;
    const sourceLine = sourceStart + i;

    if (blockEnded) code.closeBlock();
    blockEnded = false;
    // Blank lines are fed too: they are what lets indented code begin and a list item end.
    if (code.isCode(line) || isBlank(line)) {
      emit(line, sourceLine);
      i += 1;
      continue;
    }
    // Every branch below that does not fall through to the end consumes a block.
    blockEnded = true;

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
        const height = rewrite(colonForm, 0, inner, innerMap, problems, cards);
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

    // Material's card grid. Only a `<div>` with the `markdown` attribute is a block spelling at
    // all (without it Material treats the contents as HTML), and only the `grid cards` class list
    // is accepted. Anything else meets the raw-HTML refusal (PC1002).
    const material = cards ? MATERIAL_DIV.exec(line) : null;
    if (material && cards) {
      const indent = material[1]!;
      const classes = material[2]!.trim().split(/\s+/).join(" ");
      const attributes = material[3]!.trim().split(/\s+/).filter(Boolean);
      const markdown = attributes.some((a) => cards.materialMarkdownAttribute.includes(a));
      if (markdown) {
        const taken = takeUntil(lines, i + 1, indent, materialGridCloser(columnOf(indent)));
        const bodySources = taken.body.map((_, index) => sourceStart + i + 1 + index);
        const at = sourceLine;
        const next = taken.next;
        // A `cols-N` class is the column hint, and is taken out before the class list is
        // compared: `grid cards cols-2` is the grid with a hint, not a different class list.
        const prefix = cards.materialColumnsClassPrefix;
        const hints = classes.split(" ").filter((c) => c.startsWith(prefix));
        const gridClasses = classes
          .split(" ")
          .filter((c) => !c.startsWith(prefix))
          .join(" ");
        if (!cards.materialClassLists.includes(gridClasses)) {
          refuse(
            at,
            "PC1023",
            `\`<div class="${classes}" markdown>\` is not part of portal-content-v1.`,
            'The card grid is `<div class="grid cards" markdown>`, or `:::cards` around a list.',
          );
          i = next;
          continue;
        }
        const allowed = cards.columns.map((n) => `${prefix}${n}`);
        if (hints.length > 1 || (hints.length === 1 && !allowed.includes(hints[0]!))) {
          refuse(
            at,
            "PC1023",
            `\`${hints.join(" ")}\` is not a column hint this grid accepts.`,
            `A card grid takes at most one of ${allowed.map((c) => `\`${c}\``).join(", ")}.`,
          );
          i = next;
          continue;
        }
        const columns = hints.length === 1 ? hints[0]!.slice(prefix.length) : undefined;
        if (!taken.closed) {
          refuse(at, "PC1023", "This card grid is never closed.", "Close it with `</div>`.");
          i = next;
          continue;
        }
        trimBlank(taken.body, bodySources);
        emit("", sourceLine);
        emitBlock(
          (fence) =>
            `${fence}${cards.directive}${columns ? `{${cards.columnsAttribute}=${columns}}` : ""}`,
          taken.body,
          bodySources,
          sourceLine,
          indent,
        );
        i = next;
        continue;
      }
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
      const height = rewrite(body, 0, inner, innerMap, problems, cards) + 1;
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
      const innerHeight = rewrite(inner, 0, nested, nestedMap, problems, cards);
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
      const height = rewrite(body, 0, inner, innerMap, problems, cards) + 1;
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
      const height = rewrite(body, 0, inner, innerMap, problems, cards) + 1;
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
      const height = rewrite(body, 0, inner, innerMap, problems, cards) + 1;
      tallest = Math.max(tallest, height);
      const fence = fenceFor(height);
      emit(`${fence}${type}${title ? `[${title}]` : ""}${attributes}`, sourceLine);
      inner.forEach((text, index) => emit(text, bodySources[innerMap[index]!] ?? sourceLine));
      emit(fence, sourceLine);
      continue;
    }

    blockEnded = false;
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
export function normalizeBlockSyntax(source: string, cards?: CardGridSpelling): NormalizedSource {
  const lines = source.split("\n");
  const out: string[] = [];
  const map: number[] = [];
  const problems: NormalizationProblem[] = [];
  rewrite(lines, 1, out, map, problems, cards);
  return { text: out.join("\n"), lineMap: map, problems };
}
