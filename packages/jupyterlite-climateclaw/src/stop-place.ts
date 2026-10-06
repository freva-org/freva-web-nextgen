// Where Stop is in ClimateClaw's own panel, and what that does to Send (see stop-button.ts).

import type { InputToolbarRegistry } from "@jupyter/chat";

/** Where Stop is: not shown, in Send's place, or beside Send. */
export type StopPlace = "none" | "send" | "beside";

export function stopPlace(streaming: boolean, typed: boolean): StopPlace {
  if (!streaming) return "none";
  return typed ? "beside" : "send";
}

/** Something to send: text or an attachment, as Send itself decides. */
export function hasInput(input: { value: string; attachments?: readonly unknown[] }): boolean {
  return Boolean(input.value.trim()) || (input.attachments?.length ?? 0) > 0;
}

export type SendRegistry = Pick<InputToolbarRegistry, "get" | "show" | "hide">;

/** Hides Send while Stop is in its place, shows it otherwise; touches it only on a change. */
export function placeSend(registry: SendRegistry, place: StopPlace): void {
  const item = registry.get("send");
  if (!item) return;
  const hidden = place === "send";
  if (Boolean(item.hidden) === hidden) return;
  if (hidden) registry.hide("send");
  else registry.show("send");
}
