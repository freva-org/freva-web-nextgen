/**
 * Notebook context for a ClimateClaw message, as @jupyter/chat attachments: the chips above the
 * input, which jupyterlite-ai's persona turns into the cells' source and outputs when it sends.
 * "Follow the active cell" keeps one chip on the notebook's active cell until the user removes it.
 */

import type { IAttachment, INotebookAttachment } from "@jupyter/chat";
import { Signal } from "@lumino/signaling";

export interface CellRef {
  id: string;
  type: "code" | "markdown" | "raw";
}

/** A notebook attachment for some of its cells (the persona reads cells, not the raw file). */
export function cellsAttachment(path: string, cells: readonly CellRef[]): INotebookAttachment {
  return {
    type: "notebook",
    value: path,
    cells: cells.map((c) => ({ id: c.id, input_type: c.type })),
  };
}

/** The input model's attachment API, as @jupyter/chat's `IInputModel` has it. */
export interface AttachmentInput {
  readonly attachments: IAttachment[];
  addAttachment?(attachment: IAttachment): void;
  removeAttachment?(attachment: IAttachment): void;
  readonly attachmentsChanged?: Listenable<unknown>;
  readonly valueChanged: Listenable<string>;
}

interface Listenable<T> {
  connect(fn: (sender: unknown, value: T) => void): unknown;
  disconnect(fn: (sender: unknown, value: T) => void): unknown;
}

const same = (a: IAttachment, b: IAttachment) => JSON.stringify(a) === JSON.stringify(b);

/** Cells of one notebook are merged into one attachment by @jupyter/chat: look inside it. */
function holder(list: readonly IAttachment[], own: IAttachment): IAttachment | null {
  for (const a of list) {
    if (same(a, own)) return a;
    if (a.type === "notebook" && own.type === "notebook" && a.value === own.value) {
      const ids = new Set((a.cells ?? []).map((c) => c.id));
      if ((own.cells ?? []).every((c) => ids.has(c.id))) return a;
    }
  }
  return null;
}

/**
 * Keeps one attachment - `current()`, the active cell - on the input while following. Sending
 * clears the input's attachments; the chip comes back for the next message. The user removing it
 * stops following, as does `stop()`. Cells the user attached are theirs: following a cell that
 * was already attached contributes nothing, and moving on (or stopping) leaves it attached.
 */
export class ContextFollower {
  /** Emits whether it follows: when following starts or stops, and when the chip moves. */
  readonly changed = new Signal<ContextFollower, boolean>(this);
  #own: IAttachment | null = null;
  /** Whether `#own` was added by following (else the user had attached it already). */
  #contributed = false;
  #following = false;
  #sending = false;

  constructor(
    private readonly input: AttachmentInput,
    private readonly current: () => IAttachment | null,
    private readonly onChange: () => void = () => undefined,
  ) {
    input.valueChanged.connect(this.#onValue);
    input.attachmentsChanged?.connect(this.#onAttachments);
  }

  get following(): boolean {
    return this.#following;
  }

  start(): void {
    this.#following = true;
    this.#place();
    this.#changed();
  }

  stop(): void {
    if (!this.#following) return;
    this.#following = false;
    this.#remove();
    this.#changed();
  }

  /** The active cell (or notebook) changed: move the chip. */
  refresh(): void {
    if (!this.#following) return;
    const next = this.current();
    if (next && this.#own && same(next, this.#own)) return;
    this.#remove();
    this.#place();
    this.changed.emit(true);
  }

  #changed(): void {
    this.onChange();
    this.changed.emit(this.#following);
  }

  dispose(): void {
    Signal.clearData(this);
    this.input.valueChanged.disconnect(this.#onValue);
    this.input.attachmentsChanged?.disconnect(this.#onAttachments);
  }

  #place(): void {
    const next = this.current();
    this.#own = next;
    this.#contributed = false;
    if (next && !holder(this.input.attachments, next)) {
      this.#contributed = true;
      this.input.addAttachment?.(next);
    }
  }

  #remove(): void {
    const own = this.#own;
    const contributed = this.#contributed;
    this.#own = null;
    this.#contributed = false;
    // A cell the user had attached stays attached.
    if (!own || !contributed) return;
    const found = holder(this.input.attachments, own);
    if (!found) return;
    this.input.removeAttachment?.(found);
    if (!same(found, own) && found.type === "notebook" && own.type === "notebook") {
      // Merged with cells the user attached: keep theirs.
      const mine = new Set((own.cells ?? []).map((c) => c.id));
      const cells = (found.cells ?? []).filter((c) => !mine.has(c.id));
      if (cells.length) this.input.addAttachment?.({ ...found, cells });
    }
  }

  // Sending empties the text and then the attachments, in one synchronous step.
  readonly #onValue = (_: unknown, value: string) => {
    if (value !== "") return;
    this.#sending = true;
    queueMicrotask(() => {
      this.#sending = false;
    });
  };

  readonly #onAttachments = () => {
    const own = this.#own;
    if (!this.#following || !own) return;
    if (holder(this.input.attachments, own)) return;
    if (this.#sending) {
      // Sent with the message: back for the next one.
      this.#own = null;
      queueMicrotask(() => {
        if (this.#following) this.#place();
      });
    } else {
      // Removed by the user.
      this.#own = null;
      this.#following = false;
      this.#changed();
    }
  };
}

/**
 * The input models the composer's controls act on, by id: a menu's command arguments are JSON, so
 * they name the input the control was drawn in rather than "the chat's input".
 */
export class InputRegistry<T extends object> {
  readonly #ids = new WeakMap<T, string>();
  readonly #inputs = new Map<string, T>();
  #next = 0;

  idOf(input: T): string {
    let id = this.#ids.get(input);
    if (!id) {
      id = `input-${(this.#next += 1)}`;
      this.#ids.set(input, id);
      this.#inputs.set(id, input);
    }
    return id;
  }

  get(id: unknown): T | null {
    return typeof id === "string" ? (this.#inputs.get(id) ?? null) : null;
  }

  forget(input: T): void {
    const id = this.#ids.get(input);
    if (id) this.#inputs.delete(id);
  }
}
