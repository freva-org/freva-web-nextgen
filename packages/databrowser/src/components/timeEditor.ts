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
    class: "date-text",
    type: "text",
    inputmode: "numeric",
    placeholder: "YYYY or YYYY-MM-DD",
    value: current?.from ?? "",
    "aria-label": "From",
  });
  const toInput = el("input", {
    class: "date-text",
    type: "text",
    inputmode: "numeric",
    placeholder: "YYYY or YYYY-MM-DD",
    value: current?.to ?? "",
    "aria-label": "To",
  });

  const errLine = el("div", { class: "err-line" });

  /**
   * An OPTIONAL native calendar beside each text field.
   *
   * The text input stays the source of truth: freva accepts `YYYY`, `YYYY-MM`, full dates,
   * datetimes and open bounds, and `<input type=date>` can represent NONE of those partial forms.
   * Replacing the field would therefore delete capability. So the picker is a side door: choosing a
   * full date writes its ISO value into the text field and runs the SAME validation and live-apply
   * path a typed date does, and a partial or open value in the field is simply left alone.
   */
  const pickerFor = (input: HTMLInputElement, which: "From" | "To"): HTMLElement => {
    const native = el("input", {
      type: "date",
      class: "date-native",
      tabindex: "-1",
      "aria-hidden": "true",
    }) as HTMLInputElement;
    const btn = el(
      "button",
      {
        class: "date-pick",
        type: "button",
        "aria-label": `Choose a ${which.toLowerCase()} date from a calendar`,
        title: `Pick a ${which.toLowerCase()} date`,
      },
      [svgIcon(ICONS.clock, { size: 14 })],
    );
    /** Only a COMPLETE date can be shown in a native picker; anything else leaves it untouched. */
    const syncIntoPicker = (): void => {
      const v = input.value.trim();
      native.value = /^\d{4}-\d{2}-\d{2}$/.test(v) && validPart(v) ? v : "";
    };
    reg.listen(btn, "click", () => {
      syncIntoPicker();
      // showPicker() must be called from the user's own gesture - which this is. Where it is
      // missing (older Safari, Firefox before 101), focusing/clicking the native input is the
      // documented fallback and still opens the platform calendar.
      const withPicker = native as HTMLInputElement & { showPicker?: () => void };
      if (typeof withPicker.showPicker === "function") {
        try {
          withPicker.showPicker();
          return;
        } catch {
          /* NotAllowedError outside a user gesture - fall through to the manual route */
        }
      }
      native.focus();
      native.click();
    });
    reg.listen(native, "change", () => {
      if (!native.value) return; // cleared in the picker - leave whatever the user typed
      input.value = native.value; // ISO YYYY-MM-DD, exactly what the text field already accepts
      refresh();
      applyLive();
    });
    reg.listen(input, "change", syncIntoPicker);
    syncIntoPicker();
    return el("span", { class: "date-pickwrap" }, [btn, native]);
  };

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
    el("div", { class: "daterow" }, [
      el("label", { text: "From" }),
      fromInput,
      pickerFor(fromInput, "From"),
    ]),
    el("div", { class: "daterow" }, [
      el("label", { text: "To" }),
      toInput,
      pickerFor(toInput, "To"),
    ]),
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
