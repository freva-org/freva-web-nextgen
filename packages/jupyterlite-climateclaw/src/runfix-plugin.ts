// The "Run & fix at DKRZ" notebook commands. One ClimateClaw thread per notebook, kept in the
// notebook's metadata with the notebook's path: a copy (another path) starts its own thread, and a
// kernel restart or "New DKRZ thread" starts a fresh one. Every run is a job (see runfix-jobs.ts)
// that owns its notebook, cell and starting source; the cell's toolbar shows its state and the way
// to cancel or stop it.

import { servedModel } from "./models.js";
import type { JupyterFrontEnd } from "@jupyterlab/application";
import {
  Dialog,
  InputDialog,
  Notification,
  showDialog,
  type IToolbarWidgetRegistry,
} from "@jupyterlab/apputils";
import { Signal } from "@lumino/signaling";
import { Widget } from "@lumino/widgets";
import type { ICodeCellModel } from "@jupyterlab/cells";
import type { INotebookTracker, NotebookPanel } from "@jupyterlab/notebook";

import type { IClimateClaw } from "./core.js";
import {
  METADATA_KEY,
  installCellSource,
  labelOutput,
  lineDiff,
  packageFor,
  type NbOutput,
} from "./runfix.js";
import { RunAtDkrzRunner } from "./runfix-runner.js";
import { RunAndFixJobs, applyCheck, boundThread, type Job, type Repair } from "./runfix-jobs.js";
import { fence } from "./stream.js";
import { RUN_AT_DKRZ_TOOLTIP, RunAtDkrzButton, type CellRunState } from "./run-at-dkrz.js";

/** The diff of a fix, in a dialog. */
function showDiff(diff: string) {
  const body = document.createElement("pre");
  body.className = "jp-ClimateClaw-diff";
  for (const line of diff.split("\n")) {
    const row = document.createElement("span");
    row.className = line.startsWith("+") ? "jp-mod-add" : line.startsWith("-") ? "jp-mod-del" : "";
    row.textContent = `${line}\n`;
    body.append(row);
  }
  return showDialog({
    title: "The repair ClimateClaw ran at DKRZ",
    body: new Widget({ node: body }),
    buttons: [Dialog.okButton({ label: "Close" })],
  });
}

export const RUN_AND_FIX = "climateclaw:run-and-fix";
export const STOP_RUN_AND_FIX = "climateclaw:stop-run-and-fix";
export const APPLY_FIX = "climateclaw:apply-fix";
export const ADD_FIX_BELOW = "climateclaw:add-fix-below";
export const ADD_INSTALL_CELL = "climateclaw:add-install-cell";
export const NEW_DKRZ_THREAD = "climateclaw:new-dkrz-thread";
export const RUN_WITH_NOTE = "climateclaw:run-and-fix-with-note";
export const RUN_MODEL = "climateclaw:run-at-dkrz-model";
export const ABOUT_RUN_AT_DKRZ = "climateclaw:about-run-at-dkrz";

/** How long "✓ Ran at DKRZ" shows before the button is ready again. */
const RAN_MS = 4_000;

/** How long a stopped run may take to end before its thread is given up. */
const STOP_GRACE_MS = 15_000;

/**
 * The notebook's thread - only if it was made for this notebook's path: a copy carries its
 * original's metadata, and sharing the original's thread would put both on one interpreter.
 */
function threadOf(panel: NotebookPanel): string | null {
  return boundThread(panel.content.model?.getMetadata(METADATA_KEY), panel.context.path);
}

function setThread(panel: NotebookPanel, threadId: string | null): void {
  const model = panel.content.model;
  if (!model) return;
  if (threadId) {
    model.setMetadata(METADATA_KEY, {
      runAndFixThread: threadId,
      runAndFixPath: panel.context.path,
    });
  } else model.deleteMetadata(METADATA_KEY);
}

/** What one DKRZ thread belongs to: the notebook document, shared by every view of it. */
function sessionOf(panel: NotebookPanel): object {
  return panel.context.model;
}

/** The cell's index in its notebook now, or -1 when it is no longer there. */
function indexOf(panel: NotebookPanel, cell: ICodeCellModel): number {
  if (panel.isDisposed) return -1;
  const cells = panel.content.model?.cells;
  if (!cells) return -1;
  for (let i = 0; i < cells.length; i += 1) if (cells.get(i) === cell) return i;
  return -1;
}

/** The cell's source now, or null when the cell is no longer in that notebook. */
function currentSource(panel: NotebookPanel, cell: ICodeCellModel): string | null {
  return indexOf(panel, cell) < 0 ? null : cell.sharedModel.getSource();
}

/**
 * A new code cell at `index`, with outputs (a fix that ran at DKRZ, an install cell). The user's
 * cells are not touched. Returns the new cell's model, or null.
 */
function insertCell(
  panel: NotebookPanel,
  index: number,
  source: string,
  metadata: Record<string, unknown>,
  outputs: readonly NbOutput[] = [],
): ICodeCellModel | null {
  const notebook = panel.content.model;
  if (!notebook || panel.isDisposed) return null;
  notebook.sharedModel.insertCell(index, { cell_type: "code", source, metadata } as never);
  const cell = notebook.cells.get(index) as ICodeCellModel | undefined;
  for (const output of outputs) cell?.outputs.add(output as never);
  panel.content.activeCellIndex = index;
  void panel.content.scrollToItem?.(index).catch(() => undefined);
  return cell ?? null;
}

type RunJob = Job<NotebookPanel, ICodeCellModel>;
type RunRepair = Repair<NotebookPanel, ICodeCellModel>;

export function registerRunAndFix(
  app: JupyterFrontEnd,
  core: IClimateClaw,
  tracker: INotebookTracker,
  toolbars: IToolbarWidgetRegistry | null = null,
  /** DKRZ's logo in motion, for the toolbar button while a cell runs. */
  runningLogo = "",
): void {
  const jobs = new RunAndFixJobs<NotebookPanel, ICodeCellModel>();
  const watched = new WeakSet<NotebookPanel>();
  /** How each cell's last run ended, for the toolbar (a run that ended well shows briefly). */
  const outcomes = new WeakMap<ICodeCellModel, { state: "ok" | "failed"; at: number }>();
  const stateChanged = new Signal<object, void>({});

  /** A new session for this notebook: its thread is forgotten, as is one still being made. */
  const resetSession = (panel: NotebookPanel) => {
    jobs.generations.bump(sessionOf(panel));
    setThread(panel, null);
  };
  /** Remembers a thread only for the session it was made in. */
  const commitThread = (panel: NotebookPanel, threadId: string, generation: number) => {
    if (jobs.generations.get(sessionOf(panel)) === generation) setThread(panel, threadId);
  };
  /** Gives up a thread whose state is unknown (a stop not confirmed): the next run starts anew. */
  const abandon = (panel: NotebookPanel, threadId: string) => {
    if (threadOf(panel) === threadId) resetSession(panel);
  };

  const watch = (panel: NotebookPanel) => {
    if (watched.has(panel)) return;
    watched.add(panel);
    // A restarted (or replaced) kernel is a new session: so is the DKRZ thread.
    panel.sessionContext.statusChanged.connect((_, status) => {
      if (status === "restarting" || status === "autorestarting") resetSession(panel);
    });
    panel.sessionContext.kernelChanged.connect((_, change) => {
      if (change.oldValue && change.newValue) resetSession(panel);
    });
  };
  tracker.widgetAdded.connect((_, panel) => watch(panel));
  tracker.forEach(watch);

  const activeCodeCell = () => {
    const panel = tracker.currentWidget;
    const cell = panel?.content.activeCell;
    if (!panel || !cell || cell.model.type !== "code") return null;
    return { panel, model: cell.model as ICodeCellModel };
  };

  const add = (model: ICodeCellModel, outputs: NbOutput[]) => {
    for (const output of outputs) model.outputs.add(output as never);
  };
  /** Outputs of a job, written only while it is the newest for its cell. */
  const addFor = (job: RunJob, outputs: NbOutput[]) => {
    if (jobs.isCurrent(job)) add(job.cell, outputs);
  };
  const changed = () => {
    app.commands.notifyCommandChanged(STOP_RUN_AND_FIX);
    app.commands.notifyCommandChanged(APPLY_FIX);
    app.commands.notifyCommandChanged(RUN_AND_FIX);
    stateChanged.emit();
  };

  /** The cell looks busy while its job lives: `[*]` and an edge in DKRZ's colour. */
  const markBusy = (job: RunJob, busy: boolean) => {
    if (!jobs.isCurrent(job)) return;
    job.cell.executionState = busy ? "running" : "idle";
    const widget = job.notebook.content.widgets.find((cell) => cell.model === job.cell);
    widget?.toggleClass("jp-ClimateClaw-atDkrz", busy);
  };
  /** The toolbar's face for a cell. */
  const cellState = (panel: NotebookPanel): CellRunState => {
    const cell = panel.content.activeCell;
    if (!cell || cell.model.type !== "code") return "idle";
    const model = cell.model as ICodeCellModel;
    if (jobs.activeFor(model)) return "busy";
    const outcome = outcomes.get(model);
    if (!outcome) return "idle";
    if (outcome.state === "ok" && Date.now() - outcome.at > RAN_MS) return "idle";
    return outcome.state;
  };

  const runner = new RunAtDkrzRunner<NotebookPanel, ICodeCellModel>({
    api: () => core.api,
    gate: core.gate,
    jobs,
    sessionOf,
    threadOf,
    commitThread,
    abandon,
    write: addFor,
    offer: (job, fixed, verified, note, outputs) => offer(job, fixed, verified, note, outputs),
    missing: (job, modules) => missing(job, modules),
    gaveUp: (job, reason, runs) => gaveUp(job, reason, runs),
    changed: () => changed(),
    previewOrigin: core.config.previewOrigin,
  });

  const run = async (job: RunJob, chatbot: string): Promise<void> => {
    try {
      await runner.run(job, chatbot);
    } finally {
      jobs.end(job, "finished");
      markBusy(job, false);
      if (jobs.isCurrent(job) && (job.state === "finished" || job.state === "failed")) {
        outcomes.set(job.cell, {
          state: job.state === "finished" ? "ok" : "failed",
          at: Date.now(),
        });
        if (job.state === "finished") setTimeout(() => stateChanged.emit(), RAN_MS + 50);
      } else if (jobs.isCurrent(job)) outcomes.delete(job.cell);
      changed();
    }
  };

  /**
   * Shows what ClimateClaw ran instead of the cell; offers it only when it ran successfully - as a
   * new cell below (the user's stays as written) or in the cell's place.
   */
  const offer = (
    job: RunJob,
    fixed: string,
    verified: boolean,
    note: string,
    outputs: NbOutput[] = [],
  ) => {
    const diff = lineDiff(job.baseSource, fixed);
    const heading = verified
      ? "**ClimateClaw changed the code, and the changed code ran without an error at DKRZ.** " +
        "Add it below this cell (yours stays as it is), or use it in its place."
      : "**ClimateClaw tried a change, but no run of it was reported successful: nothing to apply.**";
    addFor(job, [
      {
        output_type: "display_data",
        data: {
          "text/markdown": `${heading}${note ? ` ${note}` : ""}\n\n${fence(diff, "diff")}`,
          "text/plain": diff,
        },
        metadata: { climateclaw: { fix: true, verified } },
      },
    ]);
    if (!verified) return;
    const repair = jobs.propose(job, fixed, outputs);
    if (!repair) return;
    changed();
    const id: string = Notification.info(
      "The repaired version ran successfully at DKRZ. Your notebook cell is unchanged.",
      {
        autoClose: false,
        actions: [
          {
            label: "View diff",
            displayType: "link",
            callback: (event) => {
              // Stays open: the choice is still to be made.
              event.preventDefault();
              void showDiff(diff);
            },
          },
          {
            label: "Add fix below",
            displayType: "accent",
            callback: () => void app.commands.execute(ADD_FIX_BELOW, { jobId: repair.jobId }),
          },
          {
            label: "Replace cell",
            callback: () => void app.commands.execute(APPLY_FIX, { jobId: repair.jobId }),
          },
          { label: "Dismiss", callback: (): void => Notification.dismiss(id) },
        ],
      },
    );
  };

  /** DKRZ lacks modules the cell imports: run it in the notebook's own Python, installed there. */
  const missing = (job: RunJob, modules: string[]) => {
    const names = modules.map((m) => `\`${m}\``).join(", ");
    const packages = modules.map(packageFor).join(", ");
    addFor(job, [
      {
        output_type: "display_data",
        data: {
          "text/markdown":
            `**DKRZ's Python does not have ${names}**, so ClimateClaw did not run this cell there ` +
            "(and did not rewrite it without them).\n\n" +
            "Run it in this notebook's own Python instead - the **Freva Python** kernel, with " +
            "Shift+Enter. It runs in your browser (Pyodide), where packages are installed with " +
            `micropip: **Add install cell** puts \`await micropip.install([...])\` for ${packages} ` +
            "above this cell. A package with compiled code installs only if Pyodide provides it.",
          "text/plain": `DKRZ's Python does not have ${modules.join(", ")}.`,
        },
        metadata: { [METADATA_KEY]: { missing: modules } },
      },
    ]);
    if (!jobs.isCurrent(job)) return;
    const id = Notification.warning(`DKRZ's Python does not have ${modules.join(", ")}.`, {
      autoClose: false,
      actions: [
        {
          label: "Add install cell",
          displayType: "accent",
          callback: () => void app.commands.execute(ADD_INSTALL_CELL, { jobId: job.id, modules }),
        },
        { label: "Dismiss", callback: () => Notification.dismiss(id) },
      ],
    });
    pendingInstalls.set(job.id, job);
  };
  /** Jobs whose cell may get an install cell above it, by job id. */
  const pendingInstalls = new Map<string, RunJob>();

  /** No fix ran without an error. */
  const gaveUp = (job: RunJob, reason: string, runs: number) => {
    addFor(job, [
      {
        output_type: "display_data",
        data: {
          "text/markdown":
            `**ClimateClaw could not fix this cell at DKRZ** after ${runs} runs` +
            `${reason ? `: ${reason}` : "."}\n\n` +
            "Its attempts are summarised above. If the cell needs something DKRZ does not have, " +
            "run it in this notebook's own Python instead (the **Freva Python** kernel).",
          "text/plain": `ClimateClaw could not fix this cell after ${runs} runs.`,
        },
        metadata: { [METADATA_KEY]: { gaveUp: true } },
      },
    ]);
  };

  const apply = (repair: RunRepair, force: boolean) => {
    const source = currentSource(repair.notebook, repair.cell);
    const check = applyCheck(repair, { inNotebook: source !== null, source });
    if (check === "gone") {
      jobs.withdraw(repair.jobId);
      changed();
      Notification.warning("The cell this fix was made for is gone; nothing was changed.");
      return;
    }
    if (check === "conflict" && !force) {
      Notification.warning(
        "The cell was edited after Run & fix started, so the fix was not applied: it would " +
          "replace your newer code.",
        {
          autoClose: false,
          actions: [
            {
              label: "Replace my edits with the fix",
              callback: () =>
                void app.commands.execute(APPLY_FIX, { jobId: repair.jobId, force: true }),
            },
          ],
        },
      );
      return;
    }
    repair.cell.sharedModel.setSource(repair.fixed);
    // Its outputs are now the fixed code's, from its run at DKRZ.
    repair.cell.outputs.clear();
    repair.cell.outputs.add(labelOutput("") as never);
    for (const output of repair.outputs) repair.cell.outputs.add(output as never);
    jobs.withdraw(repair.jobId);
    changed();
  };

  /** The fix as a new cell below the one it was made for, with its outputs; that cell unchanged. */
  const addBelow = (repair: RunRepair) => {
    const at = indexOf(repair.notebook, repair.cell);
    if (at < 0) {
      jobs.withdraw(repair.jobId);
      changed();
      Notification.warning("The cell this fix was made for is gone; nothing was added.");
      return;
    }
    insertCell(
      repair.notebook,
      at + 1,
      repair.fixed,
      { [METADATA_KEY]: { fixOf: repair.cell.id, ranAtDkrz: true } },
      [labelOutput(""), ...(repair.outputs as NbOutput[])],
    );
    jobs.withdraw(repair.jobId);
    changed();
  };

  app.commands.addCommand(RUN_AND_FIX, {
    label: (args) => (typeof args.label === "string" ? args.label : "Run at DKRZ"),
    caption: RUN_AT_DKRZ_TOOLTIP,
    isEnabled: () => {
      const target = activeCodeCell();
      return target !== null && jobs.activeFor(target.model) === null;
    },
    execute: (args) => {
      const target = activeCodeCell();
      if (!target) return;
      const { panel, model } = target;
      if (!core.api || !core.auth) {
        Notification.error("ClimateClaw is not configured for this site.");
        return;
      }
      if (!core.auth.signedIn) {
        Notification.warning("Sign in with Freva to run cells at DKRZ.", {
          autoClose: false,
          actions: [{ label: "Sign in with Freva", callback: () => core.auth?.login() }],
        });
        return;
      }
      // Reserved now, before any request: a second click finds it and does nothing.
      const job = jobs.reserve(
        { notebook: panel, cell: model, session: sessionOf(panel) },
        model.sharedModel.getSource(),
      );
      if (!job) return;
      if (typeof args.note === "string" && args.note.trim()) job.note = args.note.trim();
      model.outputs.clear();
      model.executionCount = null;
      markBusy(job, true);
      // The chosen model, when the server serves it; else the chat's default model.
      const chatbot = servedModel(
        core.runModel,
        core.servedModels,
        servedModel(core.config.defaultModel, core.servedModels, core.servedModels[0] ?? ""),
      );
      add(model, [labelOutput(chatbot)]);
      // One thread per notebook runs one cell at a time: behind another cell's job, this waits.
      const done = jobs.schedule(job, async () => {
        if (queued && jobs.isCurrent(job)) {
          model.outputs.clear();
          add(model, [labelOutput(chatbot)]);
        }
        await run(job, chatbot);
      });
      const queued = job.state === "queued";
      if (queued) {
        add(model, [
          {
            output_type: "stream",
            name: "stdout",
            text: "Queued: this notebook's DKRZ thread runs one cell at a time; this one starts when the Run & fix before it is done.\n",
          },
        ]);
      }
      changed();
      return done;
    },
  });

  /** The active cell's job, for the cell toolbar's control. */
  const activeJob = () => {
    const target = activeCodeCell();
    return target ? jobs.activeFor(target.model) : null;
  };

  const stopJob = (job: RunJob) => {
    const waiting = job.state === "queued";
    const request = jobs.stop(job);
    if (!request) return;
    if (waiting) {
      // A queued job never starts, so nothing else will say so.
      addFor(job, [
        { output_type: "stream", name: "stderr", text: "Cancelled before it started.\n" },
      ]);
      return;
    }
    if (request.kind === "abandon") {
      // Its request may already be running on the thread: the next run takes a new one.
      abandon(job.notebook, request.threadId);
      void core.api?.stop(request.threadId).catch(() => undefined);
      return;
    }
    if (request.kind !== "wait") return;
    addFor(job, [
      {
        output_type: "stream",
        name: "stderr",
        text: "Stopping: waiting for DKRZ to end the run…\n",
      },
    ]);
    const giveUp = () => {
      if (job.state !== "stopping") return;
      // Not confirmed: stop listening, and do not run on that thread again.
      abandon(job.notebook, request.threadId);
      job.controller.abort();
    };
    const timer = setTimeout(giveUp, STOP_GRACE_MS);
    void (core.api?.stop(request.threadId) ?? Promise.reject(new Error("not configured"))).then(
      () => undefined,
      () => {
        clearTimeout(timer);
        giveUp();
      },
    );
  };

  app.commands.addCommand(STOP_RUN_AND_FIX, {
    label: () => {
      const state = activeJob()?.state;
      return state === "queued"
        ? "Cancel (queued)"
        : state === "stopping"
          ? "Stopping…"
          : state === "running" || state === "starting"
            ? "Stop (running at DKRZ)"
            : "Stop Run & fix at DKRZ";
    },
    caption: "Cancel a queued Run & fix, or stop a running one (it stops when DKRZ confirms)",
    isVisible: (args) => !args.toolbar || activeJob() !== null,
    isEnabled: () => {
      const own = activeJob();
      return own ? own.state !== "stopping" : jobs.active.some((j) => j.state !== "stopping");
    },
    execute: (args) => {
      const own = args.all === true ? null : activeJob();
      // The active cell's job, else (or with `all`: signing out) every job.
      for (const job of own ? [own] : jobs.active) stopJob(job);
      changed();
    },
  });

  app.commands.addCommand(RUN_WITH_NOTE, {
    label: "Run with a note…",
    caption: "Say something about the code before it runs at DKRZ (what to use, what to expect)",
    isEnabled: () => app.commands.isEnabled(RUN_AND_FIX),
    execute: async () => {
      const answer = await InputDialog.getText({
        title: "Run at DKRZ with a note",
        placeholder: "e.g. use the 2020 files only; the plot should show monthly means",
        okLabel: "Run at DKRZ",
      });
      const note = answer.value?.trim() ?? "";
      if (answer.button.accept) await app.commands.execute(RUN_AND_FIX, { note });
    },
  });

  app.commands.addCommand(RUN_MODEL, {
    label: (args) => String(args.model ?? "Model"),
    isToggled: (args) => core.runModel === args.model,
    execute: (args) => {
      if (typeof args.model === "string" && args.model) return core.setRunModel(args.model);
    },
  });

  app.commands.addCommand(ABOUT_RUN_AT_DKRZ, {
    label: "About DKRZ execution",
    execute: () =>
      showDialog({
        title: "Run at DKRZ",
        body: `${RUN_AT_DKRZ_TOOLTIP} It runs in ClimateClaw's Python at DKRZ, not in this notebook's kernel: one session per notebook, kept until you reset it or restart the kernel. A model is in the loop, so it is slower than the kernel and not deterministic.`,
        buttons: [Dialog.okButton({ label: "Close" })],
      }),
  });

  if (toolbars) {
    toolbars.addFactory<NotebookPanel>("Notebook", "climateclawRunAndFix", (panel) => {
      const changedHere = new Signal<object, void>({});
      const forward = () => changedHere.emit();
      stateChanged.connect(forward);
      panel.content.activeCellChanged.connect(forward);
      const button = new RunAtDkrzButton({
        commands: app.commands,
        state: () => cellState(panel),
        changed: changedHere,
        run: RUN_AND_FIX,
        runWithNote: RUN_WITH_NOTE,
        stop: STOP_RUN_AND_FIX,
        reset: NEW_DKRZ_THREAD,
        about: ABOUT_RUN_AT_DKRZ,
        model: RUN_MODEL,
        models: () =>
          core.servedModels.length ? core.servedModels : [core.runModel].filter(Boolean),
        ...(runningLogo ? { runningLogo } : {}),
      });
      button.disposed.connect(() => {
        stateChanged.disconnect(forward);
        panel.content.activeCellChanged.disconnect(forward);
      });
      return button;
    });
  }

  app.commands.addCommand(APPLY_FIX, {
    label: "Apply fix to cell",
    isEnabled: (args) => {
      if (typeof args.jobId === "string") return jobs.repair(args.jobId) !== null;
      const target = activeCodeCell();
      return target !== null && jobs.repairFor(target.panel, target.model) !== null;
    },
    execute: (args) => {
      const target = activeCodeCell();
      const repair =
        typeof args.jobId === "string"
          ? jobs.repair(args.jobId)
          : target
            ? jobs.repairFor(target.panel, target.model)
            : null;
      if (repair) apply(repair, args.force === true);
    },
  });

  app.commands.addCommand(ADD_FIX_BELOW, {
    label: "Add fix below the cell",
    caption: "Add ClimateClaw's fix, with its output from DKRZ, as a new cell below; yours stays",
    isEnabled: (args) => {
      if (typeof args.jobId === "string") return jobs.repair(args.jobId) !== null;
      const target = activeCodeCell();
      return target !== null && jobs.repairFor(target.panel, target.model) !== null;
    },
    execute: (args) => {
      const target = activeCodeCell();
      const repair =
        typeof args.jobId === "string"
          ? jobs.repair(args.jobId)
          : target
            ? jobs.repairFor(target.panel, target.model)
            : null;
      if (repair) addBelow(repair);
    },
  });

  app.commands.addCommand(ADD_INSTALL_CELL, {
    label: "Add install cell above",
    caption: "Install the packages the cell needs into this notebook's own Python (micropip)",
    execute: (args) => {
      const job = typeof args.jobId === "string" ? pendingInstalls.get(args.jobId) : undefined;
      const modules = Array.isArray(args.modules)
        ? (args.modules as unknown[]).filter((m): m is string => typeof m === "string")
        : [];
      if (!job || !modules.length) return;
      pendingInstalls.delete(job.id);
      const at = indexOf(job.notebook, job.cell);
      if (at < 0) {
        Notification.warning("The cell is gone; nothing was added.");
        return;
      }
      insertCell(job.notebook, at, installCellSource(modules), {
        [METADATA_KEY]: { installFor: job.cell.id },
      });
    },
  });

  app.commands.addCommand(NEW_DKRZ_THREAD, {
    label: "Reset DKRZ session",
    caption:
      "Forget this notebook's session at DKRZ (its variables and imports); the next Run at DKRZ starts a new one.",
    isEnabled: () => tracker.currentWidget !== null,
    execute: () => {
      const panel = tracker.currentWidget;
      // A thread still being made for the old session is not kept either.
      if (panel) resetSession(panel);
    },
  });
}
