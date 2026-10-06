// What ClimateClaw is doing while it replies: a pill in jupyterlite-ai's composer, and in
// ClimateClaw's own panel a line at the end of the reply being written, where chat apps show it.

import * as React from "react";

import { elapsed, type ActivityStore } from "./activity.js";
import { dkrzRunningUrl, reducedMotion } from "./dkrz-logo.js";
import { LOGO_DATA_URL } from "./logo.js";
import type { Tier } from "./tiers.js";

/**
 * ClimateClaw at work: a mark for what it is doing, what that is over a moving sheen, and for how
 * long. Thinking: the logo bobbing like a pigeon pecking (a travelling wave in the conversation);
 * writing code: lines of code being typed; running it at DKRZ: DKRZ's turning logo; drawing a
 * figure: a pen plotting a curve on a small chart. Wide: all three; medium: no clock; narrow: the
 * mark alone (its tooltip says the rest). Still, for whoever asked their system for less motion.
 */
export function BusyLine(props: {
  label: string;
  phase: string;
  since: number | null;
  tier: Tier;
  /** In the conversation, under the reply being written (not a pill). */
  inline?: boolean;
}): React.JSX.Element {
  const time = props.since !== null ? elapsed(Date.now() - props.since) : "";
  const title = time ? `${props.label} · ${time}` : props.label;
  return React.createElement(
    "span",
    {
      className: `jp-ClimateClaw-busy${props.inline ? " jp-mod-inline" : ""}`,
      "data-phase": props.phase,
      role: "status",
      "aria-live": "polite",
      title,
    },
    props.phase === "coding"
      ? typing()
      : props.phase === "figure"
        ? plotting()
        : props.phase === "running"
          ? React.createElement("img", {
              className: "jp-ClimateClaw-busy-dkrz",
              src: dkrzRunningUrl(),
              alt: "",
              "aria-hidden": true,
            })
          : props.inline
            ? wave()
            : React.createElement("img", {
                className: "jp-ClimateClaw-busy-bird",
                src: LOGO_DATA_URL,
                alt: "",
                "aria-hidden": true,
              }),
    props.tier === "narrow"
      ? React.createElement("span", { className: "jp-ClimateClaw-visuallyHidden" }, props.label)
      : React.createElement("span", { className: "jp-ClimateClaw-busy-label" }, props.label),
    props.tier === "wide" && time
      ? React.createElement("span", { className: "jp-ClimateClaw-busy-time" }, time)
      : null,
  );
}

/** Code being written: three lines typed one after the other, and a blinking caret. */
function typing(): React.JSX.Element {
  const line = (y: number, length: number, delay: string) =>
    React.createElement("path", {
      className: "jp-ClimateClaw-busy-codeLine",
      d: `M8 ${y} h${length}`,
      style: { animationDelay: delay },
    });
  return React.createElement(
    "svg",
    {
      className: "jp-ClimateClaw-busy-code",
      viewBox: "0 0 24 16",
      width: 24,
      height: 16,
      "aria-hidden": true,
    },
    React.createElement("path", {
      className: "jp-ClimateClaw-busy-codeBracket",
      d: "M5 3 L1.5 8 L5 13",
    }),
    line(4, 10, "0s"),
    line(8, 14, "0.35s"),
    line(12, 7, "0.7s"),
    React.createElement("rect", {
      className: "jp-ClimateClaw-busy-caret",
      x: 21,
      y: 9.5,
      width: 1.6,
      height: 5,
      rx: 0.4,
    }),
  );
}

/** The curve the pen plots on the small chart (with less motion: the finished plot). */
const CURVE = "M4 12 C7 12 7.5 5 10.5 6 S14.5 11.5 17 8.5 S20 3 22.5 3";

/** A figure being drawn: axes, a curve plotted left to right and the pen at its tip. */
function plotting(): React.JSX.Element {
  const still = reducedMotion();
  return React.createElement(
    "svg",
    {
      className: "jp-ClimateClaw-busy-plot",
      viewBox: "0 0 24 16",
      width: 24,
      height: 16,
      "aria-hidden": true,
    },
    React.createElement("path", {
      className: "jp-ClimateClaw-busy-plotAxes",
      d: "M2 1.5 V14.5 H23",
    }),
    React.createElement("path", {
      className: "jp-ClimateClaw-busy-plotCurve",
      d: CURVE,
      pathLength: 30,
    }),
    React.createElement(
      "circle",
      {
        className: "jp-ClimateClaw-busy-plotPen",
        r: 1.7,
        ...(still ? { cx: 22.5, cy: 3 } : {}),
      },
      still
        ? null
        : React.createElement("animateMotion", {
            dur: "1.8s",
            repeatCount: "indefinite",
            path: CURVE,
            keyPoints: "0;1;1",
            keyTimes: "0;0.7;1",
            calcMode: "linear",
          }),
    ),
  );
}

/** A small travelling wave: the line's mark in the conversation. */
function wave(): React.JSX.Element {
  return React.createElement(
    "svg",
    {
      className: "jp-ClimateClaw-busy-wave",
      viewBox: "0 0 24 12",
      width: 24,
      height: 12,
      "aria-hidden": true,
    },
    React.createElement("path", {
      d: "M0 6 Q3 0 6 6 T12 6 T18 6 T24 6",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.8,
      strokeLinecap: "round",
    }),
  );
}

/** The line under a reply in progress: the thread's phase, or Thinking before it has one. */
export function ReplyActivity(props: {
  activity: ActivityStore;
  thread: string | null;
}): React.JSX.Element {
  const [, setTick] = React.useState(0);
  const [mounted] = React.useState(() => Date.now());
  React.useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    props.activity.changed.connect(bump);
    const timer = setInterval(bump, 1000);
    return () => {
      props.activity.changed.disconnect(bump);
      clearInterval(timer);
    };
  }, [props.activity]);
  const now = props.thread ? props.activity.activity(props.thread) : null;
  return React.createElement(BusyLine, {
    label: now?.label ?? "Thinking",
    phase: now?.phase ?? "thinking",
    since: now?.started ?? mounted,
    tier: "wide",
    inline: true,
  });
}
