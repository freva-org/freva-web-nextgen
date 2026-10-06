// A remote thread is busy until ClimateClaw has ended its stream, not when this page stopped
// listening: a stop is a request the server honours on its next check (every few seconds), and a
// broken connection leaves the server still answering. A new request on a busy thread is refused
// with HTTP 409. So every stream holds its thread here until the server is done with it, and the
// next request on that thread waits; a 409 that still comes is retried for a while.

import { ClimateClawError } from "./api.js";

/** How long a thread stays held after a stop was requested or a stream broke. */
export const SETTLE_MS = 3_500;

export class ThreadGate {
  readonly #held = new Map<string, Promise<void>>();

  /** The thread is busy until `until` settles (added to whatever holds it already). */
  hold(thread: string, until: Promise<unknown>): void {
    const before = this.#held.get(thread) ?? Promise.resolve();
    const tail = Promise.all([before, until.then(noop, noop)]).then(noop);
    this.#held.set(thread, tail);
    void tail.then(() => {
      if (this.#held.get(thread) === tail) this.#held.delete(thread);
    });
  }

  busy(thread: string): boolean {
    return this.#held.has(thread);
  }

  /** Resolves when nothing holds the thread (at once when nothing does). */
  async wait(thread: string, signal?: AbortSignal): Promise<void> {
    for (let held = this.#held.get(thread); held; held = this.#held.get(thread)) {
      await abortable(held, signal);
    }
  }
}

function noop(): void {
  // settled
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return abortable(new Promise<void>((resolve) => setTimeout(resolve, ms)), signal);
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException("stopped", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("stopped", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function isConflict(error: unknown): boolean {
  return error instanceof ClimateClawError && error.status === 409;
}

/**
 * Runs `request`, again after a pause while the server answers 409 (the thread is still ending a
 * stream), up to `attempts` times; `onWait` is told each time it waits.
 */
export async function retryConflict<T>(
  request: () => Promise<T>,
  options: { signal?: AbortSignal; attempts?: number; delayMs?: number; onWait?: () => void } = {},
): Promise<T> {
  const attempts = options.attempts ?? 8;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      if (!isConflict(error) || attempt >= attempts) throw error;
      options.onWait?.();
      await delay(options.delayMs ?? 1_500, options.signal);
    }
  }
}
