/**
 * Controlled `Window` fixtures for the embedding bridge.
 *
 * `host.ts` and `playground.ts` need a `postMessage` target, an `addEventListener("message")` and
 * a `MessagePort`, all of which are built here deterministically, with none of a browser's
 * timing. What genuinely needs a browser is the cross-origin ENFORCEMENT - that a wrong origin is
 * refused by the platform and not only by our own check - and the transfer semantics of a real
 * `ArrayBuffer`, which stay in browser-tests/embedding-two-origin.mjs.
 */

type Listener = (event: MessageEvent) => void;

/** A `postMessage` recipient that records what it was told, and by whom. */
export class FakeWindow {
  readonly listeners = new Set<Listener>();
  /** Every `postMessage` made TO this window. */
  readonly received: Array<{ data: unknown; targetOrigin: string; ports: MessagePort[] }> = [];
  /** Where a message posted to this window appears to come from. */
  peer: FakeWindow | null = null;
  origin = "https://example.test";
  /** Set when this window is meant to be the top of the tree. */
  parent: FakeWindow = this;
  /** Deliveries are refused once this is set, as they are after a frame is detached. */
  detached: string | null = null;

  postMessage(data: unknown, targetOrigin: string, ports?: MessagePort[]): void {
    if (this.detached) throw new Error(this.detached);
    this.received.push({ data, targetOrigin, ports: ports ?? [] });
    const source = this.peer;
    if (!source) return;
    const event = {
      data,
      origin: source.origin,
      source,
      ports: ports ?? [],
    } as unknown as MessageEvent;
    // Asynchronous, like the real thing: a synchronous delivery would let a test pass against code
    // that posts before it is ready to receive the answer.
    queueMicrotask(() => {
      for (const listener of [...this.listeners]) listener(event);
    });
  }

  addEventListener(type: string, listener: Listener): void {
    if (type === "message") this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    if (type === "message") this.listeners.delete(listener);
  }

  /** Deliver a message this window did not legitimately receive - a forgery, for the checks. */
  inject(data: unknown, over: { origin?: string; source?: unknown; ports?: MessagePort[] } = {}) {
    const event = {
      data,
      origin: over.origin ?? this.peer?.origin ?? this.origin,
      source: "source" in over ? over.source : this.peer,
      ports: over.ports ?? [],
    } as unknown as MessageEvent;
    for (const listener of [...this.listeners]) listener(event);
  }
}

/** A portal window and a playground window that can talk to each other. */
export function connectedWindows(portalOrigin: string, playgroundOrigin: string) {
  const portal = new FakeWindow();
  const playground = new FakeWindow();
  portal.origin = portalOrigin;
  playground.origin = playgroundOrigin;
  portal.peer = playground;
  playground.peer = portal;
  playground.parent = portal;
  portal.parent = portal;
  return { portal, playground };
}

/** Let queued microtasks and timers run, so an asynchronous exchange completes. */
export const settle = async (turns = 4): Promise<void> => {
  for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};
