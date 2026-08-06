// components/console.ts - the status FOOTER line + auto-dismissing toasts.
//
// There is no expandable event log: every activity lands on the one footer line with a severity
// colour (info/ok green · warn yellow · error red), each message overriding the previous. Toasts
// show a transient outcome and leave. Text reaches the DOM via textContent.

import type { AppContext, LogSeverity } from "../context.js";
import { el, svgIcon } from "../dom.js";
import { ICONS } from "../icons.js";

export interface ConsoleController {
  log(severity: LogSeverity, message: string): void;
  toast(severity: LogSeverity, message: string): void;
}

const TOAST_MS = 4200;

export function createConsole(ctx: AppContext): ConsoleController {
  const dis = ctx.dis;
  const { statusDot, statusMsg, toastHost } = ctx.roots;

  // The one-line footer: latest event wins, coloured by severity. No buffer, so it can never lag.
  function push(severity: LogSeverity, message: string): void {
    statusDot.className = `status-dot ${severity}`;
    statusMsg.className = `mono status-msg ${severity}`;
    statusMsg.textContent = message;
  }

  function toast(severity: LogSeverity, message: string): void {
    push(severity, message); // the footer always reflects the latest, toast or not
    const t = el("div", { class: `toast ${severity}`, role: "status" }, [
      svgIcon(ICONS.info, { size: 15 }),
      el("span", { class: "toast-msg", text: message }),
    ]);
    toastHost.append(t);
    dis.setTimeout(() => t.classList.add("in"), 10);
    let offClick = (): void => {};
    const remove = (): void => {
      offClick();
      t.classList.remove("in");
      dis.setTimeout(() => t.remove(), 220);
    };
    dis.setTimeout(remove, TOAST_MS);
    offClick = dis.listen(t, "click", remove);
  }

  return { log: push, toast };
}
