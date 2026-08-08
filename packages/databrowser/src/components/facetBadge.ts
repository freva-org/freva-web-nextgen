// components/facetBadge.ts - the per-facet `+N` / `-N` clear controls.
//
// WHY THIS EXISTS. A facet can be narrowed two ways - by keeping values (`project=cmip6`) and by
// removing them (`project_not_=cmip5`) - and the two mean opposite things. Telling them apart by
// COLOUR alone - an accent count badge against a red exclusion - fails twice over. The accent is
// host-configurable, so a deployment with a red accent renders "included" and "excluded" in the
// same colour; and a monochrome print, a forced-colours mode or a colour-blind reader gets no
// signal at all.
//
// So the distinction is carried by CHARACTER and by SHAPE, with colour as reinforcement only:
//
//   included   `+N`   solid, filled badge
//   excluded   `-N`   outlined badge with a DASHED border
//
// The minus sign is U+2212, not `x`: `x` is the clear/remove symbol everywhere in this component,
// and reusing it for "excluded" would make a count look like a button.
//
// EACH BADGE IS ITS OWN CONTROL. `+N` clears only the included values and `-N` only the excluded
// ones, because "stop excluding these three" must not also throw away the two values the user chose
// to keep. On hover or focus a badge REPLACES its text with one centred `x` - replaces, not overlays:
// the count is taken out of the flow entirely, so there is never a cross sitting on top of a still-
// visible number. The box keeps its size, so nothing in the header shifts under the pointer.
//
// They are real `<button>`s, and they are SIBLINGS of the facet's disclosure button, never children
// of it: a button inside a button is invalid HTML, and assistive technology cannot reach the inner
// one reliably.

import { el } from "../dom.js";
import { excludedValues, includedValues } from "../state.js";
import type { QueryScope } from "../search/query.js";

/** U+2212 MINUS SIGN. Not a hyphen (too small) and emphatically not `x` (that means "remove"). */
export const MINUS = "−";
/** U+2260 NOT EQUAL TO - the marker on an excluded value, in every surface. */
export const NEQ = "≠";

export interface SelectionBreakdown {
  included: number;
  excluded: number;
  /** Everything that narrows this facet. */
  total: number;
}

export function facetBreakdown(state: QueryScope, baseKey: string): SelectionBreakdown {
  const included = includedValues(state, baseKey).length;
  const excluded = excludedValues(state, baseKey).length;
  return { included, excluded, total: included + excluded };
}

/** "2 included, 1 excluded" - spelled out, because `+2 -1` is not something a screen reader says. */
export function breakdownSpoken(b: SelectionBreakdown): string {
  const parts: string[] = [];
  if (b.included) parts.push(`${b.included} included`);
  if (b.excluded) parts.push(`${b.excluded} excluded`);
  return parts.join(", ") || "none";
}

export interface BadgeSpec {
  negative: boolean;
  count: number;
}

/** Which badges a facet needs: `+N` when anything is included, `-N` when anything is excluded. */
export function badgeSpecs(b: SelectionBreakdown): BadgeSpec[] {
  const out: BadgeSpec[] = [];
  if (b.included) out.push({ negative: false, count: b.included });
  if (b.excluded) out.push({ negative: true, count: b.excluded });
  return out;
}

/**
 * One `+N` / `-N` clear button.
 *
 * `onClear` fires once per activation. The label is MODE-SPECIFIC ("Clear 1 included Project
 * value") because "clear this facet" would be a lie now that the two halves are separate.
 */
export function modeBadge(
  spec: BadgeSpec,
  facetLabel: string,
  onClear: () => void,
  listen: (node: HTMLElement, type: string, fn: (e: Event) => void) => void,
): HTMLButtonElement {
  const word = spec.negative ? "excluded" : "included";
  const text = `${spec.negative ? MINUS : "+"}${spec.count}`;
  const label = `Clear ${spec.count} ${word} ${facetLabel} value${spec.count === 1 ? "" : "s"}`;
  const btn = el(
    "button",
    {
      class: `fh-count fb ${spec.negative ? "fb-exc" : "fb-inc"}`,
      type: "button",
      "data-mode": spec.negative ? "exclude" : "include",
      title: label,
      "aria-label": label,
    },
    [
      // The count and the cross are SEPARATE nodes and only one is ever in the flow, so the cross
      // can never be drawn over a number that is still showing through.
      el("span", { class: "fb-n", text }),
      el("span", { class: "fb-x", "aria-hidden": "true", text: "×" }),
    ],
  ) as HTMLButtonElement;
  // Size the box by the COUNT, so swapping in the cross cannot make the header jump.
  btn.style.setProperty("--fb-ch", String(text.length));
  // The badges sit inside the facet header row; the row toggles the accordion, and a click meant for
  // a badge is not a click meant for the row.
  listen(btn, "click", (e) => {
    e.stopPropagation();
    onClear();
  });
  return btn;
}
