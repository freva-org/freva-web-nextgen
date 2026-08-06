// components/chips.ts - selected-value chips (key=value, ✕ removes one), plus time/bbox
// geo chips, and the Clear-all show/hide. Every label goes in via textContent so a
// hostile facet value / path renders inert.

import type { AppContext } from "../context.js";
import { el, replaceChildren, svgIcon, type Disposables } from "../dom.js";
import { ICONS } from "../icons.js";
import { hasAnySelection, isGatedKey } from "../state.js";

// no module-level Disposables: the region bucket is passed explicitly per render.
function chip(
  reg: Disposables,
  label: string,
  onRemove: () => void,
  geo = false,
  tag?: string,
): HTMLButtonElement {
  const inner: (Node | string | false)[] = [el("span", { text: label })];
  if (tag) inner.push(el("span", { class: "chip-tag", text: tag })); // e.g. the select mode - no `·`
  inner.push(el("span", { class: "x" }, [svgIcon(ICONS.x, { size: 12 })]));
  const btn = el(
    "button",
    { class: `chip${geo ? " geo" : ""}`, type: "button", "aria-label": `Remove ${label}` },
    inner,
  );
  reg.listen(btn, "click", onRemove);
  return btn;
}

export function renderChips(ctx: AppContext): void {
  const reg = ctx.region("chips");
  const host = ctx.roots.chips;
  const nodes: HTMLElement[] = [];

  for (const key of Object.keys(ctx.state.selected)) {
    if (isGatedKey(ctx.state, key)) continue; // the base scope never shows as a removable chip
    for (const value of ctx.state.selected[key]) {
      nodes.push(chip(reg, `${key}=${value}`, () => ctx.toggleFacet(key, value)));
    }
  }

  const t = ctx.state.time;
  if (t) {
    nodes.push(chip(reg, `time ${t.from} → ${t.to}`, () => ctx.setTime(null), true, t.mode));
  }

  const b = ctx.state.bbox;
  if (b) {
    const label = `bbox ${b.minLon},${b.maxLon},${b.minLat},${b.maxLat}`;
    nodes.push(chip(reg, label, () => ctx.setBbox(null), true, b.mode));
  }

  replaceChildren(host, ...nodes);
  ctx.roots.clearAllBtn.classList.toggle("show", hasAnySelection(ctx.state));
}
