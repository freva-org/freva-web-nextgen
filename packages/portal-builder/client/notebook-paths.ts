/**
 * Where the notebook site keeps an example's seed notebook. `prepare-notebook` writes the same
 * path (`notebookSeedPath` in `src/model/notebook.ts`); `tests/model/session-choices.test.ts`
 * keeps the two equal.
 */
export function notebookSeedPath(digest: string): string {
  return `examples/example-${digest.slice(0, 12)}.ipynb`;
}

/**
 * What "Open as notebook" opens: the seed notebook of the registered example the visitor ran
 * last, or - after anything else (an edited snippet, whose source no seed holds) - the notebook's
 * file list.
 */
export class NotebookTarget {
  #digest: string | null = null;

  /** A registered example ran (its digest, or null when the page has none for it). */
  ranExample(digest: string | null): void {
    this.#digest = digest;
  }

  /** Visitor source ran: no seed notebook is that code. */
  ranOther(): void {
    this.#digest = null;
  }

  get hasExample(): boolean {
    return this.#digest !== null;
  }

  url(origin: string): string {
    return this.#digest
      ? `${origin}/notebook/notebooks/index.html?path=${encodeURIComponent(notebookSeedPath(this.#digest))}`
      : `${origin}/notebook/tree/index.html`;
  }
}
