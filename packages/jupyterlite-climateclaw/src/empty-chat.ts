// A new chat's page: a greeting with the user's name (one of a set of climate-minded lines, picked
// at random), the site's example questions as cards, and the two latest conversations.

import type { IChatBodyPlaceholderFactory } from "@jupyter/chat";
import * as React from "react";

import type { StoredThreadSummary } from "./api.js";
import type { Example } from "./config.js";
import { threadTime } from "./conversations-model.js";

/** `{name}` is the user's first name. */
export const GREETINGS_WITH_NAME: readonly string[] = [
  "{name} is back! The atmosphere kept busy while you were away.",
  "Welcome back, {name}. Which part of the climate system today?",
  "Good to see you, {name}. The oceans have been storing heat for you.",
  "{name}, the jet stream is meandering. Shall we chase it?",
  "Hello {name}! Ready to find the signal in the noise?",
  "{name}, every grid cell has a story. Pick one.",
  "Back at it, {name}? The reanalysis is still warm.",
  "{name}, from the tropopause to the seafloor: where to?",
  "Hi {name}! Let's turn petabytes into one good plot.",
  "{name}, the ensemble is assembled. What's the question?",
  "Nice to see you, {name}. Clouds, carbon or currents today?",
  "{name}, the HEALPix cells are lined up and waiting.",
];

export const GREETINGS: readonly string[] = [
  "Let's find the signal in the noise.",
  "Which part of the climate system today?",
  "From the tropopause to the seafloor: where to?",
  "Every grid cell has a story. Pick one.",
  "Let's turn petabytes into one good plot.",
];

/** One greeting: with the name when there is one. */
export function pickGreeting(name: string | null, random: () => number = Math.random): string {
  const word = (name ?? "").trim().split(/\s+/)[0] ?? "";
  // Not an account id (k202187) or an e-mail.
  const first = /[\d@]/.test(word) ? "" : word;
  const pool = first ? GREETINGS_WITH_NAME : GREETINGS;
  const line = pool[Math.floor(random() * pool.length) % pool.length]!;
  return line.split("{name}").join(first);
}

type IconName = "data" | "chart" | "map" | "layers" | "notebook" | "compare" | "spark";

const RULES: Array<[IconName, RegExp]> = [
  ["compare", /\b(compare|versus|vs\.?|difference|ensemble)\b/],
  ["layers", /\b(level|levels|zoom|resolution)\b/],
  ["map", /\bmaps?\b/],
  ["chart", /\b(plot|chart|graph|series|trend|means?|average|anomal\w*)\b/],
  ["map", /\b(global|region|healpix|grid)\b/],
  ["notebook", /\b(notebook|cell|explain|code)\b/],
  ["data", /\b(find|search|dataset|data|store|variable)\b/],
];

/** A card's icon, from what the example asks for: its title first, then its question. */
export function iconFor(example: Example): IconName {
  for (const text of [example.title, example.prompt]) {
    const lower = text.toLowerCase();
    for (const [icon, rule] of RULES) if (rule.test(lower)) return icon;
  }
  return "spark";
}

const ICONS: Record<IconName, string> = {
  data: "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zm0 0v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  chart: "M4 19h16M6 16l4-5 3 3 5-7",
  map: "M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2zM9 4v14M15 6v14",
  layers: "M12 3l9 5-9 5-9-5zM3 13l9 5 9-5M3 17.5l9 5 9-5",
  notebook: "M6 3h9l3 3v15H6zM9 9h6M9 13h6M9 17h4",
  compare: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18",
  spark: "M12 3l1.9 5 5 1.9-5 1.9L12 17l-1.9-5.2-5-1.9 5-1.9z",
};

function icon(name: IconName): React.ReactElement {
  return React.createElement(
    "svg",
    {
      viewBox: "0 0 24 24",
      width: 18,
      height: 18,
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.7,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": true,
    },
    React.createElement("path", { d: ICONS[name] }),
  );
}

/** The prompt, short, under its title. */
export function cardHint(prompt: string, max = 64): string {
  const flat = prompt.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).replace(/\s+\S*$/, "")}…`;
}

export interface EmptyChatOptions {
  examples: readonly Example[];
  /** The user's name, when signed in. */
  name: () => string | null;
  /** The latest conversations (none when signed out). */
  recent: () => Promise<StoredThreadSummary[]>;
  openThread: (thread: StoredThreadSummary) => void;
  showHistory: () => void;
}

export function emptyChatFactory(options: EmptyChatOptions): IChatBodyPlaceholderFactory {
  function EmptyChat(props: { onSend: (body: string) => void }): React.ReactElement {
    const [greeting] = React.useState(() => pickGreeting(options.name()));
    const [recent, setRecent] = React.useState<StoredThreadSummary[]>([]);
    React.useEffect(() => {
      let live = true;
      options
        .recent()
        .then((threads) => live && setRecent(threads.slice(0, 2)))
        .catch(() => undefined);
      return () => {
        live = false;
      };
    }, []);
    const cards = options.examples.slice(0, 4).map((example) =>
      React.createElement(
        "button",
        {
          key: example.title,
          type: "button",
          className: "jp-ClimateClaw-promptCard",
          title: example.prompt,
          onClick: () => props.onSend(example.prompt),
        },
        React.createElement(
          "span",
          { className: "jp-ClimateClaw-promptIcon" },
          icon(iconFor(example)),
        ),
        React.createElement(
          "span",
          { className: "jp-ClimateClaw-promptText" },
          React.createElement("strong", null, example.title),
          React.createElement("span", null, cardHint(example.prompt)),
        ),
      ),
    );
    return React.createElement(
      "div",
      { className: "jp-ClimateClaw-emptyChat" },
      React.createElement("h2", { className: "jp-ClimateClaw-greeting" }, greeting),
      cards.length
        ? React.createElement("div", { className: "jp-ClimateClaw-promptCards" }, ...cards)
        : null,
      recent.length
        ? React.createElement(
            "div",
            { className: "jp-ClimateClaw-recent" },
            React.createElement(
              "div",
              { className: "jp-ClimateClaw-recentHead" },
              React.createElement("span", null, "Recent"),
              React.createElement(
                "button",
                { type: "button", onClick: () => options.showHistory() },
                "See all",
              ),
            ),
            ...recent.map((thread) =>
              React.createElement(
                "button",
                {
                  key: thread.threadId,
                  type: "button",
                  className: "jp-ClimateClaw-recentItem",
                  onClick: () => options.openThread(thread),
                },
                React.createElement(
                  "span",
                  { className: "jp-ClimateClaw-recentTopic" },
                  thread.topic,
                ),
                React.createElement(
                  "span",
                  { className: "jp-ClimateClaw-recentTime" },
                  threadTime(thread.date),
                ),
              ),
            ),
          )
        : null,
    );
  }
  return { create: ({ onSend }) => React.createElement(EmptyChat, { onSend }) };
}
