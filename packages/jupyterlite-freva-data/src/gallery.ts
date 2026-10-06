// The example gallery: the site's example notebooks as cards - each with its own figure (the first
// picture among its saved outputs), its title, a line on what it does and how many steps it has.
// A search narrows them; a card opens the visitor's copy. Each notebook is read when the gallery
// first shows it, a few at a time, and remembered for the session.

import { Widget } from "@lumino/widgets";

export interface GallerySeed {
  path: string;
  title?: string;
}

/** What a card shows of a notebook. */
export interface NotebookSummary {
  /** A data URL of its first saved picture, or null. */
  image: string | null;
  /** The first paragraph of its introduction, as plain text. */
  description: string;
  /** Its code cells. */
  steps: number;
}

const PICTURES = ["image/png", "image/jpeg"];

/** Plain text from a Markdown paragraph: no links' targets, emphasis or code marks. */
function plain(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const text = (source: unknown): string =>
  Array.isArray(source) ? source.join("") : typeof source === "string" ? source : "";

/** The card's view of a notebook (nbformat 4). */
export function summarize(notebook: unknown): NotebookSummary {
  const cells = (notebook as { cells?: unknown[] } | null)?.cells;
  const list = Array.isArray(cells) ? (cells as Array<Record<string, unknown>>) : [];
  let image: string | null = null;
  let description = "";
  let steps = 0;
  for (const cell of list) {
    if (cell.cell_type === "code") {
      steps += 1;
      for (const output of Array.isArray(cell.outputs) ? cell.outputs : []) {
        const data = (output as { data?: Record<string, unknown> }).data ?? {};
        const mime: string | undefined = image
          ? undefined
          : PICTURES.find((m) => typeof data[m] === "string");
        if (mime) image = `data:${mime};base64,${String(data[mime]).replace(/\s/g, "")}`;
      }
    } else if (cell.cell_type === "markdown" && !description) {
      // The first paragraph that is neither a heading nor a quote.
      const paragraph = text(cell.source)
        .split(/\n\s*\n/)
        .map((p) => p.trim())
        .find((p) => p && !p.startsWith("#") && !p.startsWith(">"));
      if (paragraph) description = plain(paragraph);
    }
  }
  return { image, description, steps };
}

/** One sentence or two, up to about `max` characters. */
export function shorten(description: string, max = 170): string {
  if (description.length <= max) return description;
  let out = "";
  for (const sentence of description.split(/(?<=[.!?])\s+/)) {
    if (out && out.length + sentence.length + 1 > max) break;
    out = out ? `${out} ${sentence}` : sentence;
  }
  return out.length <= max ? out : `${description.slice(0, max - 1).trimEnd()}…`;
}

export interface GalleryOptions {
  seeds: GallerySeed[];
  /** The seed the site opens at start: its card says "Start here". */
  start?: string | null;
  /** A seed's notebook content. */
  read: (path: string) => Promise<unknown>;
  /** Whether the visitor already has their copy of `path`. */
  hasCopy?: (path: string) => Promise<boolean>;
  /** A card was chosen. */
  choose: (seed: GallerySeed) => void;
  /** Summaries already read, kept between openings of the gallery. */
  cache?: Map<string, Promise<NotebookSummary>>;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", content = "") => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content) node.textContent = content;
  return node;
};

/** How many notebooks are read at once. */
const AT_ONCE = 3;

export class ExampleGallery extends Widget {
  readonly cards: HTMLButtonElement[] = [];
  readonly #search = el("input", "jp-FrevaData-gallerySearch");
  readonly #empty = el("p", "jp-FrevaData-galleryEmpty", "No example matches that.");
  readonly #cache: Map<string, Promise<NotebookSummary>>;
  readonly #loaded: Promise<void>;

  constructor(private readonly options: GalleryOptions) {
    super();
    this.addClass("jp-FrevaData-gallery");
    this.#cache = options.cache ?? new Map();
    const intro = el(
      "p",
      "jp-FrevaData-galleryIntro",
      "Worked analyses with their figures already there. Pick one: it opens as your own copy, " +
        "ready to run and change.",
    );
    this.#search.type = "search";
    this.#search.placeholder = "Search the examples";
    this.#search.setAttribute("aria-label", "Search the examples");
    this.#search.addEventListener("input", () => this.filter(this.#search.value));
    const grid = el("div", "jp-FrevaData-galleryGrid");
    grid.setAttribute("role", "list");
    options.seeds.forEach((seed, index) => {
      const card = this.#card(seed, index);
      this.cards.push(card);
      grid.append(card);
    });
    this.#empty.hidden = true;
    this.node.append(intro, this.#search, grid, this.#empty);
    this.#loaded = this.#load();
  }

  /** Every card's notebook read (or failed). */
  get loaded(): Promise<void> {
    return this.#loaded;
  }

  /** Shows the cards whose title or description has every word of `query`. */
  filter(query: string): void {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    for (const card of this.cards) {
      const hay = (card.dataset.search ?? "").toLowerCase();
      const match = words.every((w) => hay.includes(w));
      card.hidden = !match;
      if (match) shown += 1;
    }
    this.#empty.hidden = shown > 0;
  }

  /** The search takes the focus when the gallery shows. */
  focusSearch(): void {
    this.#search.focus();
  }

  #card(seed: GallerySeed, index: number): HTMLButtonElement {
    const title =
      seed.title ??
      seed.path
        .split("/")
        .pop()!
        .replace(/\.ipynb$/, "");
    const card = el("button", "jp-FrevaData-galleryCard jp-mod-loading");
    card.type = "button";
    card.setAttribute("role", "listitem");
    card.dataset.path = seed.path;
    card.dataset.search = title;
    const figure = el("div", "jp-FrevaData-galleryFigure");
    figure.append(el("span", "jp-FrevaData-galleryNumber", String(index + 1).padStart(2, "0")));
    if (seed.path === this.options.start) {
      figure.append(el("span", "jp-FrevaData-galleryRibbon", "Start here"));
    }
    const body = el("div", "jp-FrevaData-galleryBody");
    body.append(
      el("span", "jp-FrevaData-galleryTitle", title),
      el("span", "jp-FrevaData-galleryText"),
      el("span", "jp-FrevaData-galleryMeta"),
    );
    card.append(figure, body);
    card.title = `Open ${title}`;
    card.addEventListener("click", () => this.options.choose(seed));
    return card;
  }

  async #load(): Promise<void> {
    const queue = [...this.options.seeds.keys()];
    const next = async (): Promise<void> => {
      for (let i = queue.shift(); i !== undefined; i = queue.shift()) {
        await this.#fill(i);
      }
    };
    await Promise.all(Array.from({ length: Math.min(AT_ONCE, queue.length) }, next));
  }

  async #fill(index: number): Promise<void> {
    const seed = this.options.seeds[index]!;
    const card = this.cards[index]!;
    let summary = this.#cache.get(seed.path);
    if (!summary) {
      summary = this.options.read(seed.path).then(summarize);
      this.#cache.set(seed.path, summary);
      // A read that failed is tried again next time.
      summary.catch(() => this.#cache.delete(seed.path));
    }
    const [read, mine] = await Promise.all([
      summary.catch(() => null),
      this.options.hasCopy?.(seed.path).catch(() => false) ?? Promise.resolve(false),
    ]);
    if (this.isDisposed) return;
    card.classList.remove("jp-mod-loading");
    const figure = card.querySelector(".jp-FrevaData-galleryFigure")!;
    if (read?.image) {
      const img = el("img", "jp-FrevaData-galleryImage");
      img.alt = "";
      img.loading = "lazy";
      img.src = read.image;
      figure.prepend(img);
    } else figure.classList.add("jp-mod-noImage");
    const description = read ? shorten(read.description) : "";
    card.querySelector(".jp-FrevaData-galleryText")!.textContent = description;
    card.dataset.search = `${card.dataset.search ?? ""} ${read?.description ?? ""}`;
    const meta = card.querySelector(".jp-FrevaData-galleryMeta")!;
    const steps = read?.steps ? `${read.steps} step${read.steps === 1 ? "" : "s"}` : "";
    meta.replaceChildren(el("span", "", steps));
    if (mine) {
      meta.append(el("span", "jp-FrevaData-galleryMine", "Your copy"));
      card.title = `${card.title} (your copy, as you left it)`;
    }
    meta.append(el("span", "jp-FrevaData-galleryOpen", mine ? "Continue →" : "Open →"));
    if (this.#search.value) this.filter(this.#search.value);
  }
}
