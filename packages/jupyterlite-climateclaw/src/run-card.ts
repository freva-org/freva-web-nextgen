// A run of code at DKRZ, in the chat, as one card: a line that says where it ran (and which cell,
// a click away), how it ended and whether it drew figures; the line opens to the code. Its output,
// error and figures always show below: Hide code folds the code only. Markdown with HTML the
// chat's sanitiser keeps (`div`, `details`, `summary`, classes, titles), so it is the same in
// ClimateClaw's panel, in jupyterlite-ai's, in a saved chat and in a conversation reopened from
// the history.
//
// A card is written once its run is over (the next text, the next code, or the end of the reply):
// the chat's text only grows, so a card cannot be changed once shown. While the code runs, the
// reply's activity line says so.

import { figureMarkdown, type SavedFigure } from "./figures.js";
import { cellPointer, chipText, outcomeChip } from "./notebook-sink.js";
import { isModuleCheck } from "./runfix.js";
import { fence, type CodeOutput } from "./stream.js";

/** Which notebook cell a run went to. */
export interface RunPointer {
  number: number | null;
  notebook: string | null;
  cellId?: string;
  model?: string;
}

interface Run {
  id: string;
  code: string;
  pointer: RunPointer | null;
  output: CodeOutput | null;
  images: Array<{ mime: string; base64: string }>;
  figures: Array<{ figure: SavedFigure; base64: string | null }>;
}

export interface RunCardOptions {
  /** The code shown, or folded under the card's line (its outputs show either way). */
  open: boolean;
  /** Where saved figures may be shown from (see `figureMarkdown`). */
  imageOrigin?: string;
}

/** Output lines kept in the card; the rest is in the cell. */
const MAX_LINES = 40;
const MAX_CHARS = 6_000;
/** A streamed figure larger than this is left in its cell. */
const MAX_IMAGE_BASE64 = 1_500_000;

export const RUN_CLASS = "jp-ClimateClaw-run";
/** The card's line and its code, which Hide code folds. */
export const CODE_CLASS = "jp-ClimateClaw-runCode";
/** A part of what the run gave: shown, folded by a click on its header (Hide code leaves it). */
export const PART_CLASS = "jp-ClimateClaw-runPart";

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** At most `MAX_LINES` lines (the last ones for a traceback), and what was left out. */
function clip(text: string, keepEnd = false): string {
  const clean = text.replace(ANSI, "").replace(/\n+$/, "");
  const lines = clean.split("\n");
  let kept = keepEnd ? lines.slice(-MAX_LINES) : lines.slice(0, MAX_LINES);
  let joined = kept.join("\n");
  if (joined.length > MAX_CHARS) {
    joined = keepEnd ? joined.slice(-MAX_CHARS) : joined.slice(0, MAX_CHARS);
    kept = joined.split("\n");
  }
  const left = lines.length - kept.length;
  if (left <= 0 && joined.length === clean.length) return joined;
  const more = left > 0 ? `${left} more line${left === 1 ? "" : "s"}` : "more";
  return keepEnd ? `… ${more} above\n${joined}` : `${joined}\n… ${more}`;
}

/** A part of a run's result (Output, stderr, Error, Files, Figures): open, its header folds it. */
function part(label: string, bodies: string[], error = false): string {
  const mod = error ? " jp-mod-error" : "";
  return (
    `<details class="${PART_CLASS}${mod}" open>` +
    `<summary class="jp-ClimateClaw-runSection${mod}">${label}</summary>\n\n` +
    `${bodies.join("\n\n")}\n\n</details>`
  );
}

/** The card for one run. */
export function runCard(run: Run, options: RunCardOptions): string {
  const output = run.output;
  const failed = output?.outcome === "error" || !!output?.error;
  const pointer = run.pointer
    ? cellPointer(
        run.pointer.number,
        run.pointer.notebook,
        run.pointer.model ?? "",
        run.pointer.cellId ?? "",
      ).trim()
    : `<span class="jp-ClimateClaw-ran" title="Ran at DKRZ by ClimateClaw, not in this notebook's kernel."><span class="jp-ClimateClaw-ran-at">DKRZ</span></span>`;
  const outcome = output
    ? outcomeChip(output)
    : ' <span class="jp-ClimateClaw-outcome" title="No output was reported">no output</span>';
  const pictures = run.images.length + run.figures.length;
  const figureChip = pictures
    ? ` <span class="jp-ClimateClaw-outcome jp-mod-figure" title="Its figures are below, and in the cell">◩ ${pictures === 1 ? "figure" : `${pictures} figures`}</span>`
    : "";
  const where = run.pointer?.number ? "in the cell" : "in the full output";
  const head = `${pointer}${outcome}${figureChip}`;
  const parts: string[] = [];
  if (output) {
    const out = [output.stdout, output.result, ...output.display]
      .map((s) => s.replace(/\n+$/, ""))
      .filter(Boolean)
      .join("\n");
    if (out) parts.push(part("Output", [fence(clip(out), "text")]));
    if (output.stderr.trim()) parts.push(part("stderr", [fence(clip(output.stderr), "text")]));
    if (output.error.trim()) {
      parts.push(part("Error", [fence(clip(output.error, true), "text")], true));
    }
    const files = output.files.filter(
      (f) => !run.figures.some(({ figure }) => figure.name === f.name),
    );
    if (files.length) {
      parts.push(
        part("Files", [
          files
            .map((f) => (f.url ? `- [${chipText(f.name)}](${f.url})` : `- \`${f.name}\``))
            .join("\n"),
        ]),
      );
    }
  }
  if (pictures) {
    parts.push(
      part("Figures", [
        ...run.images.map((image) =>
          image.base64.length <= MAX_IMAGE_BASE64
            ? `![Figure](data:${image.mime};base64,${image.base64})`
            : `_A figure too large to repeat here; it is ${where}._`,
        ),
        ...run.figures.map(({ figure, base64 }) =>
          figureMarkdown(
            figure,
            base64 && base64.length <= MAX_IMAGE_BASE64 ? base64 : null,
            options.imageOrigin,
          ),
        ),
      ]),
    );
  }
  // The line, folding the code; then what the run gave, always shown.
  const code = run.code.trim()
    ? `<details class="${CODE_CLASS}"${options.open ? " open" : ""}>` +
      `<summary class="jp-ClimateClaw-runHead">${head}` +
      `<span class="jp-ClimateClaw-runToggle" title="Show or hide this run's code">Code</span>` +
      `</summary>\n\n${fence(run.code.replace(/\n+$/, ""), "python")}\n\n</details>`
    : `<div class="jp-ClimateClaw-runHead">${head}</div>`;
  return (
    `\n\n<div class="${RUN_CLASS}${failed ? " jp-mod-error" : ""}">${code}\n\n` +
    `${parts.map((part) => `${part}\n\n`).join("")}</div>\n\n`
  );
}

/**
 * Collects the runs of one reply in stream order and writes their cards when asked (`flush`). A
 * figure's id extends its code's (`call_1` -> `call_1_0`).
 */
export class RunCards {
  readonly #runs: Run[] = [];

  constructor(private readonly options: RunCardOptions) {}

  get pending(): boolean {
    return this.#runs.length > 0;
  }

  /** The code of run `id` (again, as it grows), and its cell. */
  code(id: string, code: string, pointer?: RunPointer | null): void {
    const run = this.#run(id, true);
    run.code = code;
    if (pointer) run.pointer = pointer;
  }

  output(id: string, output: CodeOutput): void {
    this.#run(id).output = output;
  }

  image(id: string, mime: string, base64: string): void {
    this.#run(id).images.push({ mime, base64 });
  }

  figure(id: string, figure: SavedFigure, base64: string | null): void {
    this.#run(id).figures.push({ figure, base64 });
  }

  /** Whether `id` starts a run other than the ones waiting (so they are over). */
  isNew(id: string): boolean {
    return !this.#runs.some((run) => run.id === id);
  }

  /** The cards of the runs collected so far, which are then written. */
  flush(): string {
    // Run at DKRZ's import check is ClimateClaw's own step, not a run of the user's code.
    const cards = this.#runs
      .filter((run) => !isModuleCheck(run.code))
      .map((run) => runCard(run, this.options))
      .join("");
    this.#runs.length = 0;
    return cards;
  }

  #run(id: string, exact = false): Run {
    let run = this.#runs.find((r) => r.id === id);
    if (!run && !exact) {
      run = [...this.#runs]
        .filter((r) => id.startsWith(r.id))
        .sort((a, b) => b.id.length - a.id.length)[0];
      // A part of a run already written (or of none): a card of its own.
      run ??= this.#runs.at(-1);
    }
    if (!run) {
      run = { id, code: "", pointer: null, output: null, images: [], figures: [] };
      this.#runs.push(run);
    }
    return run;
  }
}
