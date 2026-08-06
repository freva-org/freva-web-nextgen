// components/timeEditor.ts - the Time-range popover. Inputs are VALIDATED TEXT, not native
// <input type=date>, so partial precision (YYYY, YYYY-MM) and datetimes survive. The live
// preview matches exactly what is sent: UNBRACKETED `time=<from> TO <to>&time_select=<mode>`.
//
// The strict/file semantics (shared with bbox) are unverified against the backend; only
// `flexible` is confirmed.
// TODO(verify V4): index a fixture (extent 0,5,0,5), query a range, observe strict vs file
// inclusion against the backend, then write directional help from the OBSERVED result.

import type { AppContext } from "../context.js";
import type { Disposables } from "../dom.js";
import { el, svgIcon } from "../dom.js";
import { ICONS } from "../icons.js";
import type { SelectMode } from "../types.js";
import { validTimeBound, timeBoundKey, isOpenBound } from "../state.js";

/** Exported for unit tests: is `v` an acceptable (possibly partial-precision) time bound?
 *  Delegates to the shared validator so the editor and the terminal agree (real calendar). */
export function validPart(v: string): boolean {
  return validTimeBound(v);
}
/** Both bounds valid AND in order (from ≤ to). Open bounds always order. */
function validRange(from: string, to: string): boolean {
  if (!validTimeBound(from) || !validTimeBound(to)) return false;
  if (isOpenBound(from) || isOpenBound(to)) return true;
  return timeBoundKey(from) <= timeBoundKey(to);
}

const HELP: Record<SelectMode, string> = {
  flexible: "Any overlap between your range and the file’s period (intersects).",
  strict: "Containment match - sent to the backend as time_select=strict.",
  file: "File-relative containment - sent as time_select=file.",
};

/**
 * @param inline  Overview-card mode: no Apply/Cancel row (a card has no room for one) - a valid
 *                change applies LIVE, the way a facet click does.
 */
export function buildTimeEditor(
  ctx: AppContext,
  reg: Disposables,
  done: () => void,
  inline = false,
): HTMLElement {
  const current = ctx.state.time;
  let mode: SelectMode = current?.mode ?? "flexible";
  const fromInput = el("input", {
    type: "text",
    inputmode: "numeric",
    placeholder: "YYYY or YYYY-MM-DD",
    value: current?.from ?? "",
    "aria-label": "From",
  });
  const toInput = el("input", {
    type: "text",
    inputmode: "numeric",
    placeholder: "YYYY or YYYY-MM-DD",
    value: current?.to ?? "",
    "aria-label": "To",
  });

  const errLine = el("div", { class: "err-line" });

  const modeButtons: HTMLButtonElement[] = (["flexible", "strict", "file"] as SelectMode[]).map(
    (m) => {
      // Reference parity: all three modes always selectable, passed through as time_select.
      const btn = el("button", {
        type: "button",
        class: m === mode ? "on" : "",
        title: HELP[m],
        text: m,
      });
      reg.listen(btn, "click", () => {
        mode = m;
        for (const b of modeButtons) b.classList.toggle("on", b === btn);
        refresh();
        applyLive();
      });
      return btn;
    },
  );

  const isValid = (): boolean => validRange(fromInput.value.trim(), toInput.value.trim());

  function refresh(): void {
    const fromOk = validPart(fromInput.value);
    const toOk = validPart(toInput.value);
    fromInput.classList.toggle("bad", !fromOk);
    toInput.classList.toggle("bad", !toOk);
    const ordered = fromOk && toOk && isValid();
    errLine.textContent =
      !fromOk || !toOk
        ? "Use YYYY, YYYY-MM, YYYY-MM-DD or a datetime."
        : ordered
          ? ""
          : "The start is after the end.";
  }

  reg.listen(fromInput, "input", refresh);
  reg.listen(toInput, "input", refresh);

  // Apply LIVE (both the popover and the overview card): a valid edit takes effect immediately, so
  // there is no Apply button to hunt for; an invalid/half-typed range simply waits (the field reddens
  // and errLine explains). Clearing both fields removes the constraint.
  const applyLive = (): void => {
    const from = fromInput.value.trim();
    const to = toInput.value.trim();
    if (!from && !to) {
      ctx.setTime(null);
      return;
    }
    if (isValid()) ctx.setTime({ from, to, mode });
  };
  reg.listen(fromInput, "change", applyLive);
  reg.listen(toInput, "change", applyLive);

  const clear = el("button", { class: "btn", type: "button", text: "Clear" });
  reg.listen(clear, "click", () => {
    done();
    ctx.setTime(null);
  });

  const editor = el("div", { class: `editor${inline ? " inline" : ""}` }, [
    el("h5", {}, [
      svgIcon(ICONS.clock, { size: 16 }),
      el("span", { text: "Time range" }),
      el("span", { class: "sub", text: "time_select" }),
    ]),
    el("div", { class: "daterow" }, [el("label", { text: "From" }), fromInput]),
    el("div", { class: "daterow" }, [el("label", { text: "To" }), toInput]),
    el("div", { class: "modes" }, modeButtons),
    errLine,
    ...(inline ? [] : [el("div", { class: "actions" }, [clear])]),
  ]);
  refresh();
  return editor;
}

export function openTimeEditor(ctx: AppContext, anchor: HTMLElement): void {
  const reg = ctx.region("popover");
  const editor = buildTimeEditor(ctx, reg, () => ctx.popover.close());
  ctx.popover.open(anchor, editor, {
    placement: "right",
    className: "editor-pop",
    autoFocus: true,
    // committing a time range re-renders the sidebar; keep the editor anchored to the rebuilt row
    reanchor: () =>
      ctx.roots.facetList.querySelector<HTMLElement>('.special[aria-label="Edit time range"]'),
  });
}
