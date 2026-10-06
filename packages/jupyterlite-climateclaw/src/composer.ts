/**
 * The composer's ClimateClaw controls, added to each chat's own input toolbar registry (the
 * extension point jupyterlite-ai creates per chat): "Add context", "Prompts", the code toggle and
 * a status line - what ClimateClaw is doing while it replies, then a jump to the notebook cells
 * the reply wrote. They show only while the chat talks to ClimateClaw; context goes in as
 * @jupyter/chat attachments, which jupyterlite-ai's persona expands into the message.
 */

import { TooltippedButton, type IChatPanel, type InputToolbarRegistry } from "@jupyter/chat";
import type { IAISettingsModel } from "@jupyternaut/agent";
import type { LabIcon } from "@jupyterlab/ui-components";
import { CommandRegistry } from "@lumino/commands";
import { Signal } from "@lumino/signaling";
import { Menu } from "@lumino/widgets";
import * as React from "react";

import { elapsed, type ActivityStore, type DkrzCell, type ThreadActivity } from "./activity.js";
import type { ContextFollower, InputRegistry } from "./context.js";
import { climateClawEntries, isClimateClawChat, whenAgent, agentOf } from "./header.js";
import { openModelPicker } from "./model-picker.js";
import {
  canDictate,
  Dictation,
  hasVoiceConsent,
  recognisesLocally,
  rememberVoiceConsent,
} from "./voice.js";
import { tierFor, type Tier } from "./tiers.js";
import {
  codeIcon,
  codeOffIcon,
  contextIcon,
  followIcon,
  jumpIcon,
  micIcon,
  modelIcon,
  promptsIcon,
} from "./icons.js";
import { newMessageOnly } from "./edit-mode.js";
import { BusyLine } from "./busy-line.js";
import { INPUT_PLACEHOLDER } from "./chat-text.js";
import { markedThread } from "./threads.js";
import { OWN_STOP } from "./chat-views.js";
import { stopElement } from "./stop-button.js";

export const ComposerCommandIds = {
  attachActiveCell: "climateclaw:attach-active-cell",
  attachSelectedCells: "climateclaw:attach-selected-cells",
  attachNotebook: "climateclaw:attach-notebook",
  attachFile: "climateclaw:attach-file",
  followActiveCell: "climateclaw:follow-active-cell",
} as const;

/** Items this module adds, by name and position (jupyterlite-ai's own sit at 0-1, send at 100). */
const ITEMS = {
  climateclawContext: -3,
  climateclawPrompts: -2,
  climateclawCode: -1,
  climateclawSpacer: 10,
  climateclawStatus: 11,
  // ClimateClaw's own panel: the model picker and the microphone, just before Send.
  climateclawModels: 99,
  climateclawVoice: 99.5,
} as const;

const CODE_TIPS = {
  shown:
    "Hide code is off: each run's code shows in the chat with its output (both are always in " +
    "the notebook cell too). Turn it on to fold the code; outputs, errors and figures stay.",
  hidden:
    "Hide code is on: each run's code is folded under its line - click the line to see it. " +
    "Outputs, errors and figures still show. Turn it off to show all code.",
} as const;

/** The tier of the input toolbar holding `ref`; observed, never changed. */
function useTier(ref: React.RefObject<HTMLElement | null>): Tier {
  const [tier, setTier] = React.useState<Tier>("wide");
  React.useEffect(() => {
    const toolbar = ref.current?.parentElement;
    if (!toolbar || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setTier(tierFor(toolbar.clientWidth)));
    observer.observe(toolbar);
    return () => observer.disconnect();
  }, [ref]);
  return tier;
}

interface PillProps {
  /** The label per tier; null shows the icon alone. */
  labels: Record<Tier, string | null>;
  tooltip: string;
  icon: LabIcon;
  className: string;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  /** Lit: a mode is on (following the active cell). */
  active?: boolean;
  /** A toggle's state, for assistive technology. */
  pressed?: boolean;
  /** Opens a menu. */
  menu?: boolean;
  /** Room the status beside Send takes: 1 one tier less, 2 the icon alone. */
  yields?: Yield;
  /** Steps aside entirely while yielding in a narrow composer. */
  optional?: boolean;
  /** The tier, when the caller measures it (a pill inside another item). */
  tier?: Tier;
  /**
   * How it looks in the composer, as chat apps draw theirs: a round icon button ("+", the
   * microphone, the code toggle), an outlined chip (a mode), plain text with a chevron, or the
   * model: its mark, its name and a chevron (the mark alone where there is no room).
   */
  look?: "icon" | "chip" | "text" | "model";
}

/** How much room the composer's buttons leave to the status: none, some (a jump), all (at work). */
type Yield = 0 | 1 | 2;
const LESS: Record<Tier, Tier> = { wide: "medium", medium: "narrow", narrow: "narrow" };

const BRAND_TINT = "color-mix(in srgb, var(--jp-brand-color1) 14%, transparent)";
const BRAND_EDGE = "color-mix(in srgb, var(--jp-brand-color1) 40%, transparent)";

function Pill(props: PillProps): React.JSX.Element {
  const ref = React.useRef<HTMLSpanElement>(null);
  const measured = useTier(ref);
  const observed = props.tier ?? measured;
  const yields = props.yields ?? 0;
  const tier = yields === 2 ? "narrow" : yields === 1 ? LESS[observed] : observed;
  const look = props.look ?? "text";
  const label = look === "icon" ? null : props.labels[tier];
  if (yields && props.optional && observed === "narrow") {
    // Still measured, to come back when there is room.
    return React.createElement("span", { ref, className: props.className, hidden: true });
  }
  return React.createElement(
    "span",
    {
      ref,
      className: `jp-ClimateClaw-composerItem ${props.className}`,
      "data-tier": tier,
      "data-look": look,
    },
    React.createElement(TooltippedButton, {
      onClick: props.onClick,
      tooltip: props.tooltip,
      inputToolbar: false,
      // Over @jupyter/chat's theme, which makes every button a 24px square.
      sx: {
        width: look === "icon" ? "32px" : "auto",
        minWidth: 0,
        height: "32px",
        px: look === "icon" ? 0 : label ? 3 : 1.5,
        gap: 1.5,
        lineHeight: 1.4,
        textTransform: "none",
        whiteSpace: "nowrap",
        boxShadow: "none",
        borderRadius: "999px",
        border: "1px solid",
        borderColor: props.active
          ? BRAND_EDGE
          : look === "chip"
            ? "var(--jp-border-color1)"
            : "transparent",
        backgroundColor: props.active ? BRAND_TINT : "transparent",
        color: props.active ? "var(--jp-brand-color1)" : "var(--jp-ui-font-color1)",
        fontSize: "var(--jp-ui-font-size1)",
        fontWeight: props.active ? 600 : 400,
        transition: "background-color 120ms ease, border-color 120ms ease",
        "&:hover": {
          boxShadow: "none",
          backgroundColor: props.active ? BRAND_TINT : "var(--jp-layout-color2)",
          borderColor: props.active ? BRAND_EDGE : "var(--jp-border-color2)",
        },
        "& .jp-icon3[stroke]": {
          stroke: props.active ? "var(--jp-brand-color1)" : "var(--jp-ui-font-color2)",
        },
      },
      buttonProps: {
        variant: "text",
        size: "small",
        title: props.tooltip,
        ...(props.pressed !== undefined ? { "aria-pressed": props.pressed } : {}),
        ...(props.menu ? { "aria-haspopup": "menu" as const } : {}),
        className: "jp-ClimateClaw-composerButton",
      },
      children: React.createElement(
        "span",
        { className: "jp-ClimateClaw-composerButton-content" },
        look === "text" && label
          ? null
          : React.createElement(props.icon.react, {
              tag: "span",
              className: "jp-ClimateClaw-composerIcon",
            }),
        label
          ? React.createElement("span", { className: "jp-ClimateClaw-composerLabel" }, label)
          : null,
        (look === "text" || look === "model") && props.menu ? chevron() : null,
      ),
    }),
  );
}

/** The small chevron after a text choice ("gpt-4.1 ⌄"). */
function chevron(): React.JSX.Element {
  return React.createElement(
    "svg",
    {
      className: "jp-ClimateClaw-composerChevron",
      viewBox: "0 0 24 24",
      width: 14,
      height: 14,
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 2,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": true,
    },
    React.createElement("path", { d: "M6 9l6 6 6-6" }),
  );
}

/** The input toolbar's row is wider than the toolbar: an item sticks out on either side. */
function overflows(toolbar: HTMLElement): boolean {
  if (toolbar.scrollWidth > toolbar.clientWidth + 1) return true;
  const box = toolbar.getBoundingClientRect();
  return [...toolbar.children].some((child) => {
    const r = child.getBoundingClientRect();
    return r.width > 0 && (r.left < box.left - 1 || r.right > box.right + 1);
  });
}

function openMenuBelow(menu: Menu, event: React.MouseEvent<HTMLElement>): void {
  const rect = event.currentTarget.getBoundingClientRect();
  menu.open(rect.left, rect.top, { forceY: false });
}

/** The cells the last reply wrote: one jumps there; several open a menu of them. */
function CellsChip(props: { cells: readonly DkrzCell[]; tier: Tier }): React.JSX.Element {
  const { cells } = props;
  const lastCell = cells[cells.length - 1]!;
  const numbers = cells.map((c) => c.number);
  const label =
    cells.length === 1
      ? `Cell ${lastCell.number}`
      : `Cells ${Math.min(...numbers)}–${Math.max(...numbers)}`;
  const onClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (cells.length === 1) return lastCell.jump();
    // A menu of its own: its entries are this reply's cells, not app commands.
    const local = new CommandRegistry();
    local.addCommand("jump", {
      label: (args) => {
        const cell = cells[Number(args.index)];
        return cell ? `Cell ${cell.number} · ${cell.notebook}` : "Cell";
      },
      execute: (args) => cells[Number(args.index)]?.jump(),
    });
    const menu = new Menu({ commands: local });
    menu.addClass("jp-ClimateClaw-cellsMenu");
    cells.forEach((_, index) => menu.addItem({ command: "jump", args: { index } }));
    menu.aboutToClose.connect(() => queueMicrotask(() => menu.dispose()));
    const rect = event.currentTarget.getBoundingClientRect();
    menu.open(rect.left, rect.top, { forceY: false });
  };
  return React.createElement(Pill, {
    labels: { wide: label, medium: label, narrow: String(lastCell.number) },
    tooltip:
      cells.length === 1
        ? `Go to cell ${lastCell.number} of ${lastCell.notebook}, where this reply's code ran at DKRZ`
        : `Go to a cell this reply wrote (${cells.length})`,
    icon: jumpIcon,
    className: "jp-ClimateClaw-cells",
    tier: props.tier,
    menu: cells.length > 1,
    onClick,
  });
}

export interface ComposerOptions {
  commands: CommandRegistry;
  /** The inputs the controls were drawn in, by id, for the commands they run. */
  inputs: InputRegistry<object>;
  settings: IAISettingsModel;
  /** Whether the chat leaves out the code ClimateClaw runs, and its setter. */
  hideCode: () => boolean;
  setHideCode: (hidden: boolean) => void;
  /** Emits when the code setting or the models change. */
  changed: { connect(fn: () => void): unknown; disconnect(fn: () => void): unknown };
  /** ClimateClaw's own panel: the model picker beside Send instead of jupyterlite-ai's. */
  ownPanel?: boolean;
  /** Speech goes to the browser maker's service: may it? (asked once). */
  askVoiceConsent?: () => Promise<boolean>;
  onVoiceError?: (error: string) => void;
  /** Commands of the example prompts (fill, and "Send now"). */
  examples: Array<{ title: string }>;
  exampleCommand: string;
  /** Each thread's activity, and the cells its reply wrote. */
  activity: ActivityStore;
  /** This chat's context follower. */
  follower: (panel: IChatPanel) => ContextFollower;
  /** The notebook's active cell, counted from 1 (0: none). */
  activeCellNumber: () => number;
}

/** Adds the composer items to one chat, and shows them only while it talks to ClimateClaw. */
export function addComposer(panel: IChatPanel, options: ComposerOptions): void {
  const registry = panel.widget.inputToolbarRegistry;
  if (!registry || registry.get("climateclawContext")) return;
  const { commands } = options;
  const chatId = panel.id;

  // The buttons make room for the status beside Send, only as much as the row needs: one tier
  // less, then icons alone.
  let yields: Yield = 0;
  const yieldsChanged = new Signal<IChatPanel, Yield>(panel);
  const setYields = (next: Yield) => {
    if (next === yields) return;
    yields = next;
    yieldsChanged.emit(next);
  };
  const useYields = (): Yield => {
    const [value, setValue] = React.useState<Yield>(yields);
    React.useEffect(() => {
      const update = (_: unknown, next: Yield) => setValue(next);
      yieldsChanged.connect(update);
      return () => void yieldsChanged.disconnect(update);
    }, []);
    return value;
  };

  /** The commands act on the input the control is drawn in. */
  const target = (input: object) => ({ chatId, inputId: options.inputs.idOf(input) });

  const contextMenu = (event: React.MouseEvent<HTMLButtonElement>, input: object) => {
    const menu = new Menu({ commands });
    menu.addClass("jp-ClimateClaw-contextMenu");
    for (const id of [
      ComposerCommandIds.attachActiveCell,
      ComposerCommandIds.attachSelectedCells,
      ComposerCommandIds.attachNotebook,
      ComposerCommandIds.attachFile,
    ]) {
      menu.addItem({ command: id, args: target(input) });
    }
    menu.addItem({ type: "separator" });
    menu.addItem({ command: ComposerCommandIds.followActiveCell, args: target(input) });
    openMenuBelow(menu, event);
  };

  const promptsMenu = (event: React.MouseEvent<HTMLButtonElement>, input: object) => {
    const menu = new Menu({ commands });
    menu.addClass("jp-ClimateClaw-promptsMenu");
    const send = new Menu({ commands });
    send.title.label = "Send now";
    options.examples.forEach((example, index) => {
      const args = { index, title: example.title, ...target(input) };
      menu.addItem({ command: options.exampleCommand, args });
      send.addItem({ command: options.exampleCommand, args: { ...args, send: true } });
    });
    menu.addItem({ type: "separator" });
    menu.addItem({ type: "submenu", submenu: send });
    openMenuBelow(menu, event);
  };

  const ContextButton: React.FunctionComponent<InputToolbarRegistry.IToolbarItemProps> = (
    props,
  ) => {
    const follower = options.follower(panel);
    const [following, setFollowing] = React.useState(follower.following);
    const [, setMoves] = React.useState(0);
    const room = useYields();
    const cell = () => {
      const n = options.activeCellNumber();
      return n ? `cell ${n}` : "cell";
    };
    React.useEffect(() => {
      const update = (_: unknown, value: boolean) => {
        setFollowing(value);
        setMoves((n) => n + 1);
      };
      follower.changed.connect(update);
      return () => void follower.changed.disconnect(update);
    }, [follower]);
    return React.createElement(Pill, {
      labels: following
        ? { wide: `Following ${cell()}`, medium: `C${cell().slice(1)}`, narrow: null }
        : { wide: "Add context", medium: "Context", narrow: null },
      tooltip: following
        ? "The active cell goes with every message"
        : "Add cells or a file to the next message",
      icon: following ? followIcon : contextIcon,
      className: "jp-ClimateClaw-addContext",
      look: following ? "chip" : "icon",
      active: following,
      yields: room,
      menu: true,
      onClick: (event) => contextMenu(event, props.model),
    });
  };

  const PromptsButton: React.FunctionComponent<InputToolbarRegistry.IToolbarItemProps> = (props) =>
    React.createElement(Pill, {
      labels: { wide: "Prompts", medium: "Prompts", narrow: null },
      tooltip: "Example questions",
      icon: promptsIcon,
      className: "jp-ClimateClaw-prompts",
      yields: useYields(),
      optional: true,
      menu: true,
      onClick: (event) => promptsMenu(event, props.model),
    });

  const CodeButton: React.FunctionComponent<InputToolbarRegistry.IToolbarItemProps> = () => {
    const [hidden, setHidden] = React.useState(options.hideCode());
    const room = useYields();
    React.useEffect(() => {
      const update = () => setHidden(options.hideCode());
      options.changed.connect(update);
      return () => void options.changed.disconnect(update);
    }, []);
    // A switch: on hides the code in the chat, off shows it.
    return React.createElement(Pill, {
      labels: { wide: null, medium: null, narrow: null },
      tooltip: hidden ? CODE_TIPS.hidden : CODE_TIPS.shown,
      icon: hidden ? codeOffIcon : codeIcon,
      className: "jp-ClimateClaw-codeToggle",
      // A round icon, lit while on: the tooltip says what it does.
      look: "icon",
      yields: room,
      pressed: hidden,
      active: hidden,
      onClick: () => options.setHideCode(!options.hideCode()),
    });
  };

  /** The chat's model, and Run at DKRZ's, in one popover. */
  const ModelsButton: React.FunctionComponent<InputToolbarRegistry.IToolbarItemProps> = () => {
    const [, setTick] = React.useState(0);
    React.useEffect(() => {
      const update = () => setTick((n) => n + 1);
      options.changed.connect(update);
      options.settings.stateChanged.connect(update);
      let live = true;
      whenAgent(panel, (agent) => {
        if (live) agent.activeProviderChanged.connect(update);
      });
      return () => {
        live = false;
        options.changed.disconnect(update);
        options.settings.stateChanged.disconnect(update);
        agentOf(panel)?.activeProviderChanged.disconnect(update);
      };
    }, []);
    const entries = climateClawEntries(options.settings);
    const active = agentOf(panel)?.activeProvider ?? "";
    const model = options.settings.getProvider(active)?.model ?? "";
    return React.createElement(Pill, {
      labels: { wide: model || "Model", medium: model || "Model", narrow: null },
      tooltip: `Model: ${model || "the default"}. Click to choose another.`,
      icon: modelIcon,
      className: "jp-ClimateClaw-models",
      look: "model",
      menu: true,
      onClick: (event) => {
        const anchor = event.currentTarget as HTMLElement;
        openModelPicker(
          anchor,
          [
            {
              title: "Model",
              hint: "Answers in this chat; runs at DKRZ through your Freva account.",
              choices: entries.map((e) => ({ value: e.id, label: e.model ?? e.name })),
              current: active,
              choose: (id) => {
                const agent = agentOf(panel);
                if (agent) agent.activeProvider = id;
              },
            },
          ],
          "",
        );
      },
    });
  };

  const Spacer: React.FunctionComponent<InputToolbarRegistry.IToolbarItemProps> = () =>
    React.createElement("span", {
      className: "jp-ClimateClaw-composerSpacer",
      "aria-hidden": true,
    });

  /**
   * This chat's thread, from the marker its first reply carries. Read at each render: a streaming
   * reply's text grows without a model-level update.
   */
  const threadOf = () =>
    markedThread(
      panel.model.messages.map((m) => ({
        role: m.sender.bot ? "assistant" : "user",
        content: m.body,
      })),
    );

  const Status: React.FunctionComponent<InputToolbarRegistry.IToolbarItemProps> = () => {
    const ref = React.useRef<HTMLSpanElement>(null);
    const tier = useTier(ref);
    const botWriting = (writers: ReadonlyArray<{ user: { bot?: boolean } }>) =>
      writers.some((w) => w.user.bot === true);
    const [writing, setWriting] = React.useState(() => botWriting(panel.model.writers ?? []));
    const [, setTick] = React.useState(0);
    React.useEffect(() => {
      const model = panel.model;
      const onMessages = () => setTick((n) => n + 1);
      const onWriters = (_: unknown, writers: Array<{ user: { bot?: boolean } }>) =>
        setWriting(botWriting(writers));
      const onActivity = () => setTick((n) => n + 1);
      model.messagesUpdated.connect(onMessages);
      model.writersChanged?.connect(onWriters);
      options.activity.changed.connect(onActivity);
      return () => {
        model.messagesUpdated.disconnect(onMessages);
        model.writersChanged?.disconnect(onWriters);
        options.activity.changed.disconnect(onActivity);
      };
    }, []);
    const thread = threadOf();
    const activity: ThreadActivity | null = thread ? options.activity.activity(thread) : null;
    const busy = writing || activity !== null;
    // In ClimateClaw's own panel the chips in the reply go to their cells: no second way here.
    const cells: readonly DkrzCell[] =
      thread && !options.ownPanel ? options.activity.cells(thread) : [];
    const kind = busy ? "busy" : cells.length ? "cells" : "none";
    const label = activity?.label ?? "Thinking";
    const clock = activity ? elapsed(Date.now() - activity.started) : "";
    const [width, setWidth] = React.useState(0);
    const fit = React.useRef<() => void>(() => undefined);
    // The toolbar resizing starts over; any item resizing (a button's label coming back) re-fits.
    React.useEffect(() => {
      const toolbar = ref.current?.parentElement;
      if (!toolbar || typeof ResizeObserver === "undefined") return;
      const resized = new ResizeObserver((entries) => {
        if (entries.some((e) => e.target === toolbar)) {
          setWidth(Math.round(toolbar.clientWidth / 8));
        }
        fit.current();
      });
      const watch = () => {
        resized.disconnect();
        resized.observe(toolbar);
        for (const child of toolbar.children) resized.observe(child);
      };
      const items = new MutationObserver(watch);
      items.observe(toolbar, { childList: true });
      watch();
      return () => {
        resized.disconnect();
        items.disconnect();
      };
    }, []);
    // How much room the status takes from the rest, from none, a step at a time while the row
    // overflows: the jump to the cells first shrinks itself (to the number), then the buttons
    // drop a tier, then show icons alone; ClimateClaw at work keeps its line and takes it from
    // the buttons. Each step renders before the row is measured again.
    const [step, setStep] = React.useState(0);
    const steps = kind === "busy" ? 2 : kind === "cells" ? 3 : 0;
    const stepRef = React.useRef(step);
    stepRef.current = step;
    const stepsRef = React.useRef(steps);
    stepsRef.current = steps;
    const buttons = (kind === "cells" ? Math.max(0, step - 1) : step) as Yield;
    React.useEffect(() => setYields(buttons), [buttons]);
    React.useEffect(() => {
      const toolbar = ref.current?.parentElement;
      let frame = 0;
      let live = true;
      fit.current = () => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          frame = requestAnimationFrame(() => {
            if (!live || !toolbar || stepRef.current >= stepsRef.current) return;
            if (overflows(toolbar)) setStep(stepRef.current + 1);
          });
        });
      };
      return () => {
        live = false;
        cancelAnimationFrame(frame);
      };
    }, []);
    // Another status, or another width: start from full labels again.
    React.useEffect(() => setStep(0), [kind, width]);
    // After every step, and when the line grows (a longer phase, a minute on the clock).
    React.useEffect(() => fit.current(), [step, kind, width, label, clock.length]);
    // A clock while busy: the elapsed time is part of the line.
    React.useEffect(() => {
      if (!busy) return;
      const timer = setInterval(() => setTick((n) => n + 1), 1000);
      return () => clearInterval(timer);
    }, [busy]);
    return React.createElement(
      "span",
      { ref, className: "jp-ClimateClaw-composerItem jp-ClimateClaw-status", "data-tier": tier },
      busy
        ? React.createElement(BusyLine, {
            label,
            phase: activity?.phase ?? "thinking",
            since: activity?.started ?? null,
            tier,
          })
        : cells.length
          ? React.createElement(CellsChip, { cells, tier: step >= 1 ? "narrow" : tier })
          : null,
    );
  };

  /** Speak a message into this input (the browser's speech recognition). */
  const VoiceButton: React.FunctionComponent<InputToolbarRegistry.IToolbarItemProps> = (props) => {
    const input = props.model as { value: string; focus(): void };
    const [listening, setListening] = React.useState(false);
    const dictation = React.useMemo(
      () =>
        new Dictation(
          (text) => {
            input.value = text;
          },
          (on, error) => {
            setListening(on);
            if (!on) input.focus();
            if (error) options.onVoiceError?.(error);
          },
          () => input.value,
        ),
      [input],
    );
    React.useEffect(() => () => dictation.stop(), [dictation]);
    const start = async () => {
      const lang = navigator.language || "en-US";
      const local = await recognisesLocally(lang);
      if (!local && !hasVoiceConsent()) {
        if (!(await options.askVoiceConsent?.())) return;
        rememberVoiceConsent();
      }
      dictation.start(input.value, lang, local);
    };
    return React.createElement(Pill, {
      labels: listening
        ? { wide: "Listening…", medium: null, narrow: null }
        : { wide: null, medium: null, narrow: null },
      tooltip: listening ? "Stop listening" : "Speak your message",
      icon: micIcon,
      className: `jp-ClimateClaw-voice${listening ? " jp-mod-listening" : ""}`,
      look: listening ? "chip" : "icon",
      active: listening,
      pressed: listening,
      onClick: () => (dictation.listening ? dictation.stop() : void start()),
    });
  };

  const elements: Record<
    keyof typeof ITEMS,
    React.FunctionComponent<InputToolbarRegistry.IToolbarItemProps>
  > = {
    climateclawContext: ContextButton,
    climateclawPrompts: PromptsButton,
    climateclawCode: CodeButton,
    climateclawSpacer: Spacer,
    climateclawStatus: Status,
    climateclawModels: ModelsButton,
    climateclawVoice: VoiceButton,
  };
  // Not under a message being edited: context, prompts and the code setting are for the next
  // message, and the status is the reply's.
  for (const [name, position] of Object.entries(ITEMS) as Array<[keyof typeof ITEMS, number]>) {
    // The own panel's new chat shows the examples as cards; slash commands still reach them.
    if (name === "climateclawPrompts" && (options.ownPanel || options.examples.length === 0))
      continue;
    if (name === "climateclawModels" && !options.ownPanel) continue;
    // The own panel shows what ClimateClaw is doing under the reply itself.
    if (name === "climateclawStatus" && options.ownPanel) continue;
    if (name === "climateclawVoice" && (!options.ownPanel || !canDictate())) continue;
    registry.addItem(name, { element: newMessageOnly(elements[name]), position, hidden: true });
  }
  // Stop where Send is, between the microphone and Send; it shows itself while a reply streams.
  if (options.ownPanel) {
    registry.addItem(OWN_STOP, {
      element: newMessageOnly(stopElement(registry, () => panel.model)),
      position: 99.8,
    });
  }

  // Ours replace the paperclip ("Add context" -> "A file…"), and the header's model chip replaces
  // jupyterlite-ai's model picker when every configured provider is a ClimateClaw model.
  const update = () => {
    if (panel.isDisposed) return;
    const ours = isClimateClawChat(panel, options.settings);
    for (const name of Object.keys(ITEMS)) {
      if (!registry.get(name)) continue;
      if (ours) registry.show(name);
      else registry.hide(name);
    }
    if (ours) registry.hide("attach");
    else registry.show("attach");
    const onlyOurs = options.settings.providers.every((p) => p.provider === "climateclaw");
    // In ClimateClaw's own panel its picker beside Send replaces jupyterlite-ai's.
    if (ours && (onlyOurs || options.ownPanel)) registry.hide("model");
    else if (registry.get("model")) registry.show("model");
    if (!ours) options.follower(panel).stop();
    // The chat model's own config, merged. Read by @jupyter/chat from 0.25.1; the 0.25.0 that
    // jupyterlite-ai 0.20.1 bundles keeps its own placeholder. The own panel's Send has no
    // "with selection" menu: "Add context" attaches the active cell.
    panel.model.config = {
      inputPlaceholder: ours ? INPUT_PLACEHOLDER : undefined,
      sendWithSelection: ours && options.ownPanel ? false : undefined,
    };
  };
  options.settings.stateChanged.connect(update);
  whenAgent(panel, (agent) => {
    agent.activeProviderChanged.connect(update);
    update();
  });
  panel.disposed.connect(() => {
    options.settings.stateChanged.disconnect(update);
    agentOf(panel)?.activeProviderChanged.disconnect(update);
  });
}
