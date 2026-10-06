// Live-interpreter slots. Each live interpreter is a Worker with its own WASM heap, so a page
// holds at most `MAX_LIVE_INTERPRETERS` of them; a sleeping session holds none.
//
// A reservation is atomic. In one document a synchronous check-and-take does it; across
// documents (framed sessions, which are separate documents) Web Locks do, under a scope the
// documents of one page share.
//
// What counts is what runs: when every slot is taken, a reservation puts the least recently used
// interpreter that is idle to sleep (its holder says how) and takes its slot. Only interpreters
// running code - or holders that cannot sleep - make a reservation fail. With a scope, the other
// documents' holders are reached too, over a BroadcastChannel of that scope: they offer their idle
// holders, and the least recently used one is asked to sleep. Every offer and request names one
// reservation (not just a slot index): a request that comes after that reservation ended - its
// slot released and perhaps taken by another holder - puts nothing to sleep.

export const MAX_LIVE_INTERPRETERS = 2;

export interface Slot {
  readonly index: number;
  readonly owner: string;
  /** Idempotent. */
  release(): void;
  /** Names what holds it, for a slot reserved before its holder existed (a chooser's Start). */
  claim?(holder: SlotHolder): void;
}

/** What holds a slot, so a reservation can make room by putting an idle one to sleep. */
export interface SlotHolder {
  /** True while no code runs in it. */
  idle(): boolean;
  /** When it last ran code (ms): the least recently used idle holder sleeps first. */
  lastUsed(): number;
  /** Stops its interpreter and releases its slot; rejects when it cannot now. */
  sleep(): Promise<void>;
}

export interface SlotBroker {
  readonly capacity: number;
  /**
   * A free slot - made free, when all are taken, by putting the least recently used idle holder
   * to sleep - or `null` when every slot is held by code that is running. Concurrent calls never
   * get the same slot. `holder` lets a later reservation reclaim this one.
   */
  reserve(owner: string, holder?: SlotHolder): Promise<Slot | null>;
  /** Slots held by this broker's documents right now. */
  held(): Promise<number>;
  onChange(listener: () => void): () => void;
}

interface LockManagerLike {
  request(
    name: string,
    options: { ifAvailable: boolean },
    callback: (lock: unknown) => Promise<void> | void,
  ): Promise<unknown>;
  query?(): Promise<{ held?: { name?: string }[] }>;
}

export interface SlotBrokerOptions {
  capacity: number;
  /**
   * Share slots with other documents of the same origin through Web Locks under this scope. Absent,
   * or without Web Locks, the slots belong to this document alone.
   */
  scope?: string;
  /** For tests. Defaults to `navigator.locks`. */
  locks?: LockManagerLike | null;
  /** For tests. Defaults to a `BroadcastChannel` of that name, where there is one. */
  channel?: ((name: string) => ChannelLike | null) | null;
  /** How long other documents have to offer an idle holder. */
  offerWindowMs?: number;
}

/** The part of a BroadcastChannel the brokers use. */
export interface ChannelLike {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

/** One idle holder, here or in another document, that may be put to sleep. */
interface Candidate {
  lastUsed: number;
  /** True once it slept (and so released its slot). */
  sleep(): Promise<boolean>;
}

type SlotMessage =
  | { t: "ask"; id: string; from: string }
  | {
      t: "offer";
      id: string;
      from: string;
      to: string;
      index: number;
      reservation: string;
      lastUsed: number;
    }
  | { t: "sleep"; id: string; from: string; to: string; index: number; reservation: string }
  | { t: "slept"; id: string; to: string; ok: boolean };

const randomId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36)}`;

export function createSlotBroker(options: SlotBrokerOptions): SlotBroker {
  const capacity = Math.max(1, Math.min(MAX_LIVE_INTERPRETERS, Math.floor(options.capacity)));
  const locks =
    options.locks !== undefined
      ? options.locks
      : ((globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks ?? null);
  const listeners = new Set<() => void>();
  const changed = (): void => {
    for (const listener of [...listeners]) listener();
  };
  const onChange = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  /** This document's holders, by slot index, each with the reservation it holds the slot by. */
  const holders = new Map<number, { holder: SlotHolder; reservation: string }>();
  /** One reclaim at a time: two reservations never put the same holder to sleep. */
  let reclaiming: Promise<unknown> = Promise.resolve();
  /** Puts the holder of `reservation` to sleep - only while that reservation holds its slot. */
  const sleepHolder = async (index: number, reservation: string): Promise<boolean> => {
    const entry = holders.get(index);
    if (!entry || entry.reservation !== reservation || !entry.holder.idle()) return false;
    try {
      await entry.holder.sleep();
      return true;
    } catch {
      return false;
    }
  };
  const local = (): Candidate[] =>
    [...holders.entries()]
      .filter(([, entry]) => entry.holder.idle())
      .map(([index, entry]) => ({
        lastUsed: entry.holder.lastUsed(),
        sleep: () => sleepHolder(index, entry.reservation),
      }));
  /** Other documents' idle holders (scoped brokers only). */
  let remote: () => Promise<Candidate[]> = () => Promise.resolve([]);
  /** Tries `take`; when nothing is free, puts idle holders to sleep (least recently used first). */
  const reserveOrReclaim = (take: () => Promise<Slot | null>): Promise<Slot | null> => {
    const run = reclaiming.then(async () => {
      const free = await take();
      if (free) return free;
      const candidates = [...local(), ...(await remote())].sort((a, b) => a.lastUsed - b.lastUsed);
      for (const candidate of candidates) {
        if (!(await candidate.sleep())) continue;
        // Another document's lock is let go once its holder has stopped: a moment later.
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const slot = await take();
          if (slot) return slot;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      return null;
    });
    reclaiming = run.catch(() => undefined);
    return run;
  };
  const held = (slot: Slot, first: SlotHolder | undefined): Slot => {
    // This reservation's identity: what a request to sleep must name.
    const reservation = randomId();
    let released = false;
    if (first) holders.set(slot.index, { holder: first, reservation });
    const release = slot.release.bind(slot);
    return {
      index: slot.index,
      owner: slot.owner,
      release() {
        released = true;
        if (holders.get(slot.index)?.reservation === reservation) holders.delete(slot.index);
        release();
      },
      claim(next) {
        if (released) return;
        holders.set(slot.index, { holder: next, reservation });
      },
    };
  };

  if (options.scope && locks) {
    const prefix = `freva-python-slot:${options.scope}:`;
    const mine = new Set<number>();
    const open =
      options.channel !== undefined
        ? options.channel
        : typeof BroadcastChannel === "function"
          ? (name: string) => new BroadcastChannel(name) as unknown as ChannelLike
          : null;
    const channel = open?.(`${prefix}reclaim`) ?? null;
    if (channel) {
      const me = randomId();
      const offerWindow = options.offerWindowMs ?? 150;
      const waiting = new Map<string, (message: SlotMessage) => void>();
      channel.addEventListener("message", (event) => {
        const message = event.data as SlotMessage | null;
        if (!message || typeof message !== "object") return;
        if (message.t === "ask" && message.from !== me) {
          for (const [index, { holder, reservation }] of holders) {
            if (!holder.idle()) continue;
            channel.postMessage({
              t: "offer",
              id: message.id,
              from: me,
              to: message.from,
              index,
              reservation,
              lastUsed: holder.lastUsed(),
            } satisfies SlotMessage);
          }
        } else if (message.t === "sleep" && message.to === me) {
          void sleepHolder(message.index, message.reservation).then((ok) =>
            channel.postMessage({ t: "slept", id: message.id, to: message.from, ok }),
          );
        } else if ((message.t === "offer" || message.t === "slept") && message.to === me) {
          waiting.get(message.id)?.(message);
        }
      });
      remote = async () => {
        const id = randomId();
        const offers: Extract<SlotMessage, { t: "offer" }>[] = [];
        waiting.set(id, (message) => {
          if (message.t === "offer") offers.push(message);
        });
        channel.postMessage({ t: "ask", id, from: me } satisfies SlotMessage);
        await new Promise((resolve) => setTimeout(resolve, offerWindow));
        waiting.delete(id);
        return offers.map((offer) => ({
          lastUsed: offer.lastUsed,
          sleep: () =>
            new Promise<boolean>((resolve) => {
              const ask = randomId();
              // Sleeping saves a session's files first: allow it time, but not forever.
              const timer = setTimeout(() => {
                waiting.delete(ask);
                resolve(false);
              }, 60_000);
              waiting.set(ask, (message) => {
                if (message.t !== "slept") return;
                clearTimeout(timer);
                waiting.delete(ask);
                resolve(message.ok);
              });
              channel.postMessage({
                t: "sleep",
                id: ask,
                from: me,
                to: offer.from,
                index: offer.index,
                reservation: offer.reservation,
              } satisfies SlotMessage);
            }),
        }));
      };
    }
    const tryLock = (index: number, owner: string): Promise<Slot | null> =>
      new Promise((resolve, reject) => {
        locks
          .request(`${prefix}${index}`, { ifAvailable: true }, (lock) => {
            if (!lock) {
              resolve(null);
              return;
            }
            mine.add(index);
            return new Promise<void>((done) => {
              let released = false;
              resolve({
                index,
                owner,
                release() {
                  if (released) return;
                  released = true;
                  mine.delete(index);
                  done();
                  changed();
                },
              });
            });
          })
          .catch(reject);
      });
    return {
      capacity,
      async reserve(owner, holder) {
        const slot = await reserveOrReclaim(async () => {
          for (let index = 0; index < capacity; index += 1) {
            if (mine.has(index)) continue;
            const got = await tryLock(index, owner);
            if (got) return got;
          }
          return null;
        });
        if (!slot) return null;
        changed();
        return held(slot, holder);
      },
      async held() {
        if (!locks.query) return mine.size;
        const state = await locks.query();
        return (state.held ?? []).filter((lock) => lock.name?.startsWith(prefix)).length;
      },
      onChange,
    };
  }

  const taken: (string | null)[] = Array.from({ length: capacity }, () => null);
  const take = (owner: string): Slot | null => {
    const index = taken.indexOf(null);
    if (index < 0) return null;
    taken[index] = owner;
    let released = false;
    changed();
    return {
      index,
      owner,
      release() {
        if (released) return;
        released = true;
        taken[index] = null;
        changed();
      },
    };
  };
  return {
    capacity,
    async reserve(owner, holder) {
      // A free slot is taken synchronously: concurrent calls never get the same one.
      const slot = take(owner) ?? (await reserveOrReclaim(async () => take(owner)));
      return slot ? held(slot, holder) : null;
    },
    held: () => Promise.resolve(taken.filter((owner) => owner !== null).length),
    onChange,
  };
}
