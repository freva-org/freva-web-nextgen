// The header search. The index is the static file the build wrote (`src/model/search-index.ts`),
// fetched once on first use from the portal's own origin and searched in the page: no service,
// nothing new in the CSP.
//
// An ARIA combobox inside a native modal `<dialog>` (focus trap, Escape, inert page): the field
// keeps focus while the arrow keys move the active option (`aria-activedescendant`) and Enter
// follows it. Results use `textContent` and `<mark>`, never HTML strings.
//
// A result links to its page with `?h=<terms>`; on arrival those words are marked in the article,
// as Material for MkDocs does, so the reader sees why the page matched.

import "./site-search.css";

import {
  browse,
  inSections,
  normalize,
  search,
  snippet,
  terms,
  prepare,
  MAX_RESULTS,
  type Entry,
  type Hit,
  type Prepared,
} from "./site-search-core.js";

export { normalize, search, snippet, terms };

const HIGHLIGHT_PARAM = "h";

/** Append `text` to `parent`, with every occurrence of a term wrapped in `<mark>`. */
export function appendMarked(parent: HTMLElement, text: string, wanted: string[]): void {
  const lower = normalize(text);
  // `normalize` can change a string's length (NFKD decomposes), so marking works on the
  // original only where the two are the same length; otherwise the text is shown unmarked
  // rather than marked in the wrong place.
  if (lower.length !== text.length || wanted.length === 0) {
    parent.append(text);
    return;
  }
  const ranges: [number, number][] = [];
  for (const term of wanted) {
    let at = lower.indexOf(term);
    while (at !== -1) {
      ranges.push([at, at + term.length]);
      at = lower.indexOf(term, at + term.length);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start < cursor) continue;
    if (start > cursor) parent.append(text.slice(cursor, start));
    const mark = document.createElement("mark");
    mark.className = "portal-sitesearch-mark";
    mark.textContent = text.slice(start, end);
    parent.append(mark);
    cursor = end;
  }
  if (cursor < text.length) parent.append(text.slice(cursor));
}

function hrefFor(entry: Entry, query: string): string {
  const anchor = entry.a ? `#${entry.a}` : "";
  if (!query.trim()) return `${entry.u}${anchor}`;
  const params = new URLSearchParams({ [HIGHLIGHT_PARAM]: query.trim() });
  return `${entry.u}?${params.toString()}${anchor}`;
}

/**
 * Mark the searched words in the article the reader arrived at. Text nodes only, and never inside
 * code a reader might copy: the copy control reads the code block's text, not its markup, but a
 * `<mark>` inside a `<pre>` would still change what a selection copies.
 */
export function highlightArticle(root: ParentNode, wanted: string[]): number {
  if (wanted.length === 0) return 0;
  const walker = document.createTreeWalker(root as Node, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (
        !parent ||
        parent.closest("pre, code, script, style, .katex, svg, .portal-sitesearch-mark")
      ) {
        return NodeFilter.FILTER_REJECT;
      }
      const text = normalize(node.textContent ?? "");
      return wanted.some((w) => text.includes(w))
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_SKIP;
    },
  });
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
  let marked = 0;
  for (const node of nodes) {
    const holder = document.createElement("span");
    appendMarked(holder, node.textContent ?? "", wanted);
    marked += holder.querySelectorAll("mark").length;
    node.replaceWith(...holder.childNodes);
  }
  return marked;
}

export function initSiteSearch(): void {
  const dialog = document.querySelector<HTMLDialogElement>("dialog.portal-sitesearch");
  const opener = document.querySelector<HTMLButtonElement>("[data-portal-sitesearch-open]");
  if (!dialog || !opener) return;
  const input = dialog.querySelector<HTMLInputElement>(".portal-sitesearch-input")!;
  const list = dialog.querySelector<HTMLUListElement>(".portal-sitesearch-results")!;
  const status = dialog.querySelector<HTMLElement>(".portal-sitesearch-status")!;
  const closer = dialog.querySelector<HTMLButtonElement>("[data-portal-sitesearch-close]");
  const indexUrl = dialog.dataset.portalSitesearchIndex ?? "";
  const toggle = dialog.querySelector<HTMLButtonElement>("[data-portal-sitesearch-filters-toggle]");
  const facets = [...dialog.querySelectorAll<HTMLButtonElement>("[data-portal-sitesearch-facet]")];
  const selected = new Set<string>();

  // Words the reader searched for on the page they came from.
  const arrived = new URLSearchParams(window.location.search).get(HIGHLIGHT_PARAM);
  if (arrived) {
    const article = document.querySelector(".portal-prose");
    if (article) highlightArticle(article, terms(arrived));
  }

  opener.hidden = false;

  let index: Promise<Prepared[]> | undefined;
  const load = (): Promise<Prepared[]> => {
    index ??= fetch(indexUrl, { credentials: "same-origin" })
      .then((response) => {
        if (!response.ok) throw new Error(`the search index returned ${response.status}`);
        return response.json() as Promise<{ entries: Entry[] }>;
      })
      .then((document) => prepare(document.entries))
      .catch((error: unknown) => {
        index = undefined;
        throw error;
      });
    return index;
  };

  let hits: Hit[] = [];
  /** The query `hits` answer. It trails the field while the debounce is pending. */
  let hitsFor: string | null = null;
  let active = -1;
  let lastFocus: HTMLElement | null = null;

  const setActive = (next: number): void => {
    const options = [...list.children] as HTMLElement[];
    if (options.length === 0) {
      active = -1;
      input.removeAttribute("aria-activedescendant");
      return;
    }
    active = (next + options.length) % options.length;
    options.forEach((option, i) => option.setAttribute("aria-selected", String(i === active)));
    const current = options[active]!;
    input.setAttribute("aria-activedescendant", current.id);
    current.scrollIntoView({ block: "nearest" });
  };

  const follow = (hit: Hit | undefined): void => {
    if (!hit) return;
    window.location.assign(hrefFor(hit.entry, input.value));
  };

  const render = (query: string, browsing: boolean): void => {
    const wanted = terms(query);
    list.replaceChildren();
    input.removeAttribute("aria-activedescendant");
    active = -1;
    hits.forEach((hit, i) => {
      const option = document.createElement("li");
      option.id = `portal-sitesearch-option-${i}`;
      option.className = "portal-sitesearch-result";
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", "false");
      const title = document.createElement("span");
      title.className = "portal-sitesearch-result-title";
      appendMarked(title, hit.entry.h ? `${hit.entry.t} › ${hit.entry.h}` : hit.entry.t, wanted);
      option.append(title);
      if (hit.entry.p) {
        const place = document.createElement("span");
        place.className = "portal-sitesearch-result-place";
        place.textContent = hit.entry.p;
        option.append(place);
      }
      const text = snippet(hit.entry.x, wanted);
      if (text) {
        const body = document.createElement("span");
        body.className = "portal-sitesearch-result-text";
        appendMarked(body, text, wanted);
        option.append(body);
      }
      option.addEventListener("click", () => follow(hit));
      option.addEventListener("mousemove", () => {
        if (active !== i) setActive(i);
      });
      list.append(option);
    });
    const expanded = hits.length > 0;
    input.setAttribute("aria-expanded", String(expanded));
    if (browsing) {
      status.textContent = `${hits.length} page${hits.length === 1 ? "" : "s"} in ${[...selected].join(", ")}`;
    } else if (terms(query).join("").length < 2) status.textContent = "";
    else
      status.textContent = expanded
        ? `${hits.length}${hits.length === MAX_RESULTS ? "+" : ""} result${hits.length === 1 ? "" : "s"}`
        : "No results";
  };

  let pending = 0;
  const run = (): Promise<void> => {
    const query = input.value;
    const ticket = ++pending;
    return load()
      .then((entries) => {
        if (ticket !== pending) return;
        const scope = inSections(entries, selected);
        const browsing = selected.size > 0 && terms(query).join("").length < 2;
        hits = browsing ? browse(scope) : search(scope, query);
        hitsFor = query;
        render(query, browsing);
      })
      .catch(() => {
        status.textContent = "Search is unavailable right now.";
      });
  };

  const open = (): void => {
    if (dialog.open) return;
    lastFocus = document.activeElement as HTMLElement | null;
    dialog.showModal();
    opener.setAttribute("aria-expanded", "true");
    input.focus();
    input.select();
    void load().catch(() => {
      status.textContent = "Search is unavailable right now.";
    });
    if (input.value || selected.size > 0) void run();
  };

  const showFilters = (shown: boolean): void => {
    if (!toggle) return;
    dialog.dataset.filters = shown ? "open" : "closed";
    toggle.setAttribute("aria-expanded", String(shown));
  };
  showFilters(window.matchMedia("(min-width: 761px)").matches);
  toggle?.addEventListener("click", () => showFilters(dialog.dataset.filters !== "open"));
  for (const facet of facets) {
    facet.addEventListener("click", () => {
      const label = facet.dataset.portalSitesearchFacet ?? "";
      if (selected.has(label)) selected.delete(label);
      else selected.add(label);
      facet.setAttribute("aria-pressed", String(selected.has(label)));
      void run();
    });
  }

  dialog.addEventListener("close", () => {
    opener.setAttribute("aria-expanded", "false");
    (lastFocus ?? opener).focus();
  });
  // A click on the backdrop - the dialog element itself, outside its box - closes it.
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  closer?.addEventListener("click", () => dialog.close());
  opener.addEventListener("click", open);

  let timer = 0;
  input.addEventListener("input", () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void run(), 60);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive(active + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive(active - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (hitsFor === input.value) {
        follow(hits[active >= 0 ? active : 0]);
        return;
      }
      // The list on screen answers an earlier query (typed within the debounce): search for what
      // is in the field now and follow ITS best result, never the previous query's.
      window.clearTimeout(timer);
      const query = input.value;
      void run().then(() => {
        if (hitsFor === query && input.value === query) follow(hits[0]);
      });
    }
  });
}
