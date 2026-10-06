// Stop, where Send is, in ClimateClaw's own panel. While a reply streams and the box is empty,
// Stop takes Send's place; once the visitor types the next message, Send comes back and a
// smaller Stop sits beside it. Otherwise only Send shows.

import { TooltippedButton, type InputToolbarRegistry } from "@jupyter/chat";
import * as React from "react";

import { stopIcon } from "./icons.js";
import { hasInput, placeSend, stopPlace, type SendRegistry } from "./stop-place.js";

interface Writers {
  writers?: ReadonlyArray<{ user: { bot?: boolean } }>;
  writersChanged?: {
    connect(fn: (sender: unknown, writers: Array<{ user: { bot?: boolean } }>) => void): unknown;
    disconnect(fn: (sender: unknown, writers: Array<{ user: { bot?: boolean } }>) => void): unknown;
  };
  stopStreaming?: () => void;
}

const botWriting = (writers: ReadonlyArray<{ user: { bot?: boolean } }>) =>
  writers.some((w) => w.user.bot === true);

const TIP = "Stop the reply";

/** Stops the reply. The persona's abort rethrows its own AbortError: the stop, not a fault. */
function stop(chat: Writers): void {
  try {
    chat.stopStreaming?.();
  } catch (error) {
    if ((error as { name?: string } | null)?.name !== "AbortError") throw error;
  }
}

const ROUND = { minWidth: 0, padding: 0, borderRadius: "50%", boxShadow: "none" };
const SX = {
  send: {
    ...ROUND,
    width: "34px",
    height: "34px",
    backgroundColor: "var(--jp-brand-color1)",
    color: "#fff",
    "&:hover": {
      boxShadow: "none",
      backgroundColor: "color-mix(in srgb, var(--jp-brand-color1) 85%, #000)",
    },
  },
  beside: {
    ...ROUND,
    width: "30px",
    height: "30px",
    border: "1px solid var(--jp-border-color1)",
    backgroundColor: "transparent",
    color: "var(--jp-ui-font-color1)",
    "&:hover": { boxShadow: "none", backgroundColor: "var(--jp-layout-color2)" },
  },
} as const;

/** The toolbar item: `registry` is the chat's own, whose Send it moves aside. */
export function stopElement(
  registry: SendRegistry,
  fallback: () => Writers,
): React.FunctionComponent<InputToolbarRegistry.IToolbarItemProps> {
  return (props) => {
    const input = props.model;
    const chat = (props.chatModel ?? fallback()) as Writers;
    const [streaming, setStreaming] = React.useState(() => botWriting(chat.writers ?? []));
    const [typed, setTyped] = React.useState(() => hasInput(input));
    React.useEffect(() => {
      const onWriters = (_: unknown, writers: Array<{ user: { bot?: boolean } }>) =>
        setStreaming(botWriting(writers));
      const onInput = () => setTyped(hasInput(input));
      chat.writersChanged?.connect(onWriters);
      input.valueChanged.connect(onInput);
      input.attachmentsChanged?.connect(onInput);
      setStreaming(botWriting(chat.writers ?? []));
      onInput();
      return () => {
        chat.writersChanged?.disconnect(onWriters);
        input.valueChanged.disconnect(onInput);
        input.attachmentsChanged?.disconnect(onInput);
      };
    }, [chat, input]);
    const place = stopPlace(streaming, typed);
    React.useEffect(() => placeSend(registry, place), [place]);
    // Send is never left hidden by a Stop that is gone.
    React.useEffect(() => () => placeSend(registry, "none"), []);
    if (place === "none") return null;
    return React.createElement(
      "span",
      { className: "jp-ClimateClaw-stop", "data-place": place },
      React.createElement(TooltippedButton, {
        onClick: () => stop(chat),
        tooltip: TIP,
        inputToolbar: false,
        // Over @jupyter/chat's theme (24px squares): Send's size and colour in its place, a
        // quieter outlined circle beside it.
        sx: place === "send" ? SX.send : SX.beside,
        buttonProps: {
          title: TIP,
          "aria-label": TIP,
          className: "jp-ClimateClaw-stopButton",
        },
        children: React.createElement(stopIcon.react, { tag: "span" }),
      }),
    );
  };
}
