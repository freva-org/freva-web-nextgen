// The Conversations drawer's data, without the DOM: the threads loaded so far, a search over
// them, groups by day ("Today", "Yesterday", "Earlier") and how each time is shown.

import type { StoredThreadSummary } from "./api.js";

export interface ThreadGroup {
  label: "Today" | "Yesterday" | "Earlier";
  threads: StoredThreadSummary[];
}

function dayStart(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** The start of the calendar day before `date`'s (a day can be 23 or 25 hours long). */
function previousDayStart(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1).getTime();
}

/** Server dates are ISO strings; anything unreadable sorts last and shows as given. */
export function parseDate(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function groupThreads(
  threads: readonly StoredThreadSummary[],
  now: Date = new Date(),
): ThreadGroup[] {
  const today = dayStart(now);
  const yesterday = previousDayStart(now);
  const groups: ThreadGroup[] = [
    { label: "Today", threads: [] },
    { label: "Yesterday", threads: [] },
    { label: "Earlier", threads: [] },
  ];
  for (const thread of threads) {
    const date = parseDate(thread.date);
    const day = date ? dayStart(date) : -Infinity;
    groups[day >= today ? 0 : day >= yesterday ? 1 : 2]!.threads.push(thread);
  }
  return groups.filter((group) => group.threads.length > 0);
}

/** "Today, 08:42", "Yesterday, 17:05", or "2 Oct 2024". */
export function threadTime(
  value: string,
  now: Date = new Date(),
  locale: string | undefined = undefined,
): string {
  const date = parseDate(value);
  if (!date) return value;
  const day = dayStart(date);
  const today = dayStart(now);
  const time = date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  if (day >= today) return `Today, ${time}`;
  if (day >= previousDayStart(now)) return `Yesterday, ${time}`;
  return date.toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" });
}

/** Threads whose topic holds every word of the query, in any case. */
export function filterThreads(
  threads: readonly StoredThreadSummary[],
  query: string,
): StoredThreadSummary[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...threads];
  return threads.filter((thread) => {
    const topic = thread.topic.toLowerCase();
    return words.every((word) => topic.includes(word));
  });
}

/** Pages of threads as the server returns them, without duplicates when the list shifts. */
export class ThreadPages {
  readonly #threads: StoredThreadSummary[] = [];
  #page = 0;
  #total = 0;
  #loaded = false;

  constructor(
    private readonly load: (
      page: number,
      size: number,
    ) => Promise<{ threads: StoredThreadSummary[]; total: number }>,
    private readonly size = 20,
  ) {}

  get threads(): readonly StoredThreadSummary[] {
    return this.#threads;
  }
  get total(): number {
    return this.#total;
  }
  get loaded(): boolean {
    return this.#loaded;
  }
  get hasMore(): boolean {
    return this.#loaded && this.#threads.length < this.#total;
  }

  /** From the first page again, as many pages as were shown (the drawer reopened, a sign-in). */
  async reload(): Promise<void> {
    const pages = Math.max(1, this.#page);
    // Loaded aside and swapped in whole: the list on screen stays put while it reloads.
    const fresh = new ThreadPages(this.load, this.size);
    for (let i = 0; i < pages; i += 1) {
      await fresh.more();
      if (!fresh.hasMore) break;
    }
    this.#threads.splice(0, this.#threads.length, ...fresh.#threads);
    this.#page = fresh.#page;
    this.#total = fresh.#total;
    this.#loaded = true;
  }

  /** A thread renamed here: shown at once, before the next load. */
  rename(threadId: string, topic: string): void {
    const thread = this.#threads.find((t) => t.threadId === threadId);
    if (thread) thread.topic = topic;
  }

  /** A thread deleted here. */
  remove(threadId: string): void {
    const at = this.#threads.findIndex((t) => t.threadId === threadId);
    if (at < 0) return;
    this.#threads.splice(at, 1);
    this.#total = Math.max(0, this.#total - 1);
  }

  /** Back to nothing loaded (signed out). */
  clear(): void {
    this.#threads.length = 0;
    this.#page = 0;
    this.#total = 0;
    this.#loaded = false;
  }

  async more(): Promise<void> {
    const { threads, total } = await this.load(this.#page, this.size);
    const seen = new Set(this.#threads.map((t) => t.threadId));
    for (const thread of threads) if (!seen.has(thread.threadId)) this.#threads.push(thread);
    this.#total = threads.length === 0 ? this.#threads.length : total;
    this.#page += 1;
    this.#loaded = true;
  }
}

type PageLoader = (
  page: number,
  size: number,
) => Promise<{ threads: StoredThreadSummary[]; total: number }>;

/**
 * One account's pages at a time. A sign-in change (`reset`) starts a new list: a load still in
 * flight for the previous account is dropped when it lands, and the new account's load is a new
 * request. A reload asked for while a load runs (`load(true)`) runs after it, so a change that
 * arrives mid-load is not lost.
 */
export class AccountThreads {
  #pages: ThreadPages;
  #session = 0;
  #inflight: { session: number; promise: Promise<void> } | null = null;
  #again = false;
  #error: string | null = null;

  constructor(
    private readonly loader: PageLoader,
    private readonly onChange: () => void = () => undefined,
    private readonly size = 20,
  ) {
    this.#pages = new ThreadPages(loader, size);
  }

  get pages(): ThreadPages {
    return this.#pages;
  }
  get loading(): boolean {
    return this.#inflight?.session === this.#session;
  }
  /** Why the last load failed, until the next one. */
  get error(): string | null {
    return this.#error;
  }

  /** Another account, or none: nothing of the previous list, or its loads, carries over. */
  reset(): void {
    this.#session += 1;
    this.#pages = new ThreadPages(this.loader, this.size);
    this.#inflight = null;
    this.#again = false;
    this.#error = null;
    this.onChange();
  }

  /** From the start (`true`), or the next page. */
  load(fromStart: boolean): Promise<void> {
    if (this.loading) {
      if (fromStart) this.#again = true;
      return this.#inflight!.promise;
    }
    const session = this.#session;
    const pages = this.#pages;
    this.#error = null;
    const promise = (fromStart ? pages.reload() : pages.more())
      .catch((error: unknown) => {
        if (session === this.#session) {
          this.#error = error instanceof Error ? error.message : String(error);
        }
      })
      .finally(() => {
        if (session !== this.#session) return;
        this.#inflight = null;
        if (this.#again) {
          this.#again = false;
          void this.load(true);
        }
        this.onChange();
      });
    this.#inflight = { session, promise };
    this.onChange();
    return promise;
  }
}
