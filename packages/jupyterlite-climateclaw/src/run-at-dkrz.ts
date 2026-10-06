// The notebook toolbar's "▶ Run at DKRZ ▾": a split button whose face follows the active cell -
// ready, running at DKRZ (with Stop), ran, or failed - and whose menu holds the rest: run with a
// note, the model, a fresh DKRZ session and what this is.

import { runIcon } from "@jupyterlab/ui-components";
import type { CommandRegistry } from "@lumino/commands";
import type { ISignal } from "@lumino/signaling";
import { Menu, Widget } from "@lumino/widgets";

import { DKRZ_LOGO_DATA_URL, reducedMotion } from "./dkrz-logo.js";

export const RUN_AT_DKRZ_TOOLTIP =
  "Runs this cell remotely at DKRZ using ClimateClaw: it checks the cell's imports there first, and if the cell fails it tries a minimal fix (at most 3 runs). A fix that ran is offered as a new cell below yours; your cell is not changed unless you choose Replace cell.";

/** What the toolbar shows for the active cell. */
export type CellRunState = "idle" | "busy" | "ok" | "failed";

export interface RunAtDkrzOptions {
  commands: CommandRegistry;
  /** The active cell's state in this notebook. */
  state: () => CellRunState;
  /** Emits whenever any cell's state, or the active cell, changes. */
  changed: ISignal<unknown, void>;
  /** Command ids. */
  run: string;
  runWithNote: string;
  stop: string;
  reset: string;
  about: string;
  model: string;
  /** The models Run at DKRZ can use. */
  models: () => string[];
  /** DKRZ's logo in motion, shown while the cell runs (the still logo otherwise). */
  runningLogo?: string;
}

const FACES: Record<CellRunState, { text: string; title: string }> = {
  idle: { text: "Run at DKRZ", title: RUN_AT_DKRZ_TOOLTIP },
  // As wide as the others, so the toolbar never reflows while a cell runs.
  busy: { text: "Running…", title: "This cell is running at DKRZ." },
  ok: { text: "Ran at DKRZ", title: "This cell ran at DKRZ. Click to run it again." },
  failed: {
    text: "Failed",
    title: "This cell failed at DKRZ; see its output. Click to run it again.",
  },
};

/** Beside the logo: how the last run ended. */
const MARKS: Record<CellRunState, string> = { idle: "", busy: "", ok: "✓", failed: "⚠" };

export class RunAtDkrzButton extends Widget {
  readonly #main = document.createElement("button");
  /** JupyterLab's own run triangle: this runs the cell, like the toolbar's Run, but at DKRZ. */
  readonly #play = runIcon.element({ tag: "span", className: "jp-ClimateClaw-runAt-play" });
  readonly #glyph = document.createElement("span");
  readonly #logo = document.createElement("img");
  readonly #mark = document.createElement("span");
  readonly #text = document.createElement("span");
  readonly #caret = document.createElement("button");
  readonly #stop = document.createElement("button");

  constructor(private readonly options: RunAtDkrzOptions) {
    super();
    this.addClass("jp-ClimateClaw-runAt");
    this.#main.type = "button";
    this.#main.className = "jp-ClimateClaw-runAt-main";
    this.#glyph.className = "jp-ClimateClaw-runAt-glyph";
    this.#glyph.setAttribute("aria-hidden", "true");
    this.#logo.className = "jp-ClimateClaw-runAt-logo";
    this.#logo.alt = "";
    this.#logo.src = DKRZ_LOGO_DATA_URL;
    this.#mark.className = "jp-ClimateClaw-runAt-mark";
    this.#glyph.append(this.#logo, this.#mark);
    this.#text.className = "jp-ClimateClaw-runAt-text";
    this.#play.setAttribute("aria-hidden", "true");
    this.#main.append(this.#play, this.#glyph, this.#text);
    this.#main.addEventListener("click", () => {
      if (options.state() !== "busy") void options.commands.execute(options.run);
    });
    this.#caret.type = "button";
    this.#caret.className = "jp-ClimateClaw-runAt-caret";
    this.#caret.textContent = "▾";
    this.#caret.title = "More ways to run at DKRZ";
    this.#caret.setAttribute("aria-label", this.#caret.title);
    this.#caret.setAttribute("aria-haspopup", "menu");
    this.#caret.addEventListener("click", () => this.#menu());
    this.#stop.type = "button";
    this.#stop.className = "jp-ClimateClaw-runAt-stop";
    this.#stop.textContent = "Stop";
    this.#stop.title = "Stop the run at DKRZ (it stops when DKRZ confirms)";
    this.#stop.addEventListener("click", () => void options.commands.execute(options.stop));
    this.node.append(this.#main, this.#caret, this.#stop);
    options.changed.connect(this.#update, this);
    this.#update();
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.options.changed.disconnect(this.#update, this);
    super.dispose();
  }

  #update(): void {
    const state = this.options.state();
    const face = FACES[state];
    this.node.dataset.state = state;
    // DKRZ's logo: still at rest (or with less motion), turning while the cell runs there.
    const moving = state === "busy" && this.options.runningLogo && !reducedMotion();
    const logo = moving ? this.options.runningLogo! : DKRZ_LOGO_DATA_URL;
    if (this.#logo.getAttribute("src") !== logo) this.#logo.src = logo;
    this.#mark.textContent = MARKS[state];
    // While it runs, the turning logo says so: no play sign then.
    this.#play.hidden = state === "busy";
    this.#text.textContent = face.text;
    this.#main.title = face.title;
    this.#main.setAttribute("aria-label", face.text);
    this.#main.setAttribute("aria-disabled", String(state === "busy"));
    // Stop takes the caret's place while busy.
    this.#stop.hidden = state !== "busy";
    this.#caret.hidden = state === "busy";
    this.#stop.disabled = !this.options.commands.isEnabled(this.options.stop);
  }

  #menu(): void {
    const { commands } = this.options;
    const menu = new Menu({ commands });
    menu.addClass("jp-ClimateClaw-runAtMenu");
    const models = new Menu({ commands });
    models.addClass("jp-ClimateClaw-runAtModels");
    models.title.label = "Model";
    for (const model of this.options.models()) {
      models.addItem({ command: this.options.model, args: { model } });
    }
    menu.addItem({ command: this.options.run, args: { label: "Run this cell" } });
    menu.addItem({ command: this.options.runWithNote });
    menu.addItem({ type: "submenu", submenu: models });
    menu.addItem({ type: "separator" });
    menu.addItem({ command: this.options.reset });
    menu.addItem({ command: this.options.about });
    menu.aboutToClose.connect(() => queueMicrotask(() => menu.dispose()));
    const rect = this.#caret.getBoundingClientRect();
    menu.open(rect.left, rect.bottom);
  }
}
