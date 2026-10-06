// Code ClimateClaw runs, written into the conversation's own notebook (one per thread, see
// thread-notebooks.ts): each run becomes a new code cell at its end, typed out while its code
// still streams, then its output and figures, labelled as having run at DKRZ - not in this
// notebook's kernel. The chat shows the run as a card (see run-card.ts) - where it ran, which
// cell, how it ended - and the jump to the cell.

import type { JupyterFrontEnd } from "@jupyterlab/application";
import type { ICodeCellModel } from "@jupyterlab/cells";
import type { NotebookPanel } from "@jupyterlab/notebook";

import type { DkrzCell } from "./activity.js";
import type { CodeSink } from "./model.js";
import type { RunPointer } from "./run-card.js";
import {
  codeOutputToNotebook,
  labelOutput,
  METADATA_KEY,
  savedFigureOutput,
  type NbOutput,
} from "./runfix.js";
import { fence, type CodeOutput } from "./stream.js";
import type { ThreadNotebooks } from "./thread-notebooks.js";
import { Typist } from "./typist.js";

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
  // Markdown still reads the text between inline HTML tags.
  _: "&#95;",
  "*": "&#42;",
  "`": "&#96;",
  "[": "&#91;",
  "]": "&#93;",
  "\\": "&#92;",
  "~": "&#126;",
};

/** Text for the chips' HTML: neither markup nor Markdown. */
export function chipText(text: string): string {
  return text.replace(/[&<>"'_*`[\]\\~]/g, (c) => ESCAPES[c]!);
}

export const CELL_CLASS_PREFIX = "jp-ClimateClaw-cell-";

/** The cell id a chip names (in a class: the chat's sanitiser keeps classes), or null. */
export function chipCellId(classes: Iterable<string>): string | null {
  for (const name of classes) {
    if (name.startsWith(CELL_CLASS_PREFIX)) return name.slice(CELL_CLASS_PREFIX.length) || null;
  }
  return null;
}

/**
 * The chat's chip for code that went to a notebook cell: where it ran, the cell, the notebook.
 * Inline HTML (classes and a title are what the chat's sanitiser keeps), so the outcome can
 * follow on the same line.
 */
export function cellPointer(
  number: number | null,
  notebook: string | null,
  model = "",
  cellId = "",
): string {
  const known = number !== null && !!notebook;
  const name = notebook?.split("/").pop() ?? "";
  const title =
    `Ran at DKRZ by ClimateClaw${model ? ` (${model})` : ""}, not in this notebook's kernel.` +
    (known
      ? ` Cell ${number} of ${notebook}. Click to go there.`
      : number !== null
        ? ` Cell ${number} of this conversation's notebook. Click to go there.`
        : "");
  const id = /^[A-Za-z0-9_-]{1,64}$/.test(cellId) ? ` ${CELL_CLASS_PREFIX}${cellId}` : "";
  return (
    `\n\n<span class="jp-ClimateClaw-ran${id}" title="${chipText(title)}">` +
    `<span class="jp-ClimateClaw-ran-at">DKRZ</span> ` +
    `<span class="jp-ClimateClaw-ran-cell">${number !== null ? `Cell ${number}` : "Chat notebook"}</span>` +
    (known ? ` <span class="jp-ClimateClaw-ran-nb">${chipText(name)}</span>` : "") +
    `</span>`
  );
}

/** The chip for how a run ended: its error's name, or that it ran (and showed something). */
export function outcomeChip(output: CodeOutput): string {
  if (output.outcome === "error") {
    const last = output.error.trim().split("\n").filter(Boolean).at(-1) ?? "";
    const name = /^([A-Za-z_][\w.]*)(?::|$)/.exec(last)?.[1] ?? "Error";
    const title = chipText(last.slice(0, 300) || "The run failed");
    return (
      ` <span class="jp-ClimateClaw-outcome jp-mod-error" title="${title}">` +
      `✗ ${chipText(name.slice(0, 40))}</span>`
    );
  }
  const shown = [output.stdout, output.result, ...output.display].some((s) => s.trim());
  const ok = output.outcome === "ok";
  const title = `${ok ? "It ran without an error" : "It ran"}${shown ? "; its output is in the cell" : ""}`;
  return (
    ` <span class="jp-ClimateClaw-outcome${ok ? " jp-mod-ok" : ""}" title="${title}">` +
    `${ok ? "✓ ran" : "ran"}${shown ? " · output" : ""}</span>`
  );
}

/** The parts of a cell's shared model typing uses. */
export interface TypedSource {
  getSource(): string;
  setSource(value: string): void;
  updateSource(start: number, end: number, value: string): void;
}

/**
 * Types into a cell only while it holds exactly what was typed: once someone edits it, an offset
 * from the typist is stale and would land in the middle of their edit, so typing stops there for
 * good (`onEdited` is told once) and the edit is kept.
 */
export function guardedWriter(
  source: TypedSource,
  onEdited: () => void,
): (text: string, from: number | null) => void {
  let written = source.getSource();
  let stopped = false;
  return (text, from) => {
    if (stopped) return;
    const now = source.getSource();
    if (now !== written) {
      stopped = true;
      onEdited();
      return;
    }
    if (from === null || from !== now.length) source.setSource(text);
    else source.updateSource(from, from, text.slice(from));
    written = text;
  };
}

/** A new cell id (nbformat 4.5: letters, digits, `-` and `_`). */
function newCellId(): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : [...crypto.getRandomValues(new Uint8Array(16))]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

export interface SinkTarget {
  notebooks: ThreadNotebooks;
  thread: string;
  /** The name a new notebook takes (the chat's, as far as it is known). */
  title: string;
}

export function createNotebookSink(
  app: JupyterFrontEnd,
  binding: SinkTarget,
  model: string,
  onCell: (thread: string, cell: DkrzCell) => void = () => undefined,
  /** Where the page may show saved figures from (see `figureMarkdown`). */
  imageOrigin?: string,
): CodeSink {
  let panel: NotebookPanel | null = binding.notebooks.openFor(binding.thread);
  // Cells are added in stream order; each step waits for the one before (a new notebook first).
  let queue: Promise<unknown> = Promise.resolve();
  const cells = new Map<string, ICodeCellModel>();
  const typists = new Map<string, Typist>();
  /** Code ids whose cell was edited while its code was typed: typing stopped there. */
  const edited = new Set<string>();
  /** Of those, the ones whose code as run was shown under the cell. */
  const shownAsRun = new Set<string>();
  let last: ICodeCellModel | null = null;
  let planned = 0;
  let base = 0;

  const ready = async (): Promise<NotebookPanel | null> => {
    if (panel && !panel.isDisposed) return panel;
    // The thread's own notebook, reopened or made (on the default kernel, without a chooser).
    panel = await binding.notebooks.ensure(binding.thread, binding.title);
    return panel;
  };
  const then = (step: () => Promise<void> | void) => {
    queue = queue.then(step).catch((error) => console.warn("ClimateClaw: notebook cell", error));
  };
  const cellFor = (id: string): ICodeCellModel | null => {
    if (cells.has(id)) return cells.get(id)!;
    // A figure's id extends its code's (`call_1` -> `call_1_0`).
    let best: string | null = null;
    for (const key of cells.keys()) {
      if (id.startsWith(key) && (!best || key.length > best.length)) best = key;
    }
    return best ? cells.get(best)! : last;
  };
  /** The code ClimateClaw ran, under a cell edited while it was typed (once per code). */
  const codeAsRun = (id: string): NbOutput[] => {
    const key =
      [...typists.keys()]
        .filter((k) => id.startsWith(k))
        .sort()
        .at(-1) ?? id;
    const typist = typists.get(key);
    if (!edited.has(key) || shownAsRun.has(key) || !typist) return [];
    shownAsRun.add(key);
    const code = typist.target;
    return [
      {
        output_type: "display_data",
        data: {
          "text/markdown": `_The cell was edited while ClimateClaw typed it; your edit is kept. The code that ran at DKRZ:_\n\n${fence(code, "python")}`,
          "text/plain": code,
        },
        metadata: { [METADATA_KEY]: { codeAsRun: true } },
      },
    ];
  };
  /**
   * Outputs for a cell, made once its code is whole: the flush is what finds an edit made while
   * the code was typed, so what says which code ran is decided after it, never before.
   */
  const add = (id: string, outputs: () => NbOutput[]) =>
    then(() => {
      const cell = cellFor(id);
      // The code is whole above its output.
      for (const [key, typist] of typists) if (cells.get(key) === cell) typist.flush();
      for (const output of outputs()) cell?.outputs.add(output as never);
    });

  /** The jump to a cell this sink wrote, wherever it is now in its notebook. */
  const jumpTo = (target: NotebookPanel, cell: ICodeCellModel) => () => {
    if (target.isDisposed) return;
    const all = target.content.model?.cells;
    if (!all) return;
    for (let i = 0; i < all.length; i += 1) {
      if (all.get(i) !== cell) continue;
      app.shell.activateById(target.id);
      target.content.activeCellIndex = i;
      target.content.mode = "command";
      void target.content.scrollToItem?.(i, "center").catch(() => undefined);
      return;
    }
  };

  /** A new cell for `id`: placed now (its number known at once), created in stream order. */
  const start = (id: string, typist: Typist): RunPointer => {
    if (!panel || panel.isDisposed) panel = binding.notebooks.openFor(binding.thread);
    const open = panel && !panel.isDisposed ? panel : null;
    const cellId = newCellId();
    const notebook = open?.content.model ?? null;
    if (planned === 0 && notebook) {
      // An untouched new notebook's one empty cell is used, not kept above the code.
      const first = notebook.cells.get(0);
      const empty =
        notebook.cells.length === 1 && first?.type === "code" && !first.sharedModel.getSource();
      base = empty ? 0 : notebook.cells.length;
    }
    planned += 1;
    typists.set(id, typist);
    then(async () => {
      const target = await ready();
      const notebook = target?.content.model;
      if (!target || !notebook) return;
      const shared = notebook.sharedModel;
      const first = notebook.cells.get(0);
      const reuse =
        notebook.cells.length === 1 &&
        first?.type === "code" &&
        first.sharedModel.getSource() === "" &&
        !cells.size;
      const index = reuse ? 0 : notebook.cells.length;
      if (reuse) shared.deleteCell(0);
      shared.insertCell(index, {
        id: cellId,
        cell_type: "code",
        source: "",
        metadata: { [METADATA_KEY]: { ranAtDkrz: true } },
      });
      const cell = notebook.cells.get(index) as ICodeCellModel;
      cell.outputs.add(labelOutput(model) as never);
      cells.set(id, cell);
      last = cell;
      void target.content.scrollToItem?.(index).catch(() => undefined);
      typist.attach(guardedWriter(cell.sharedModel, () => edited.add(id)));
      onCell(binding.thread, {
        notebook: target.context.localPath,
        number: index + 1,
        jump: jumpTo(target, cell),
      });
    });
    // A notebook not open yet: a new one (the thread has none) starts at cell 1.
    const fresh = !open && !binding.notebooks.pathOf(binding.thread);
    return {
      number: open ? base + planned : fresh ? planned : null,
      notebook: open?.context.localPath ?? null,
      model,
      cellId,
    };
  };

  return {
    partial(id, code) {
      const typist = typists.get(id);
      if (typist) {
        typist.update(code);
        return null;
      }
      const fresh = new Typist();
      fresh.update(code);
      return start(id, fresh);
    },
    code(id, code) {
      const typist = typists.get(id);
      if (typist) {
        typist.update(code, true);
        return null;
      }
      const fresh = new Typist();
      fresh.update(code, true);
      return start(id, fresh);
    },
    output(id, output: CodeOutput) {
      add(id, () => [...codeAsRun(id), ...codeOutputToNotebook(output)]);
    },
    savedFigure(id, figure, base64) {
      add(id, () => [savedFigureOutput(figure, base64, imageOrigin)]);
    },
    follow(thread) {
      const previous = binding.thread;
      binding.thread = thread;
      binding.notebooks.rebind(previous, thread);
    },
    image(id, mime, base64) {
      if (mime !== "image/png" && mime !== "image/jpeg") return;
      add(id, () => [
        {
          output_type: "display_data",
          data: { [mime]: base64, "text/plain": "<Figure>" },
          metadata: {},
        },
      ]);
    },
  };
}
