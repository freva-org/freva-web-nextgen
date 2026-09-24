/**
 * The landing search box's suggestion list.
 *
 * The box is a plain GET form in the document and stays one: with no script a visitor can still
 * type a value and submit, and the hidden fields carry the serialized intent to the Data Browser.
 * This adds what a static form cannot have - the visitor being shown what is actually in the index
 * while they type, and landing on the value they picked rather than on a guess.
 *
 * Two rules:
 *
 *   * It does not search. Choosing a row hands a `key=value` pair to the URL for the Data Browser
 *     to read on mount; the list never fetches rows and never renders results.
 *   * It ranks with the Data Browser's own ranker, imported dynamically so no byte of it is in the
 *     landing bundle until a visitor types. A landing box that ordered matches differently from
 *     the bar the visitor lands in would read as unreliable without anything ever failing.
 */

import { serializeSearchIntentV1 } from "@freva-org/databrowser/intent";

/** How long to wait after the last keystroke before ranking. */
const DEBOUNCE_MS = 140;
/** How many rows the list ever shows. */
const LIMIT = 8;

interface Suggestion {
  key: string;
  label: string;
  value: string;
  count: number;
  /** The shared climate description, when one exists for this (key, value). */
  desc?: string | null;
}

interface FacetValue {
  value: string;
  count: number;
}
interface Facet {
  key: string;
  label: string;
  values: FacetValue[];
  hasMore: boolean;
}

/** `time_frequency` -> `Time frequency`. */
function humanise(key: string): string {
  const spaced = key.replace(/[_-]+/g, " ").trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : key;
}

/**
 * The API returns each facet as a flat `[value, count, value, count, …]` list. A malformed pair is
 * skipped rather than turned into `NaN`.
 */
function parseFacets(raw: unknown): Facet[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const facets: Facet[] = [];
  for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(entry)) continue;
    const values: FacetValue[] = [];
    for (let index = 0; index + 1 < entry.length; index += 2) {
      const value = entry[index];
      const count = entry[index + 1];
      if (typeof value !== "string" || typeof count !== "number" || !Number.isFinite(count)) {
        continue;
      }
      values.push({ value, count });
    }
    if (values.length) facets.push({ key, label: humanise(key), values, hasMore: false });
  }
  return facets;
}

type Describe = (key: string, value: string) => string | null;

type Ranker = (
  facets: readonly Facet[],
  query: string,
  options: { limit: number; describe?: Describe },
) => readonly Suggestion[];

function createSource(apiBase: string, flavour: string, fixed: Record<string, string[]>) {
  const base = apiBase.replace(/\/+$/, "");
  const controller = new AbortController();
  let facets: Promise<Facet[]> | null = null;
  let ranker: Promise<Ranker> | null = null;
  let describe: Promise<Describe> | null = null;

  /**
   * One call, on first interaction rather than on page load: a landing page that fires a search
   * request at every visitor who never uses the box is a cost with no benefit. After that the
   * ranking is local, which is what makes the list feel instant.
   */
  const loadFacets = (): Promise<Facet[]> => {
    if (facets) return facets;
    const query = new URLSearchParams({ translate: "true" });
    // The block's locked facets are part of the request, so the values offered are drawn from
    // the scope the visitor will actually land in.
    for (const [key, values] of Object.entries(fixed)) {
      for (const value of values) query.append(key, value);
    }
    const url = `${base}/metadata-search/${encodeURIComponent(flavour)}/file?${query.toString()}`;
    facets = fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } })
      .then(async (response) => {
        if (!response.ok) return [];
        const body: unknown = await response.json();
        return parseFacets((body as { facets?: unknown } | null)?.facets);
      })
      // A suggestion list is an optional convenience: if it cannot be built the box still
      // submits. The failure is not cached, so the next keystroke may retry.
      .catch(() => {
        facets = null;
        return [];
      });
    return facets;
  };

  const loadRanker = (): Promise<Ranker> => {
    if (!ranker) {
      ranker = import("@freva-org/databrowser/picker")
        .then((module) => module.rankValueMatches as unknown as Ranker)
        .catch(() => {
          ranker = null;
          return () => [];
        });
    }
    return ranker;
  };

  /**
   * The Data Browser's own descriptions, so the box matches what the visitor reads and not only
   * what they type: `cmip5` is also "Coupled Model Intercomparison Project 5", and the bar the
   * visitor lands in passes `describe` to the shared ranker, which matches a description as a
   * substring hit. Without it the same query finds nothing here and everything one page later.
   *
   * Loaded through the same lazy path as the ranker - its own chunk, fetched on first keystroke -
   * and a failure means no descriptions rather than a broken box.
   */
  const loadDescribe = (): Promise<Describe> => {
    if (!describe) {
      describe = import("@freva-org/databrowser/metadata")
        .then(async (module) => {
          const metadata = await module.loadBuiltinMetadata();
          // Facet keys arrive in the flavour's naming (`translate=true`); the descriptions are
          // keyed by the native freva key.
          const backward = module.BUILTIN_FLAVOUR_MAPS[flavour]?.backward;
          return (key: string, value: string): string | null =>
            module.describeMetadataValue(metadata, backward, key, value);
        })
        .catch(() => {
          describe = null;
          return () => null;
        });
    }
    return describe;
  };

  return {
    async suggest(text: string): Promise<Suggestion[]> {
      const query = text.trim();
      if (!query) return [];
      const [values, rank, describeValue] = await Promise.all([
        loadFacets(),
        loadRanker(),
        loadDescribe(),
      ]);
      if (!values.length) return [];
      return [...rank(values, query, { limit: LIMIT, describe: describeValue })];
    },
    /**
     * The single value a bare submit should apply. The index has no free-text field, so the only
     * honest thing a typed string can mean is "the facet value with this name"; anything else
     * travels as text, and the Data Browser's own bar shows what it matched.
     */
    async exactMatch(text: string): Promise<Suggestion | null> {
      const query = text.trim().toLowerCase();
      if (!query) return null;
      const [values, describeValue] = await Promise.all([loadFacets(), loadDescribe()]);
      let best: Suggestion | null = null;
      let described: Suggestion | null = null;
      for (const facet of values) {
        for (const value of facet.values) {
          const desc = describeValue(facet.key, value.value);
          const isValue = value.value.toLowerCase() === query;
          // "Coupled Model Intercomparison Project 5" names `cmip5` as surely as `cmip5` does. A
          // description only wins when no value matched, so an actual facet value is never
          // displaced by someone else's prose.
          const isDesc = !isValue && desc !== null && desc.toLowerCase() === query;
          if (!isValue && !isDesc) continue;
          const match: Suggestion = {
            key: facet.key,
            label: facet.label,
            value: value.value,
            count: value.count,
            desc,
          };
          // Several facets can carry the same value; the most populated one is what the visitor
          // almost certainly meant.
          if (isValue) {
            if (!best || value.count > best.count) best = match;
          } else if (!described || value.count > described.count) {
            described = match;
          }
        }
      }
      return best ?? described;
    },
  };
}

function readFixed(raw: string | undefined): Record<string, string[]> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(value)) out[key] = value.map(String);
      else if (typeof value === "string") out[key] = [value];
    }
    return out;
  } catch {
    return {};
  }
}

function attach(form: HTMLFormElement): void {
  const input = form.querySelector<HTMLInputElement>(".portal-search-input");
  const field = form.querySelector<HTMLElement>(".portal-search-field");
  const apiBase = form.dataset.portalSearchApi;
  if (!input || !field || !apiBase) return;

  const flavour = form.dataset.portalSearchFlavour || "freva";
  const fixed = readFixed(form.dataset.portalSearchFacets);
  const source = createSource(apiBase, flavour, fixed);

  const listId = `${input.id || "portal-search"}-list`;
  const list = document.createElement("ul");
  list.id = listId;
  list.className = "portal-suggest";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Matching values");
  list.hidden = true;
  field.appendChild(list);

  // Script-only, so it is created here rather than in the document: with no script there is no
  // lookup to wait for.
  const busy = document.createElement("span");
  busy.className = "portal-search-suggesting";
  busy.setAttribute("aria-hidden", "true");
  field.appendChild(busy);

  // Announced as a combobox only now that there is a list to announce.
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", listId);

  let rows: Suggestion[] = [];
  let active = -1;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Whether a lookup is in flight, mirrored onto the field for the stylesheet. The first keystroke
   * costs a round-trip to `metadata-search`, which on a cold API is several seconds of a visitor
   * typing into what would otherwise look like an inert input. On the field rather than the form,
   * because the form's own busy state means "navigating away".
   */
  const pending = (on: boolean): void => {
    if (on) field.dataset.portalSuggesting = "true";
    else delete field.dataset.portalSuggesting;
    input.setAttribute("aria-busy", on ? "true" : "false");
  };
  /** Guards against a slow response overwriting a newer one. */
  let generation = 0;
  let submitting = false;

  const close = (): void => {
    rows = [];
    active = -1;
    pending(false);
    list.replaceChildren();
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  };

  const highlight = (next: number): void => {
    active = next;
    [...list.children].forEach((node, index) => {
      const option = node as HTMLElement;
      const on = index === active;
      option.setAttribute("aria-selected", on ? "true" : "false");
      option.classList.toggle("is-active", on);
    });
    if (active >= 0) {
      input.setAttribute("aria-activedescendant", `${listId}-${active}`);
      (list.children[active] as HTMLElement | undefined)?.scrollIntoView({ block: "nearest" });
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  };

  /** Navigate to the target route with this value applied as a facet. */
  const go = (pick: Suggestion | null, text: string): void => {
    const facets: Record<string, string[]> = {};
    for (const [key, values] of Object.entries(fixed)) facets[key] = [...values];
    if (pick) facets[pick.key] = [pick.value];
    const query = serializeSearchIntentV1({
      v: 1,
      ...(pick ? {} : text.trim() ? { q: text.trim() } : {}),
      flavour,
      ...(Object.keys(facets).length ? { facets } : {}),
    });
    // The same busy marker the plain submit sets: choosing a row navigates without a submit
    // event, and a row that swallows the click and then sits there reads as a dead list.
    form.dataset.portalSearching = "true";
    window.location.assign(query ? `${form.action}?${query}` : form.action);
  };

  const choose = (index: number): void => {
    const row = rows[index];
    if (!row) return;
    input.value = row.value;
    close();
    go(row, row.value);
  };

  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    const text = input.value.trim();
    if (!text) {
      close();
      return;
    }
    timer = setTimeout(() => {
      const mine = ++generation;
      // Marked only once the request is really going out. The stylesheet fades the spinner in
      // after a beat, so a locally-ranked keystroke never flashes one.
      pending(true);
      void source
        .suggest(text)
        .catch(() => [] as Suggestion[])
        .then((next) => {
          if (mine !== generation) return;
          pending(false);
          // The visitor may have cleared the box while the ranking was in flight.
          if (!input.value.trim()) return;
          if (!next.length) {
            close();
            return;
          }
          rows = next;
          list.replaceChildren();
          rows.forEach((row, index) => {
            const option = document.createElement("li");
            option.id = `${listId}-${index}`;
            option.className = "portal-suggest-item";
            option.setAttribute("role", "option");
            option.setAttribute("aria-selected", "false");
            const key = document.createElement("span");
            key.className = "portal-suggest-key";
            key.textContent = row.label;
            const value = document.createElement("span");
            value.className = "portal-suggest-value";
            value.textContent = row.value;
            const count = document.createElement("span");
            count.className = "portal-suggest-count";
            count.textContent = String(row.count);
            option.append(key, value);
            // Only when there is one: an empty element would still take a column.
            if (row.desc) {
              const desc = document.createElement("span");
              desc.className = "portal-suggest-desc";
              // textContent, never innerHTML: descriptions are deployment data.
              desc.textContent = row.desc;
              option.append(desc);
            }
            option.append(count);
            // `mousedown`, not `click`: the input's blur closes the list before a click lands.
            option.addEventListener("mousedown", (event) => {
              event.preventDefault();
              choose(index);
            });
            list.appendChild(option);
          });
          list.hidden = false;
          input.setAttribute("aria-expanded", "true");
          highlight(-1);
        });
    }, DEBOUNCE_MS);
  };

  input.addEventListener("input", schedule);
  input.addEventListener("focus", () => {
    if (input.value.trim() && !rows.length) schedule();
  });
  input.addEventListener("blur", () => close());
  input.addEventListener("keydown", (event) => {
    const key = event.key;
    if (key === "Escape") {
      close();
      return;
    }
    if (!rows.length) return;
    if (key === "ArrowDown") {
      event.preventDefault();
      highlight(active + 1 >= rows.length ? 0 : active + 1);
    } else if (key === "ArrowUp") {
      event.preventDefault();
      highlight(active - 1 < 0 ? rows.length - 1 : active - 1);
    } else if (key === "Enter" && active >= 0) {
      // Only when a row is highlighted; otherwise the form submits, the free-text path below.
      event.preventDefault();
      choose(active);
    }
  });

  form.addEventListener("submit", (event) => {
    if (submitting) return;
    const text = input.value.trim();
    if (!text) return;
    // Submitting without choosing a row still means "this value" when the text names one exactly.
    // Resolving that needs the facet list, which may not be loaded yet, so the submit is deferred
    // rather than guessed at; if the lookup fails the form is submitted unchanged, which is the
    // request the no-script path would have made.
    event.preventDefault();
    void source
      .exactMatch(text)
      .then((exact) => go(exact, text))
      .catch(() => {
        submitting = true;
        form.submit();
      });
  });
}

export function initSearchSuggestions(): void {
  for (const form of document.querySelectorAll<HTMLFormElement>("[data-portal-search-api]")) {
    attach(form);
  }
}
