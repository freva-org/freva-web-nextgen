// components/searchBar.ts - the value-first main search bar.
// The user types a VALUE (e.g. "tas"); the dropdown shows matches across ALL facet values, each
// row = facet badge + value + its metadata.js description + count. Selecting one adds that
// `facet=value` filter. Keyboard-navigable (↑/↓/Enter/Esc). The `key=value` power syntax lives in
// the terminal only. Every label reaches the DOM via textContent / el().

import type { AppContext } from "../context.js";
import type { Disposables } from "../dom.js";
import { el, replaceChildren } from "../dom.js";
import { anchorVisible, positionAnchored } from "../anchor.js";
import { describeValue, isSelected, labelFor } from "../state.js";
import { rankValueMatches, type ValueMatch } from "../search/rank.js";

export interface SearchBarController {
  destroy(): void;
}

type Match = ValueMatch;

/** Rank matches through the SHARED ranker, so the picker's field orders results identically. */
function collectMatches(ctx: AppContext, raw: string): Match[] {
  return rankValueMatches(ctx.state.facets, raw, {
    label: (f) => labelFor(ctx.state, f.key),
    describe: (k, v) => describeValue(ctx.state, k, v),
    isApplied: (k, v) => isSelected(ctx.state, k, v),
  });
}

export function createValueSearch(ctx: AppContext, input: HTMLInputElement): SearchBarController {
  const dis = ctx.dis;
  const pop = el("div", {
    class: "vsearch-pop",
    role: "listbox",
    "aria-label": "Facet value matches",
  });
  // Component-scoped and ABSOLUTE, placed by the shared helper - see anchor.ts for why
  // `position: fixed` breaks inside an embedded host's clipping/transformed container.
  pop.style.position = "absolute";
  ctx.roots.app.append(pop);

  let matches: Match[] = [];
  let hl = 0;
  let open = false;
  let bucket: Disposables | null = null;

  const hide = (): void => {
    open = false;
    pop.classList.remove("show");
    replaceChildren(pop);
    bucket?.flush();
    bucket = null;
  };

  const position = (): void => {
    const w = input.getBoundingClientRect().width;
    positionAnchored(ctx.roots.app, pop, input, {
      placement: "below",
      gap: 5,
      minWidth: Math.max(w, 280),
      maxWidth: Math.max(w, 420),
      // The stylesheet asks for 340px and means it. Without this the positioner writes the whole
      // available height as an inline style, which beats the rule - so the list grows to nearly the
      // full component. It stays content-sized below 340 and scrolls internally above it, and an
      // embedded host that offers less than 340 still wins, because the cap is a `min`.
      maxHeight: 340,
    });
  };

  const paintHighlight = (): void => {
    pop.querySelectorAll<HTMLElement>(".vs-item").forEach((n, i) => {
      const on = i === hl;
      n.classList.toggle("hl", on);
      n.setAttribute("aria-selected", on ? "true" : "false");
      if (on) n.scrollIntoView({ block: "nearest" });
    });
  };

  const choose = (i: number): void => {
    const m = matches[i];
    if (!m) return;
    input.value = "";
    hide();
    ctx.toggleFacet(m.key, m.value); // adds facet=value and re-runs the search
  };

  const render = (): void => {
    matches = collectMatches(ctx, input.value);
    bucket?.flush();
    bucket = dis.child();
    const reg = bucket;
    if (matches.length === 0) {
      if (input.value.trim()) {
        replaceChildren(pop, el("div", { class: "vs-empty", text: "No matching facet values." }));
        pop.classList.add("show");
        open = true;
        position();
      } else {
        hide();
      }
      return;
    }
    hl = 0;
    const rows = matches.map((m, i) =>
      el(
        "div",
        {
          class: `vs-item${i === 0 ? " hl" : ""}`,
          role: "option",
          "aria-selected": i === 0 ? "true" : "false",
          title: m.desc ? `${m.value} - ${m.desc}` : `${m.label}: ${m.value}`,
        },
        [
          el("span", { class: "vs-badge", text: m.label }),
          el("span", { class: "vs-val", text: m.value }),
          m.desc ? el("span", { class: "vs-desc", text: m.desc }) : null,
          el("span", { class: "vs-cnt", text: m.count.toLocaleString("en-US") }),
        ],
      ),
    );
    rows.forEach((row, i) => {
      // mousedown so the pick lands before the input blurs
      reg.listen(row, "mousedown", (e) => {
        e.preventDefault();
        choose(i);
      });
    });
    replaceChildren(pop, ...rows);
    pop.classList.add("show");
    open = true;
    position();
  };

  dis.listen(input, "input", () => render());
  dis.listen(input, "focus", () => {
    if (input.value.trim()) render();
  });
  dis.listen(input, "blur", () => dis.setTimeout(() => hide(), 120));
  dis.listen(input, "keydown", (e) => {
    const ke = e as KeyboardEvent;
    if (!open) {
      if (ke.key === "ArrowDown" && input.value.trim()) {
        ke.preventDefault();
        render();
      }
      return;
    }
    if (ke.key === "ArrowDown") {
      ke.preventDefault();
      hl = Math.min(matches.length - 1, hl + 1);
      paintHighlight();
    } else if (ke.key === "ArrowUp") {
      ke.preventDefault();
      hl = Math.max(0, hl - 1);
      paintHighlight();
    } else if (ke.key === "Enter") {
      ke.preventDefault();
      choose(hl);
    } else if (ke.key === "Escape") {
      ke.preventDefault();
      hide();
    }
  });
  dis.listen(window, "resize", () => open && position());
  // This is a transient menu: an external scroll dismisses it rather than dragging it along. A
  // scroll INSIDE the dropdown (browsing a long match list) must not close it.
  dis.listen(
    window,
    "scroll",
    (e) => {
      if (!open) return;
      // `window`'s own scroll targets the Window, which is not a Node - check before contains().
      const t = e.target as Node | null;
      if (t && typeof t.nodeType === "number" && pop.contains(t)) return;
      hide();
    },
    true,
  );
  // The input can scroll out of the component's visible area inside an embedded host; a dropdown
  // pointing at an off-screen field is just a floating menu.
  dis.listen(input, "blur", () => {
    if (open && !anchorVisible(ctx.roots.app, input)) hide();
  });
  dis.add(() => pop.remove());

  return { destroy: hide };
}
