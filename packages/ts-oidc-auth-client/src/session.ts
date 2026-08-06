/**
 * Session lifecycle gate.
 *
 * Two independent things can block credential use at once - a local logout and
 * an inbound peer `session-cleared` - so blockers are independently owned: a
 * token per holder, released only by that holder. One shared flag would let
 * whichever finished first reopen the gate for the other.
 *
 * A monotonic generation covers the rest. Any operation captures the
 * generation when it starts and re-checks it after every awaited boundary; a
 * bumped generation means "the session you belong to is gone - discard your
 * result", so work begun before a logout cannot persist, cache or return a
 * credential the user has already destroyed.
 */
/**
 * An immutable lease captured at a PUBLIC operation entry and threaded through
 * every continuation of that operation.
 *
 * Capturing once, at the boundary, is what makes the check mean anything: a
 * nested method that reads a fresh generation and then revalidates against it
 * proves nothing. Every await in the whole call tree is checked against the
 * one value the lease carries.
 */
export class SessionLease {
  constructor(
    private readonly gate: SessionGate,
    readonly generation: number,
  ) {}

  valid(): boolean {
    return this.gate.stillValid(this.generation);
  }

  /** Throw unless this operation may still act on a credential. */
  assertValid(onInvalid: () => never): void {
    if (!this.valid()) onInvalid();
  }
}

export class SessionGate {
  private generation = 0;
  private readonly blockers = new Set<symbol>();
  /**
   * Blocks that a new login may NOT clear.
   *
   * A retained block is owned by whoever took it and survives login; only its
   * owner releases it, and only once the condition that caused it is actually
   * resolved. Without that, an incomplete logout - a local storage clear that
   * rejected, a backend logout that failed, a peer clear that threw - would be
   * reopened by the next `beginLogin()` with the credential still present.
   */
  private readonly retained = new Set<symbol>();

  /** The generation an operation should capture when it begins. */
  current(): number {
    return this.generation;
  }

  /** Take the lease for a public operation. Capture ONCE, at the boundary. */
  lease(): SessionLease {
    return new SessionLease(this, this.generation);
  }

  /** True while a LOCAL logout owns a block (peers are tracked separately). */
  private localBlocks = 0;
  blockLocal(): symbol {
    this.localBlocks += 1;
    return this.block();
  }
  releaseLocal(token: symbol): void {
    this.localBlocks = Math.max(0, this.localBlocks - 1);
    this.release(token);
  }
  localLogoutRunning(): boolean {
    return this.localBlocks > 0;
  }

  /**
   * Lifecycle operations that are still deciding whether the credential is
   * gone: a peer clear that has not settled, a terminal-refresh transition
   * mid-clear. Distinct from a *retained* block, which is a settled verdict.
   */
  private pendingOps = 0;
  beginPendingOp(): void {
    this.pendingOps += 1;
  }
  endPendingOp(): void {
    this.pendingOps = Math.max(0, this.pendingOps - 1);
  }

  /**
   * True while some lifecycle operation is in flight and its outcome is
   * unknown. A login must not start here: it would declare the situation
   * resolved before anything has established that the old credential is gone.
   *
   * A RETAINED block is deliberately not part of this. That state has already
   * settled - the credential may still exist, and it stays unreadable - but
   * the user is entitled to start a fresh login as their way out, and the
   * retained block survives that login untouched.
   */
  lifecycleBusy(): boolean {
    return this.localBlocks > 0 || this.pendingOps > 0;
  }

  /** True while any holder is blocking credential use. */
  blocked(): boolean {
    return this.blockers.size > 0;
  }

  /**
   * Take an independently owned block. Only the returned token releases it, so
   * a peer's clear can never unblock a local logout.
   */
  block(): symbol {
    const token = Symbol("session-block");
    this.blockers.add(token);
    return token;
  }

  release(token: symbol): void {
    this.blockers.delete(token);
    this.retained.delete(token);
  }

  /**
   * Take a block that survives `reset()`. Used for the fail-closed states an
   * incomplete logout leaves behind.
   */
  blockRetained(): symbol {
    const token = this.block();
    this.retained.add(token);
    return token;
  }

  /** Promote an existing block to a retained one (a peer clear that failed). */
  retain(token: symbol): void {
    if (this.blockers.has(token)) this.retained.add(token);
  }

  /** True while at least one retained block is held. */
  hasRetained(): boolean {
    return this.retained.size > 0;
  }

  /**
   * The session is over. Everything already in flight is now stale: its
   * captured generation no longer matches, so it must discard its result.
   */
  terminate(): void {
    this.generation += 1;
  }

  /**
   * A brand-new login starts a new session.
   *
   * It must NOT be a way to cancel a logout that is still running: clearing a
   * locally owned block would let the page keep using the credential the user
   * asked to destroy. Callers check `localLogoutRunning()` first and refuse.
   */
  reset(): void {
    this.generation += 1;
    // A deliberate new login clears peer-originated blocks only. A local
    // logout's block is released by its owner, and a retained block never
    // clears here: the credential it protects against is still present, and a
    // login is not evidence that it went away.
    if (this.localBlocks !== 0) return;
    for (const token of [...this.blockers]) {
      if (!this.retained.has(token)) this.blockers.delete(token);
    }
  }

  /**
   * True when an operation that captured `generation` may still act on a
   * credential: same session, and nothing currently blocking.
   */
  stillValid(generation: number): boolean {
    return generation === this.generation && this.blockers.size === 0;
  }
}
