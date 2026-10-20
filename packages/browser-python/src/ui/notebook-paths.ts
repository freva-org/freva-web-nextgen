/**
 * Where the notebook site keeps an example's seed notebook. portal-builder's `prepare-notebook`
 * writes the same path (`notebookSeedPath` in its `src/model/notebook.ts`), and its
 * `tests/model/session-choices.test.ts` keeps the two equal.
 */
export function notebookSeedPath(digest: string): string {
  return `examples/example-${digest.slice(0, 12)}.ipynb`;
}

/**
 * What "Open as notebook" opens: the seed notebook of the registered example the visitor ran
 * last; after a tree recipe ran on a store, a notebook on that store (no seed holds a recipe bound
 * to a store the visitor picked); or - after anything else (an edited snippet, whose source no
 * seed holds) - the notebook's file list.
 */
export class NotebookTarget {
  #seed: string | null = null;
  #dataset: string | null = null;

  /**
   * A registered example ran: its digest, or null when the page has none for it, and the
   * notebook the site published for it, when that is not the per-example seed - a documentation
   * site that publishes one notebook per lesson names the lesson's.
   */
  ranExample(digest: string | null, notebook?: string): void {
    this.#seed = notebook ?? (digest ? notebookSeedPath(digest) : null);
    this.#dataset = null;
  }

  /** A recipe ran on a store: the notebook opens on that store, through its data panel. */
  ranDataset(datasetId: string): void {
    this.#seed = null;
    this.#dataset = datasetId;
  }

  /**
   * A registered press ran. A recipe the page's binder filled for a store (`bound`) has no seed:
   * the notebook opens on the store the binder named (`dataset`, set only when the notebook's data
   * panel holds that tree), else its file list. Anything else - a document snippet, a snapshot
   * tree's example, which carries a `datasetId` too - opens its own seed, or the notebook the site
   * named for it.
   */
  ran(run: { digest: string | null; notebook?: string; bound: boolean; dataset?: string }): void {
    if (run.bound) {
      if (run.dataset) this.ranDataset(run.dataset);
      else this.ranOther();
      return;
    }
    this.ranExample(run.digest, run.notebook);
  }

  /** Visitor source ran: no seed notebook is that code. */
  ranOther(): void {
    this.#seed = null;
    this.#dataset = null;
  }

  get hasExample(): boolean {
    return this.#seed !== null || this.#dataset !== null;
  }

  url(origin: string): string {
    if (this.#dataset) {
      return `${origin}/notebook/lab/index.html?dataset=${encodeURIComponent(this.#dataset)}`;
    }
    return this.#seed
      ? `${origin}/notebook/notebooks/index.html?path=${encodeURIComponent(this.#seed)}`
      : `${origin}/notebook/tree/index.html`;
  }
}
