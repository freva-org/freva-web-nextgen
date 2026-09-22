/**
 * history-store.ts - command history: storage, prefix navigation, suggestion, reverse search.
 *
 * Pure logic over an array of strings and one storage object, which is why it is the one console
 * module with no DOM in it: every behaviour below is a unit test rather than a browser test.
 *
 * PRIVACY, stated once and honoured throughout. History is code somebody typed. It never leaves
 * the browser, there is no network call anywhere in this file, and the persistence mode is the
 * deploying application's choice - `memory` and `none` exist for shared and kiosk machines.
 */

import { DEFAULT_HISTORY_OPTIONS, type ConsoleHistoryOptions } from "./console-types.js";

/**
 * The storage key: namespaced by package, VERSIONED, then by the caller's key. The version lets
 * the shape change without a stale array from an older release being read back as current; the
 * caller's key lets two consoles on one page keep separate histories.
 */
export const HISTORY_KEY_PREFIX = "@freva-org/browser-python:history:v1:";

export function historyStorageKey(key: string): string {
  return `${HISTORY_KEY_PREFIX}${key}`;
}

/** The subset of Storage used here, so a test can pass a fake and a failure can be simulated. */
export interface HistoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function pickStorage(mode: ConsoleHistoryOptions["persistence"]): HistoryStorage | null {
  if (mode === "memory" || mode === "none" || mode === undefined) return null;
  if (typeof globalThis === "undefined") return null;
  try {
    const store = mode === "session" ? globalThis.sessionStorage : globalThis.localStorage;
    if (!store) return null;
    // Probe rather than trust. Storage EXISTS and throws on write in a private window, under a
    // blocking cookie policy, and in a sandboxed iframe - so the only honest test is a write.
    const probe = `${HISTORY_KEY_PREFIX}probe`;
    store.setItem(probe, "1");
    store.removeItem(probe);
    return store;
  } catch {
    return null;
  }
}

/** The result of a history navigation step. `null` means "nothing to move to". */
export interface HistoryNavigation {
  value: string;
  /** True when the caller has walked back past the newest match to their own draft. */
  isDraft: boolean;
}

export class HistoryStore {
  readonly #options: Required<ConsoleHistoryOptions>;
  readonly #storage: HistoryStorage | null;
  #entries: string[] = [];

  /**
   * Navigation cursor. `-1` means "not navigating"; otherwise an index into the CURRENT match set,
   * counted from the newest backwards.
   */
  #cursor = -1;
  #matches: string[] = [];
  /** What the user had typed before they started walking history, restored when they walk back. */
  #draft = "";

  constructor(options: ConsoleHistoryOptions = {}, storage?: HistoryStorage | null) {
    this.#options = { ...DEFAULT_HISTORY_OPTIONS, ...options };
    this.#storage = storage === undefined ? pickStorage(this.#options.persistence) : storage;
    this.#entries = this.#load();
  }

  get options(): Required<ConsoleHistoryOptions> {
    return this.#options;
  }

  /** Oldest first, as stored. A copy: callers must not be able to mutate the history in place. */
  get entries(): readonly string[] {
    return [...this.#entries];
  }

  /** True when history is being kept somewhere durable rather than only in memory. */
  get persisted(): boolean {
    return this.#storage !== null;
  }

  #load(): string[] {
    if (!this.#options.enabled || !this.#storage) return [];
    try {
      const raw = this.#storage.getItem(historyStorageKey(this.#options.key));
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      // Filtered on the way in: a hand-edited or corrupted entry must not be able to put a
      // non-string into the buffer and crash the first Up press.
      return parsed
        .filter((v): v is string => typeof v === "string")
        .slice(-this.#options.maxEntries);
    } catch {
      return [];
    }
  }

  #persist(): void {
    if (!this.#storage) return;
    try {
      this.#storage.setItem(historyStorageKey(this.#options.key), JSON.stringify(this.#entries));
    } catch {
      // Quota, or a policy change mid-session. History is a convenience; a console that stops
      // working because it could not save one is worse than one that quietly forgets.
    }
  }

  /**
   * Record a submitted command. A completed MULTI-LINE submission arrives as one string with
   * newlines, deliberately: a `def` recalled as four unrelated entries is debris, and Up would
   * hand back `    return value * 2` on its own.
   */
  add(command: string): void {
    if (!this.#options.enabled) return;
    // `"none"` means none: not "in memory only". `pickStorage` returns null for both `"memory"`
    // and `"none"`, so without this they would be the same mode - the command remembered for the
    // session and Up recalling it. A host that chose `"none"` on a shared or kiosk machine asked
    // for the opposite, and has no way to tell it did not happen.
    if (this.#options.persistence === "none") return;
    if (command.trim() === "") return; // a blank line completes a block; it is not a command
    // Consecutive duplicates only. A command repeated after other work is genuinely two events.
    if (this.#entries[this.#entries.length - 1] === command) {
      this.resetNavigation();
      return;
    }
    this.#entries.push(command);
    if (this.#entries.length > this.#options.maxEntries) {
      this.#entries = this.#entries.slice(-this.#options.maxEntries);
    }
    this.#persist();
    this.resetNavigation();
  }

  clear(): void {
    this.#entries = [];
    this.resetNavigation();
    if (!this.#storage) return;
    try {
      this.#storage.removeItem(historyStorageKey(this.#options.key));
    } catch {
      // see #persist
    }
  }

  resetNavigation(): void {
    this.#cursor = -1;
    this.#matches = [];
    this.#draft = "";
  }

  /**
   * Step to an older entry. The match set is computed ONCE, when navigation starts, from the
   * draft's prefix - not on every keypress, because landing on a longer entry would then change
   * the set you are walking and Down would not return you where Up came from.
   */
  previous(current: string): HistoryNavigation | null {
    if (!this.#options.enabled || this.#entries.length === 0) return null;
    if (this.#cursor === -1) {
      this.#draft = current;
      this.#matches = this.#matchesFor(current);
      if (this.#matches.length === 0) return null;
    }
    if (this.#cursor + 1 >= this.#matches.length) return null;
    this.#cursor += 1;
    return { value: this.#matches[this.#matches.length - 1 - this.#cursor]!, isDraft: false };
  }

  /** Step to a newer entry, and past the newest back to the user's own draft. */
  next(): HistoryNavigation | null {
    if (this.#cursor === -1) return null;
    if (this.#cursor === 0) {
      const draft = this.#draft;
      this.resetNavigation();
      return { value: draft, isDraft: true };
    }
    this.#cursor -= 1;
    return { value: this.#matches[this.#matches.length - 1 - this.#cursor]!, isDraft: false };
  }

  #matchesFor(prefix: string): string[] {
    if (!this.#options.prefixNavigation || prefix === "") return [...this.#entries];
    return this.#entries.filter((entry) => entry.startsWith(prefix));
  }

  /**
   * The ghost-text suggestion: the newest entry that STARTS WITH what is typed and is longer.
   * Returns the unmatched SUFFIX, because the caller renders it after the caret and must never
   * touch the input's real value - a suggestion that edited the buffer could reach the engine.
   */
  suggest(current: string): string | null {
    if (!this.#options.enabled || !this.#options.prefixAutocomplete) return null;
    if (current === "") return null;
    for (let i = this.#entries.length - 1; i >= 0; i -= 1) {
      const entry = this.#entries[i]!;
      if (entry.length > current.length && entry.startsWith(current)) {
        return entry.slice(current.length);
      }
    }
    return null;
  }

  /** Reverse search: newest first, substring match, `skip` older matches already stepped past. */
  search(query: string, skip = 0): { value: string; index: number } | null {
    if (!this.#options.enabled || !this.#options.reverseSearch) return null;
    if (query === "") return null;
    let seen = 0;
    for (let i = this.#entries.length - 1; i >= 0; i -= 1) {
      const entry = this.#entries[i]!;
      if (!entry.includes(query)) continue;
      if (seen === skip) return { value: entry, index: i };
      seen += 1;
    }
    return null;
  }
}
