// Small pieces of UI: the blocked-popup notice and menus opened from a toolbar button. Built
// with DOM APIs and textContent; nothing here touches the chat panel.

import { Dialog, showDialog } from "@jupyterlab/apputils";
import type { CommandRegistry } from "@lumino/commands";
import { Menu, Widget } from "@lumino/widgets";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

/** "Allow pop-ups or open the login in a new tab", with the link. Never navigates this tab. */
export function showPopupBlocked(retry: () => void): void {
  const body = new Widget();
  body.addClass("jp-ClimateClaw-blocked");
  body.node.append(
    el(
      "p",
      "The browser blocked the Freva sign-in window. Allow pop-ups for this site, or open the login in a new tab; this tab stays where it is.",
    ),
  );
  const link = el("a", "Open the Freva login in a new tab");
  link.href = "#";
  link.className = "jp-ClimateClaw-blocked-link";
  // Opened from this click (a user gesture browsers allow), as the sign-in window of this tab.
  link.addEventListener("click", (event) => {
    event.preventDefault();
    retry();
  });
  const paragraph = el("p");
  paragraph.append(link);
  body.node.append(paragraph);
  void showDialog({
    title: "Allow pop-ups or open the login in a new tab",
    body,
    buttons: [Dialog.okButton({ label: "Close" })],
  });
}

/** Open a menu under the toolbar button that was just pressed. */
export function openMenuAtActiveElement(menu: Menu): void {
  const anchor = document.activeElement as HTMLElement | null;
  const rect = anchor?.getBoundingClientRect();
  if (rect && rect.width > 0) menu.open(rect.left, rect.bottom);
  else menu.open(window.innerWidth / 2, window.innerHeight / 3);
}

export function menuFor(commands: CommandRegistry, className: string): Menu {
  const menu = new Menu({ commands });
  menu.addClass(className);
  return menu;
}
