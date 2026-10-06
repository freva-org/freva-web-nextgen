// The model picker beside Send in ClimateClaw's own panel: the model this chat talks to, in a
// popover of sections (each a title, a hint and its choices). Run at DKRZ chooses its own model in
// its toolbar menu.

import { el, openPopover } from "./popover.js";

export interface ModelChoice {
  /** What is chosen (a provider entry's id for the chat, a model name for Run at DKRZ). */
  value: string;
  label: string;
}

export interface PickerSection {
  title: string;
  hint: string;
  choices: ModelChoice[];
  current: string;
  choose(value: string): void;
}

export function openModelPicker(anchor: HTMLElement, sections: PickerSection[], note: string) {
  const card = el("div", "jp-ClimateClaw-modelPicker");
  for (const section of sections) {
    const group = el("div", "jp-ClimateClaw-modelGroup");
    group.setAttribute("role", "group");
    const heading = el("div", "jp-ClimateClaw-modelGroupTitle", section.title);
    heading.id = `climateclaw-models-${section.title.replace(/\W+/g, "-").toLowerCase()}`;
    group.setAttribute("aria-labelledby", heading.id);
    group.append(heading, el("div", "jp-ClimateClaw-modelGroupHint", section.hint));
    if (section.choices.length === 0) {
      group.append(el("div", "jp-ClimateClaw-modelEmpty", "Sign in to see the models."));
    }
    for (const choice of section.choices) {
      const option = el("button", "jp-ClimateClaw-modelOption");
      option.type = "button";
      option.setAttribute("role", "menuitemradio");
      const on = choice.value === section.current;
      option.setAttribute("aria-checked", String(on));
      if (on) option.classList.add("jp-mod-selected");
      option.append(
        el("span", "jp-ClimateClaw-modelCheck", on ? "✓" : ""),
        el("span", "jp-ClimateClaw-modelName", choice.label),
      );
      option.addEventListener("click", () => {
        section.choose(choice.value);
        popover.close();
        anchor.focus();
      });
      group.append(option);
    }
    card.append(group);
  }
  if (note) card.append(el("p", "jp-ClimateClaw-modelNote", note));
  const popover = openPopover(anchor, card, {
    label: "Models",
    className: "jp-ClimateClaw-modelPopover",
    align: "end",
    above: true,
  });
  card.querySelector<HTMLButtonElement>(".jp-mod-selected, .jp-ClimateClaw-modelOption")?.focus();
  return popover;
}
