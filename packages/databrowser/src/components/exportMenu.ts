// components/exportMenu.ts - THE export menu, rendered once and used by both places that offer one.
//
// The two places that offer one - the whole-result Export button and the pickbar's selected-files
// Download button - share this renderer rather than each carrying their own. Two near-identical
// implementations drift, and they drift presentationally first: a PRIMARY label styled with
// `.desc`, the package's faint 11px caption style, beside a secondary `.sub` span with no styling
// at all, runs inline as "Intake catalogueintake-esm JSON for the whole result set" in one small
// grey run.
//
// The guarantee is structural rather than cosmetic: one renderer, one markup contract, and the
// SCOPE stated once in a heading instead of repeated in every row ("…for the whole result set",
// three times, in the smallest text on screen).
//
// Nothing about WHAT is exported lives here. URL construction, streaming, the 413/414 handling, the
// catalogue ceiling and the selection cap all stay with their callers; this module owns the menu.

import { el, svgIcon, type Disposables } from "../dom.js";
import { brandIcon } from "../brand.js";
import { ICONS } from "../icons.js";

export type ExportKind = "intake" | "stac" | "uris";

/**
 * The three formats, described ONCE. Callers choose the scope wording; they do not restate what an
 * intake catalogue is.
 */
export const EXPORT_OPTIONS: ReadonlyArray<{
  kind: ExportKind;
  label: string;
  desc: string;
  /** Short marker in its own column - what lands on disk. */
  format: string;
  icon: () => Node;
}> = [
  {
    kind: "intake",
    label: "Intake catalogue",
    desc: "intake-esm JSON",
    format: "JSON",
    icon: () => brandIcon("intake", { size: 16 }),
  },
  {
    kind: "stac",
    label: "STAC catalogue",
    desc: "STAC ZIP",
    format: "ZIP",
    icon: () => brandIcon("stac", { size: 16 }),
  },
  {
    kind: "uris",
    label: "URI manifest",
    desc: "plain-text URI list",
    format: "TXT",
    icon: () => svgIcon(ICONS.uris, { size: 16 }),
  },
];

export interface ExportMenuOptions {
  /**
   * The scope, stated once at the top: "Export all 120 results" / "Export 8 selected files".
   * Non-interactive and skipped by keyboard navigation - it is a label, not a choice.
   */
  heading: string;
  onPick: (kind: ExportKind) => void;
  /** Extra rows appended after the three formats (the pickbar's remote-files submenu entry). */
  extra?: HTMLElement[];
}

/** One option row: fixed icon column, prominent label, muted description on its own line, marker. */
export function exportMenuItem(opts: {
  icon: Node;
  label: string;
  desc: string;
  format?: string;
  onPick: () => void;
  reg: Disposables;
}): HTMLButtonElement {
  const btn = el("button", { class: "xm-item", type: "button", role: "menuitem" }, [
    el("span", { class: "xm-ic", "aria-hidden": "true" }, [opts.icon]),
    el("span", { class: "xm-text" }, [
      el("span", { class: "xm-label", text: opts.label }),
      el("span", { class: "xm-desc", text: opts.desc }),
    ]),
    opts.format ? el("span", { class: "xm-fmt", "aria-hidden": "true", text: opts.format }) : null,
  ]);
  // The visible label reads "Intake catalogue / intake-esm JSON / JSON"; the accessible name says
  // the same thing in one breath rather than three fragments.
  btn.setAttribute("aria-label", `${opts.label} - ${opts.desc}`);
  opts.reg.listen(btn, "click", opts.onPick);
  return btn;
}

/**
 * Build the menu body. Returns the nodes to hand to `popover.open()`.
 *
 * Roles: the wrapper is a `menu` whose children are `menuitem`s, and Up/Down/Home/End move between
 * them. Escape and outside-click closing stay with the PopoverManager, which owns them for every
 * popover in the component.
 */
export function exportMenu(reg: Disposables, opts: ExportMenuOptions): HTMLElement[] {
  const items = EXPORT_OPTIONS.map((o) =>
    exportMenuItem({
      icon: o.icon(),
      label: o.label,
      desc: o.desc,
      format: o.format,
      onPick: () => opts.onPick(o.kind),
      reg,
    }),
  );
  const all: HTMLElement[] = [...items, ...(opts.extra ?? [])];
  const menu = el("div", { class: "xm", role: "menu", "aria-label": opts.heading }, all);

  reg.listen(menu, "keydown", (e) => {
    const ke = e as KeyboardEvent;
    const focusable = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    if (!focusable.length) return;
    const i = focusable.indexOf(document.activeElement as HTMLElement);
    const go = (n: number): void => {
      ke.preventDefault();
      focusable[Math.max(0, Math.min(focusable.length - 1, n))]?.focus();
    };
    if (ke.key === "ArrowDown") go(i < 0 ? 0 : i + 1);
    else if (ke.key === "ArrowUp") go(i < 0 ? focusable.length - 1 : i - 1);
    else if (ke.key === "Home") go(0);
    else if (ke.key === "End") go(focusable.length - 1);
  });

  return [el("div", { class: "xm-head", role: "presentation", text: opts.heading }), menu];
}

/** "Export all 120 results" / "Export 1 result". */
export function wholeResultHeading(total: number): string {
  return `Export all ${total.toLocaleString("en-US")} result${total === 1 ? "" : "s"}`;
}

/** "Export 8 selected files" / "Export 1 selected file". */
export function selectionHeading(count: number): string {
  return `Export ${count.toLocaleString("en-US")} selected file${count === 1 ? "" : "s"}`;
}
