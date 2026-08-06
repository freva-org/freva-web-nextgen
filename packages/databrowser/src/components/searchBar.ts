// components/searchBar.ts - the value-first main search bar.
// The user types a VALUE (e.g. "tas"); the dropdown shows matches across ALL facet values, each
// row = facet badge + value + its metadata.js description + count. Selecting one adds that
// `facet=value` filter. Keyboard-navigable (↑/↓/Enter/Esc). The `key=value` power syntax lives in
// the terminal only. Every label reaches the DOM via textContent / el().

import type { AppContext } from "../context.js";
import type { Disposables } from "../dom.js";
import { el, replaceChildren } from "../dom.js";
import { describeValue, isSelected, labelFor } from "../state.js";

export interface SearchBarController {
  destroy(): void;
}

interface Match {
  key: string;
  label: string;
  value: string;
  count: number;
  desc: string | null;
}

const MAX_RESULTS = 40;

/** Rank matches: prefix hits before substring hits; then by count desc. */
function collectMatches(ctx: AppContext, raw: string): Match[] {
  const q = raw.trim().toLowerCase();
  if (!q) return [];
  const prefix: Match[] = [];
  const substr: Match[] = [];
  for (const facet of ctx.state.facets) {
    const label = labelFor(ctx.state, facet.key);
    for (const v of facet.values) {
      if (isSelected(ctx.state, facet.key, v.value)) continue; // already applied
      const val = v.value.toLowerCase();
      const desc = describeValue(ctx.state, facet.key, v.value);
      const inVal = val.includes(q);
      const inDesc = desc ? desc.toLowerCase().includes(q) : false;
      if (!inVal && !inDesc) continue;
      const m: Match = { key: facet.key, label, value: v.value, count: v.count, desc };
      if (val.startsWith(q)) prefix.push(m);
      else substr.push(m);
    }
  }
  const byCount = (a: Match, b: Match): number => b.count - a.count;
  prefix.sort(byCount);
  substr.sort(byCount);
  return [...prefix, ...substr].slice(0, MAX_RESULTS);
}

export function createValueSearch(ctx: AppContext, input: HTMLInputElement): SearchBarController {
  const dis = ctx.dis;
  const pop = el("div", {
    class: "vsearch-pop",
    role: "listbox",
    "aria-label": "Facet value matches",
  });
  pop.style.position = "fixed";
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
    const r = input.getBoundingClientRect();
    pop.style.top = `${r.bottom + 5}px`;
    pop.style.left = `${r.left}px`;
    pop.style.minWidth = `${Math.max(r.width, 280)}px`;
    pop.style.maxWidth = `${Math.max(r.width, 420)}px`;
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
  dis.listen(window, "scroll", () => open && position(), true);
  dis.add(() => pop.remove());

  return { destroy: hide };
}
