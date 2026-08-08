// components/chips.ts - selected-value chips (✕ removes one), plus time/bbox geo chips, the
// immutable base-scope indicators, and the Clear-all show/hide. Every label goes in via textContent
// so a hostile facet value / path renders inert.
//
// A chip's text lives in a `.chip-label` wrapper with a bounded inline size and an ellipsis. Without
// it, one unbroken value (a long ensemble id, a deep path) stretches its chip past the available
// width on a phone and pushes Clear all and the Browse/Overview cluster off screen.

import type { AppContext } from "../context.js";
import { el, replaceChildren, svgIcon, type Disposables } from "../dom.js";
import { ICONS } from "../icons.js";
import { baseScopeExclusions, hasAnySelection, isGatedKey, parseFacetKey } from "../state.js";

// no module-level Disposables: the region bucket is passed explicitly per render.
function chip(
  reg: Disposables,
  label: string,
  onRemove: () => void,
  opts: {
    geo?: boolean;
    tag?: string;
    negative?: boolean;
    title?: string;
    /** Split label, so ONLY the value can be struck through - not the facet name or the operator. */
    parts?: { key: string; op: string; value: string };
  } = {},
): HTMLButtonElement {
  const inner: (Node | string | false)[] = opts.parts
    ? [
        el("span", { class: "chip-label" }, [
          el("span", { class: "chip-k", text: opts.parts.key }),
          el("span", { class: "chip-op", text: ` ${opts.parts.op} ` }),
          el("span", { class: "chip-v", text: opts.parts.value, title: opts.title ?? label }),
        ]),
      ]
    : [
        // The full value stays reachable as a tooltip + accessible name even when the visible text
        // is ellipsised, so truncation never hides which filter a chip actually removes.
        el("span", { class: "chip-label", text: label, title: opts.title ?? label }),
      ];
  if (opts.tag) inner.push(el("span", { class: "chip-tag", text: opts.tag })); // e.g. the select mode
  inner.push(el("span", { class: "x" }, [svgIcon(ICONS.x, { size: 12 })]));
  const btn = el(
    "button",
    {
      class: `chip${opts.geo ? " geo" : ""}${opts.negative ? " neg" : ""}`,
      type: "button",
      "aria-label": `Remove ${opts.title ?? label}`,
    },
    inner,
  );
  reg.listen(btn, "click", onRemove);
  return btn;
}

/** A base-scope constraint the user cannot remove - rendered as text, never as a removable chip. */
function scopeChip(label: string, title: string): HTMLElement {
  return el("span", {
    class: "chip scope",
    role: "note",
    text: label,
    title,
    "aria-label": title,
  });
}

export function renderChips(ctx: AppContext): void {
  const reg = ctx.region("chips");
  const host = ctx.roots.chips;
  const nodes: HTMLElement[] = [];

  // A base-EXCLUDED value never comes back in the facet list, so there is no row to show as locked.
  // Say it plainly instead, and note that Clear all does not touch it.
  for (const [key, value] of baseScopeExclusions(ctx.state)) {
    nodes.push(
      scopeChip(
        `Scope: ${key} ≠ ${value}`,
        `This instance always excludes ${key} = ${value}. It cannot be removed.`,
      ),
    );
  }

  for (const key of Object.keys(ctx.state.selected)) {
    if (isGatedKey(ctx.state, key)) continue; // the base scope never shows as a removable chip
    const { baseKey, negated } = parseFacetKey(key);
    for (const value of ctx.state.selected[key]) {
      // `≠` plus a `NOT` tag plus a distinct shape - never colour alone. An excluded value can
      // disappear from the server's returned facets entirely, so this chip is the stable way to
      // see and remove the exclusion.
      const label = negated ? `${baseKey} ≠ ${value}` : `${key}=${value}`;
      nodes.push(
        chip(
          reg,
          label,
          () => (negated ? ctx.excludeFacet(baseKey, value) : ctx.toggleFacet(key, value)),
          {
            negative: negated,
            tag: negated ? "NOT" : undefined,
            // Only the VALUE is struck through: the facet name still has to be readable, and so do
            // the two things that say what is happening to it.
            ...(negated ? { parts: { key: baseKey, op: "≠", value } } : {}),
          },
        ),
      );
    }
  }

  const t = ctx.state.time;
  if (t) {
    nodes.push(
      chip(reg, `time ${t.from} → ${t.to}`, () => ctx.setTime(null), {
        geo: true,
        tag: t.mode,
      }),
    );
  }

  const b = ctx.state.bbox;
  if (b) {
    const label = `bbox ${b.minLon},${b.maxLon},${b.minLat},${b.maxLat}`;
    nodes.push(chip(reg, label, () => ctx.setBbox(null), { geo: true, tag: b.mode }));
  }

  replaceChildren(host, ...nodes);
  // An empty chip row must not leave a blank strip in the top row on a phone.
  host.classList.toggle("empty", nodes.length === 0);
  ctx.roots.clearAllBtn.classList.toggle("show", hasAnySelection(ctx.state));
}
