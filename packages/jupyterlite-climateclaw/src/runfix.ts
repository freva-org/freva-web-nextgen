// "Run & fix at DKRZ", the pure half: the request, the comparison of what ran with the cell, and
// the outputs written back. It is NOT exact execution - a model reads the cell and calls its code
// interpreter, so it is slower, costs tokens and is not deterministic - and the outputs say where
// they ran.

import { figureMarkdown, savedFigures, type SavedFigure } from "./figures.js";
import { fence, type CodeOutput, type StreamEvent } from "./stream.js";

/** How many runs of the cell (the first, as given, included) ClimateClaw may make. */
export const MAX_ATTEMPTS = 3;

export const RUN_AND_FIX_TEMPLATE =
  "Execute the following Python code with your code interpreter EXACTLY as given. If and only if " +
  "it raises an error, fix the minimal cause, run the fixed version, and state in one line what " +
  `you changed - at most ${MAX_ATTEMPTS} runs in total. If a module it imports is not installed ` +
  "here, do not rewrite the code around it: reply with the one line `MISSING: <module names>` " +
  "and stop. If it still fails after the last run, reply with the one line `GAVE UP: <the reason " +
  "in a few words>`. Do not add explanations otherwise.";

/** The first line of the module check's output, then the missing modules, comma-separated. */
export const MODULE_CHECK_PREFIX = "climateclaw-missing:";

/** Modules every Python has: never checked. */
const STDLIB = new Set(
  (
    "abc argparse array ast asyncio base64 bisect builtins calendar cmath codecs collections " +
    "concurrent contextlib copy csv ctypes dataclasses datetime decimal difflib dis email enum " +
    "errno fnmatch fractions functools gc getpass glob gzip hashlib heapq hmac html http " +
    "importlib inspect io ipaddress itertools json keyword locale logging lzma math mimetypes " +
    "multiprocessing numbers operator os pathlib pickle platform pprint queue random re sched " +
    "secrets select shlex shutil signal site socket sqlite3 statistics string struct subprocess " +
    "sys tarfile tempfile textwrap threading time timeit tokenize traceback types typing " +
    "unicodedata unittest urllib uuid warnings weakref xml zipfile zlib zoneinfo __future__"
  ).split(" "),
);

/**
 * The cell's logical lines that start as code: not inside a string (a triple-quoted one spans
 * lines), comments removed, with their indentation.
 */
function codeLines(source: string): Array<{ indent: number; text: string }> {
  const lines: Array<{ indent: number; text: string }> = [];
  let quote: string | null = null;
  let line = "";
  let starts = true;
  const end = () => {
    if (starts && line.trim()) {
      lines.push({ indent: line.length - line.trimStart().length, text: line.trim() });
    }
    line = "";
  };
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i]!;
    if (quote) {
      if (c === "\\") {
        i += 1;
        continue;
      }
      if (source.startsWith(quote, i)) {
        i += quote.length - 1;
        quote = null;
        line += " ";
      } else if (c === "\n") {
        if (quote.length === 1) quote = null;
        else {
          end();
          starts = false;
        }
      }
      continue;
    }
    if (c === "\n") {
      end();
      starts = true;
    } else if (c === "#") {
      while (i + 1 < source.length && source[i + 1] !== "\n") i += 1;
    } else if (c === '"' || c === "'") {
      quote = source.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
      i += quote.length - 1;
      line += "''";
    } else {
      line += c;
    }
  }
  end();
  return lines;
}

/**
 * The top-level modules a cell needs for certain (not the standard library's), in order: only an
 * import at the cell's top level, which runs whatever happens. One inside a function, a class, an
 * `if`, a `try` or its `except` fallback may never run, so it is not checked (if it does run and
 * its module is missing, the error says so); nor is one in a string or a comment.
 */
export function importedModules(source: string): string[] {
  const found: string[] = [];
  const add = (name: string) => {
    const top = name.trim().split(".")[0] ?? "";
    if (/^[A-Za-z_]\w*$/.test(top) && !STDLIB.has(top) && !found.includes(top)) found.push(top);
  };
  for (const { indent, text } of codeLines(source)) {
    if (indent > 0) continue;
    const from = /^from\s+([A-Za-z_][\w.]*)\s+import\b/.exec(text);
    if (from) {
      add(from[1]!);
      continue;
    }
    const plain = /^import\s+(.+)$/.exec(text);
    if (plain) for (const part of plain[1]!.split(",")) add(part.trim().split(/\s+/)[0] ?? "");
  }
  return found;
}

/** The one-line check run before the cell: which of `modules` are not installed at DKRZ. */
export function moduleCheckCode(modules: readonly string[]): string {
  return (
    `import importlib.util as _u; print(${JSON.stringify(MODULE_CHECK_PREFIX)}, ` +
    `",".join(m for m in ${JSON.stringify(modules)} if _u.find_spec(m) is None))`
  );
}

/** Whether `code` is a module check (`moduleCheckCode`), as ClimateClaw ran it. */
export function isModuleCheck(code: string): boolean {
  return code
    .trim()
    .startsWith(`import importlib.util as _u; print(${JSON.stringify(MODULE_CHECK_PREFIX)}`);
}

/** The missing modules a check printed, or null when `stdout` is not the check's. */
export function parseModuleCheck(stdout: string): string[] | null {
  const line = stdout.split("\n").find((l) => l.startsWith(MODULE_CHECK_PREFIX));
  if (line === undefined) return null;
  return line
    .slice(MODULE_CHECK_PREFIX.length)
    .split(",")
    .map((m) => m.trim())
    .filter((m) => /^[A-Za-z_]\w*$/.test(m));
}

/** A module an error says is not installed (`ModuleNotFoundError`), or null. */
export function missingFromError(error: string): string | null {
  return /ModuleNotFoundError: No module named '([A-Za-z_][\w]*)/.exec(error)?.[1] ?? null;
}

/** What ClimateClaw said in its marker lines (`MISSING:`, `GAVE UP:`). */
export function runVerdict(text: string): { missing?: string[]; gaveUp?: string } {
  const missing = /^\s*MISSING:\s*(.+)$/m.exec(text)?.[1];
  const gaveUp = /^\s*GAVE UP:\s*(.+)$/m.exec(text)?.[1];
  return {
    ...(missing
      ? {
          missing: missing
            .split(/[,\s]+/)
            .map((m) => m.replace(/[`'"]/g, ""))
            .filter((m) => /^[A-Za-z_][\w.]*$/.test(m)),
        }
      : {}),
    ...(gaveUp ? { gaveUp: gaveUp.trim() } : {}),
  };
}

/** Distributions whose name is not their module's. */
const DISTRIBUTIONS: Record<string, string> = {
  cv2: "opencv-python",
  sklearn: "scikit-learn",
  skimage: "scikit-image",
  PIL: "pillow",
  yaml: "pyyaml",
  bs4: "beautifulsoup4",
  dateutil: "python-dateutil",
  netCDF4: "netCDF4",
};

/** The package to install for a module (its usual name on PyPI). */
export function packageFor(module: string): string {
  return DISTRIBUTIONS[module] ?? module.replace(/_/g, "-");
}

/** A cell that installs `modules` into the notebook's own Python (Pyodide, in the browser). */
export function installCellSource(modules: readonly string[]): string {
  return (
    "# Installs what the cell below needs into this notebook's Python, in your browser (Pyodide).\n" +
    "import micropip\n" +
    `await micropip.install(${JSON.stringify(modules.map(packageFor))})`
  );
}

export const RAN_AT_DKRZ = "Ran at DKRZ";

/** Notebook metadata key holding the notebook's Run & fix thread. */
export const METADATA_KEY = "climateclaw";

export function runAndFixInput(source: string, note = "", modules: readonly string[] = []): string {
  const extra = note.trim() ? `\n\nA note from the user about this code:\n${note.trim()}` : "";
  // What it imports is checked first, in one short run, so a missing module is known before the
  // cell runs (and is never "fixed" by rewriting the cell around it).
  const check = modules.length
    ? `\n\nBefore that, run exactly this check once:\n\n${fence(moduleCheckCode(modules), "python")}\n\n` +
      `If it prints any module name after \`${MODULE_CHECK_PREFIX}\`, do not run the code: reply ` +
      "`MISSING: <those names>` and stop."
    : "";
  return `${RUN_AND_FIX_TEMPLATE}${extra}${check}\n\n${fence(source, "python")}`;
}

/**
 * Code compared as code: line endings, trailing blank lines and trailing spaces do not count -
 * except where they are part of the program: at the end of a line inside a string that goes on
 * (a triple-quoted one), and after a backslash (`\ ` is not a line continuation).
 */
export function normalizeCode(code: string): string {
  let open: string | null = null;
  return code
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => {
      open = stringOpenAfter(line, open);
      if (open !== null) return line;
      const trimmed = line.replace(/\s+$/, "");
      return trimmed !== line && trimmed.endsWith("\\") ? line : trimmed;
    })
    .join("\n")
    .replace(/\n+$/, "")
    .replace(/^\n+/, "");
}

/**
 * The quote of a string still open at the end of `line`, given the one open at its start: a
 * triple-quoted string spans lines; a single-quoted one only after a backslash. Comments end the
 * line; a backslash escapes the next character (in raw strings too, for where they end).
 */
function stringOpenAfter(line: string, open: string | null): string | null {
  let quote = open;
  for (let i = 0; i < line.length; ) {
    if (quote) {
      if (line[i] === "\\") i += 2;
      else if (line.startsWith(quote, i)) {
        i += quote.length;
        quote = null;
      } else i += 1;
      continue;
    }
    const c = line[i]!;
    if (c === "#") break;
    if (c === "'" || c === '"') {
      quote = line.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
      i += quote.length;
    } else i += 1;
  }
  if (quote && quote.length === 1) return line.endsWith("\\") ? quote : null;
  return quote;
}

export function fixDiffers(source: string, executed: string | null): boolean {
  return executed !== null && normalizeCode(executed) !== normalizeCode(source);
}

/** A line diff (LCS), `-`/`+`/` ` prefixed. Small inputs only (a cell). */
export function lineDiff(before: string, after: string): string {
  const a = normalizeCode(before).split("\n");
  const b = normalizeCode(after).split("\n");
  if (a.length * b.length > 4_000_000) {
    return [...a.map((l) => `-${l}`), ...b.map((l) => `+${l}`)].join("\n");
  }
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i]![j] =
        a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(` ${a[i]}`);
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      out.push(`-${a[i]}`);
      i += 1;
    } else {
      out.push(`+${b[j]}`);
      j += 1;
    }
  }
  while (i < a.length) out.push(`-${a[i++]}`);
  while (j < b.length) out.push(`+${b[j++]}`);
  return out.join("\n");
}

export type NbOutput =
  | { output_type: "stream"; name: "stdout" | "stderr"; text: string }
  | {
      output_type: "display_data";
      data: Record<string, string>;
      metadata: Record<string, unknown>;
    }
  | { output_type: "error"; ename: string; evalue: string; traceback: string[] };

export function labelOutput(model: string, at: Date = new Date()): NbOutput {
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const by = ["ClimateClaw", model, time].filter(Boolean).join(" · ");
  return {
    output_type: "display_data",
    data: {
      "text/markdown":
        `**Ran at DKRZ** · ${by}  \n` +
        "_Ran in ClimateClaw's Python at DKRZ: what it defines is not in this notebook's kernel._",
      "text/plain": `${RAN_AT_DKRZ} · ${by}`,
    },
    metadata: { climateclaw: { label: true } },
  };
}

function textWithNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

/** A saved figure as a cell output: the image when its bytes are here, else by its address. */
export function savedFigureOutput(
  figure: SavedFigure,
  base64: string | null,
  imageOrigin?: string,
): NbOutput {
  const name = figure.name.split("/").pop() || figure.name;
  return base64
    ? {
        output_type: "display_data",
        data: { [figure.mime]: base64, "text/plain": `<${name}>` },
        metadata: { [METADATA_KEY]: { savedFigure: figure.url } },
      }
    : {
        output_type: "display_data",
        data: {
          "text/markdown": figureMarkdown(figure, null, imageOrigin),
          "text/plain": figure.url,
        },
        metadata: { [METADATA_KEY]: { savedFigure: figure.url } },
      };
}

export function codeOutputToNotebook(output: CodeOutput): NbOutput[] {
  const outputs: NbOutput[] = [];
  if (output.stdout)
    outputs.push({ output_type: "stream", name: "stdout", text: textWithNewline(output.stdout) });
  if (output.stderr)
    outputs.push({ output_type: "stream", name: "stderr", text: textWithNewline(output.stderr) });
  for (const text of [output.result, ...output.display].filter(Boolean)) {
    outputs.push({ output_type: "display_data", data: { "text/plain": text }, metadata: {} });
  }
  if (output.error) {
    outputs.push({
      output_type: "error",
      ename: "Error at DKRZ",
      evalue: output.error.split("\n").filter(Boolean).pop() ?? output.error,
      traceback: output.error.split("\n"),
    });
  }
  return outputs;
}

/** One run of the cell at DKRZ (the first as given, then ClimateClaw's fixes). */
export interface CellRun {
  id: string;
  code: string;
  output: CodeOutput | null;
  /** Its outputs as notebook outputs (a fix's go to the cell it is added as). */
  outputs: NbOutput[];
}

/** The last line of an error, for a one-line summary. */
function lastLine(text: string): string {
  return text.split("\n").filter(Boolean).pop() ?? text;
}

/** A line about a fix attempt, in the cell: a note, not the code's own output. */
function attemptLine(text: string): NbOutput {
  return {
    output_type: "display_data",
    data: {
      "text/markdown": `_${text.replace(/[_*`[\]\\]/g, (c) => `\\${c}`)}_`,
      "text/plain": text,
    },
    metadata: { [METADATA_KEY]: { attempt: true } },
  };
}

/**
 * Folds a Run & fix stream: what goes into the user's cell (the outputs of the cell as written,
 * when its first run is that, then one line per other run), every run with its own outputs (a
 * fix's go with it), the module check's verdict, and the model's text. At most `MAX_ATTEMPTS`
 * runs are taken: a run beyond them is not one (`overLimit`; the caller stops the stream).
 */
export class RunAndFixCollector {
  /** Into the user's cell, as they come. */
  readonly outputs: NbOutput[] = [];
  /** Every run of the cell, in order (the module check is not one). */
  readonly runs: CellRun[] = [];
  executed: string | null = null;
  note = "";
  threadId: string | null = null;
  ended = false;
  /** The stream reported an error (server or model). */
  failed = false;
  /** Figures the code saved to files, not yet shown (the caller fetches them), by run. */
  readonly figures: Array<SavedFigure & { run: number }> = [];
  /** What the module check found missing at DKRZ; null when no check ran. */
  missing: string[] | null = null;
  /** ClimateClaw ran code beyond `MAX_ATTEMPTS` runs: that run, and any after it, is not taken. */
  overLimit = false;
  readonly #checks = new Set<string>();
  /** Runs past the limit: their outputs go nowhere. */
  readonly #ignored = new Set<string>();
  readonly #check: string | null;
  readonly #source: string | null;

  /**
   * `check`: the module check's code, recognised so its output never reaches the cell. `source`:
   * the cell as written - only a run of exactly that puts its outputs into the cell.
   */
  constructor(check: string | null = null, source: string | null = null) {
    this.#check = check ? normalizeCode(check) : null;
    this.#source = source;
  }

  /** Whether run `at` is the cell as written (its outputs are the cell's). */
  #isCell(at: number): boolean {
    if (at < 0) return true;
    if (at > 0) return false;
    return this.#source === null || !fixDiffers(this.#source, this.runs[0]!.code);
  }

  #isIgnored(id: string): boolean {
    return [...this.#ignored].some((ignored) => id === ignored || id.startsWith(`${ignored}_`));
  }

  /** The run an event belongs to (a figure's id extends its code's). */
  #runOf(id: string): number {
    let at = this.runs.findIndex((r) => r.id === id);
    if (at < 0) {
      at = this.runs.reduce(
        (best, r, i) =>
          id.startsWith(r.id) && (best < 0 || r.id.length > this.runs[best]!.id.length) ? i : best,
        -1,
      );
    }
    return at < 0 ? this.runs.length - 1 : at;
  }

  /** An output of run `at`: kept with its run, and in the cell when the run is the cell's. */
  #emit(at: number, outputs: NbOutput[]): void {
    this.runs[at]?.outputs.push(...outputs);
    if (this.#isCell(at)) this.outputs.push(...outputs);
  }

  /** A figure's output, once fetched, where it belongs (see `figures`). */
  addFigure(run: number, output: NbOutput): void {
    this.#emit(run, [output]);
  }

  add(events: StreamEvent[]): void {
    for (const event of events) {
      switch (event.type) {
        case "code": {
          if (this.#check && normalizeCode(event.code) === this.#check) {
            this.#checks.add(event.id);
            break;
          }
          if (this.runs.length >= MAX_ATTEMPTS) {
            this.#ignored.add(event.id);
            if (!this.overLimit) {
              this.overLimit = true;
              this.outputs.push(
                attemptLine(
                  `ClimateClaw started a run beyond the ${MAX_ATTEMPTS} allowed: it is not used, and nothing more is read.`,
                ),
              );
            }
            break;
          }
          this.executed = event.code;
          this.runs.push({ id: event.id, code: event.code, output: null, outputs: [] });
          const n = this.runs.length;
          if (!this.#isCell(n - 1)) {
            this.outputs.push(
              attemptLine(
                n === 1
                  ? `ClimateClaw ran a changed version of the cell (run 1 of at most ${MAX_ATTEMPTS})…`
                  : `ClimateClaw is trying a fix (run ${n} of at most ${MAX_ATTEMPTS})…`,
              ),
            );
          }
          break;
        }
        case "output": {
          if (this.#checks.has(event.id)) {
            this.missing = parseModuleCheck(event.output.stdout) ?? [];
            break;
          }
          if (this.#isIgnored(event.id)) break;
          const at = this.#runOf(event.id);
          const run = this.runs[at];
          if (run && run.output === null) run.output = event.output;
          this.figures.push(...savedFigures(event.output).map((f) => ({ ...f, run: at })));
          const outputs = codeOutputToNotebook(event.output);
          run?.outputs.push(...outputs);
          if (this.#isCell(at)) {
            this.outputs.push(...outputs);
            break;
          }
          const failed = event.output.outcome === "error" || !!event.output.error;
          this.outputs.push(
            attemptLine(
              failed
                ? `Run ${at + 1} failed: ${lastLine(event.output.error)}`
                : `Run ${at + 1} ran without an error.`,
            ),
          );
          break;
        }
        case "image":
          if (this.#isIgnored(event.id)) break;
          if (event.mime === "image/png" || event.mime === "image/jpeg") {
            this.#emit(this.#runOf(event.id), [
              {
                output_type: "display_data",
                data: { [event.mime]: event.base64, "text/plain": "<Figure>" },
                metadata: {},
              },
            ]);
          }
          break;
        case "error":
          this.failed = true;
          this.outputs.push({
            output_type: "error",
            ename: "ClimateClawError",
            evalue: event.message,
            traceback: [event.message],
          });
          break;
        case "thread":
          this.threadId = event.threadId;
          break;
        case "end":
          this.ended = true;
          break;
        default:
          break;
      }
    }
  }

  /** Assistant text, collected separately (the one-line note on what was changed). */
  addText(text: string): void {
    this.note += text;
  }

  /** The model's note without its marker lines. */
  get summary(): string {
    return this.note.replace(/^\s*(MISSING|GAVE UP):.*$/gm, "").trim();
  }
}
