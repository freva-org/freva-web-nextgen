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

/* Typed placeholder.
 *
 * The examples are REAL VALUES from the archive in front of the visitor, not a hard-coded list: a
 * made-up example is a promise the deployment did not make, and a list baked into this package
 * would name CMIP vocabulary at a deployment holding observations. Preference goes to values the
 * metadata set describes, because those mean something to somebody who does not already know the
 * archive.
 *
 * The PREFIX never retypes. Only the tail is deleted and rewritten, so the field always reads as a
 * complete instruction - "Search tas", "Search cmip6" - rather than emptying to nothing and back,
 * which reads as a fault.
 */

/** Type a character every this many ms; delete faster, because deleting is not the message. */
const TYPE_MS = 62;
const DELETE_MS = 28;
/** How long a finished example stays before it is taken away. */
const HOLD_MS = 1900;
/** How many examples to rotate through. More is not more informative; it is just longer. */
const MAX_EXAMPLES = 6;

/*
 * The fixed half of the placeholder. It says what the field takes - VALUES, not `key=value` - and
 * frames what follows as one example among many rather than as a required format. Only the text
 * after "e.g. " is typed and retyped; the sentence itself never moves, so the field does not look
 * like it is rewriting its own label.
 */
const PLACEHOLDER_PREFIX = "Search values – e.g. ";
/**
 * Used only before any facet has loaded, and deliberately generic: these are the shapes of a value,
 * not claims about what this archive holds.
 */
const FALLBACK_EXAMPLES = ["a variable", "a model", "an experiment"];
/**
 * How long an example may be. The cap is what makes the descriptions usable at all: they run from
 * "Aerosol" to a 597-character model provenance paragraph, and the short ones are exactly the
 * readable ones. Past this the raw value is the better example - it is at least complete.
 */
const MAX_EXAMPLE_LEN = 30;

/**
 * Examples drawn from the loaded facets - the metadata DESCRIPTION where there is a short one,
 * otherwise the raw value. Stable order, at most one per facet.
 *
 * `tas` is not an example of anything to somebody who does not already know the archive; "Near-
 * Surface Air Temperature" is. Showing the description is honest here because the dropdown ranks
 * on descriptions as well as values (see search/rank.ts), so the example the field offers is one
 * the field can actually answer.
 */
function exampleValues(ctx: AppContext): string[] {
  const described: string[] = [];
  const plain: string[] = [];
  for (const facet of ctx.state.facets) {
    for (const { value } of facet.values.slice(0, 4)) {
      if (typeof value !== "string" || value.length === 0) continue;
      const desc = describeValue(ctx.state, facet.key, value);
      const useDesc = desc !== null && desc.length > 0 && desc.length <= MAX_EXAMPLE_LEN;
      const label = useDesc ? desc : value;
      if (label.length > MAX_EXAMPLE_LEN) continue; // try this facet's next value instead
      (useDesc ? described : plain).push(label);
      break; // one per facet, so the rotation shows breadth rather than one facet's top four
    }
  }
  const out: string[] = [];
  for (const value of [...described, ...plain]) {
    if (!out.includes(value)) out.push(value);
    if (out.length >= MAX_EXAMPLES) break;
  }
  return out;
}

/**
 * Drive the field's placeholder. Returns nothing to call back into - it stops with the Disposables.
 *
 * Runs only while the field is EMPTY and unfocused, which is the only time a placeholder is on
 * screen: an animation nobody can see is a timer nobody asked for. Under `prefers-reduced-motion`
 * it writes one example and stops, because the information is the example and not the typing.
 */
function typedPlaceholder(ctx: AppContext, input: HTMLInputElement, dis: Disposables): void {
  const reduced =
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  /*
   * An animation that cannot be scoped to what is on screen is not started.
   *
   * This is a chain of timers with no end - the rotation is the feature - so the one thing it must
   * never be is unconditional. `IntersectionObserver` is how it learns whether the field is in
   * front of anybody: scrolled away, in a collapsed panel, in a background tab, the chain stops
   * dead rather than retyping into a placeholder nobody can see. Where the observer is missing the
   * answer is unknowable, so the honest response is one example written once and no timer at all -
   * which is also what keeps a headless test process from being held open by a loop that would
   * never finish.
   */
  const observable = typeof IntersectionObserver === "function";

  let examples = FALLBACK_EXAMPLES;
  let index = 0;
  let typed = 0;
  let deleting = false;
  let timer = 0;
  let stopped = false;
  /*
   * Starts FALSE, not true. The observer's first callback is the one that starts the chain, and it
   * only acts on a CHANGE - seeded as already-on-screen, that first callback is a no-op and the
   * typing never begins for a field that was visible from the start, which is nearly all of them.
   */
  let onScreen = false;

  const idle = (): boolean =>
    input.value.length === 0 && input.ownerDocument.activeElement !== input;

  const write = (tail: string): void => {
    input.placeholder = `${PLACEHOLDER_PREFIX}${tail}`;
  };

  const step = (): void => {
    if (stopped || !onScreen || !input.isConnected) return;
    // Refresh from the live facets each cycle: the archive's vocabulary arrives after mount, and
    // narrowing the query changes what is worth suggesting.
    if (!deleting && typed === 0) {
      const live = exampleValues(ctx);
      if (live.length) examples = live;
      if (index >= examples.length) index = 0;
    }
    const target = examples[index] ?? FALLBACK_EXAMPLES[0]!;

    if (!idle()) {
      // Parked, not stopped: the visitor is using the field, and the placeholder is not on screen.
      timer = dis.setTimeout(step, HOLD_MS);
      return;
    }

    if (deleting) {
      typed -= 1;
      write(target.slice(0, Math.max(0, typed)));
      if (typed <= 0) {
        deleting = false;
        typed = 0;
        index = (index + 1) % examples.length;
        timer = dis.setTimeout(step, TYPE_MS * 4);
        return;
      }
      timer = dis.setTimeout(step, DELETE_MS);
      return;
    }

    typed += 1;
    write(target.slice(0, typed));
    if (typed >= target.length) {
      deleting = true;
      timer = dis.setTimeout(step, HOLD_MS);
      return;
    }
    timer = dis.setTimeout(step, TYPE_MS);
  };

  /** One example, written once - the state the field rests in when nothing is animating. */
  const still = (): void => {
    const live = exampleValues(ctx);
    write((live.length ? live : FALLBACK_EXAMPLES)[0] ?? "");
  };

  if (reduced || !observable) {
    // Written after a beat, because the facets that make the example REAL arrive after mount.
    write("");
    timer = dis.setTimeout(still, 600);
    dis.add(() => window.clearTimeout(timer));
    return;
  }

  write("");
  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries.some((entry) => entry.isIntersecting);
      if (visible === onScreen) return;
      onScreen = visible;
      window.clearTimeout(timer);
      if (visible) timer = dis.setTimeout(step, 400);
    },
    { threshold: 0 },
  );
  observer.observe(input);
  dis.add(() => {
    stopped = true;
    observer.disconnect();
    if (timer) window.clearTimeout(timer);
  });
}

/* The keyboard hint.
 *
 * `⌘K` on a Mac and `Ctrl K` everywhere else - the modifier a visitor's own keyboard actually has.
 * Printing one of the two on every platform is how a hint becomes a thing people try once.
 */

/** True when the visitor is on an Apple keyboard layout, by the least-deprecated means available. */
export function isAppleKeyboard(): boolean {
  if (typeof navigator === "undefined") return false;
  const data = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  const platform = data?.platform ?? navigator.platform ?? "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/**
 * The hint element, plus the shortcut that makes it true.
 *
 * The listener is on the OWNING DOCUMENT rather than the field, because the point of the shortcut
 * is to reach the field from somewhere else on the page. It stands down while the visitor is typing
 * into some other field: stealing a keystroke out of a textarea to focus a search box is the kind
 * of helpfulness that loses somebody a paragraph.
 */
function keyboardHint(input: HTMLInputElement, dis: Disposables): HTMLElement {
  const apple = isAppleKeyboard();
  const hint = el("span", { class: "search-kbd", "aria-hidden": "true" }, [
    el("kbd", { text: apple ? "⌘" : "Ctrl" }),
    el("kbd", { text: "K" }),
  ]);
  // Announced once, on the field itself, rather than by the decorative glyphs above.
  const existing = input.getAttribute("aria-label") ?? "";
  input.setAttribute("aria-keyshortcuts", apple ? "Meta+K" : "Control+K");
  input.setAttribute("aria-label", `${existing} (${apple ? "Command" : "Control"}+K)`.trim());

  dis.listen(input.ownerDocument, "keydown", (event) => {
    const ke = event as KeyboardEvent;
    if (ke.key !== "k" && ke.key !== "K") return;
    if (apple ? !ke.metaKey : !ke.ctrlKey) return;
    if (ke.altKey) return;
    if (!input.isConnected) return;
    const active = input.ownerDocument.activeElement as HTMLElement | null;
    const typingElsewhere =
      active !== null &&
      active !== input &&
      (active.tagName === "TEXTAREA" ||
        (active.tagName === "INPUT" && (active as HTMLInputElement).type !== "checkbox") ||
        active.isContentEditable);
    if (typingElsewhere) return;
    ke.preventDefault();
    input.focus();
    input.select();
  });
  return hint;
}

/**
 * Wire the field's own furniture: the typed placeholder and the keyboard hint.
 *
 * Separate from `createValueSearch` because they are separate concerns with separate failure
 * modes - a deployment with `features.search` off still has a field it can focus - and because the
 * dropdown is the part with the interesting logic and does not need a timer in the middle of it.
 */
export function decorateSearchField(
  ctx: AppContext,
  input: HTMLInputElement,
  slot: HTMLElement,
): void {
  typedPlaceholder(ctx, input, ctx.dis);
  slot.appendChild(keyboardHint(input, ctx.dis));
}
