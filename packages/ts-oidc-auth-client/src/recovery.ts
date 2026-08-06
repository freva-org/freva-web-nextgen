/**
 * Recovery state.
 *
 * A fail-closed outcome is state, not a one-shot event. A revocation that
 * failed stays recorded here, because this registry holds the only reference
 * to a credential the server still honours and a later `logout()` has to be
 * able to retry it.
 *
 * This module owns the answer to one question: "which credentials does this
 * page know about that may still be usable, and has anything actually
 * invalidated them?" Nothing here performs I/O - the client does the revoking
 * and reports per-target outcomes back.
 */
import type { StoredToken } from "./types.js";
import { AuthError } from "./token.js";

/**
 * Opaque handle for one credential-producing operation.
 *
 * Callers release the handle they were given - never a value derived from the
 * token - so two operations carrying an identical access token cannot release
 * each other's registration.
 */
export type CredentialHandle = symbol;

/** A revocation target: one value plus the RFC 7009 hint it is sent with. */
export interface RevocationTarget {
  token: string;
  hint: "refresh_token" | "access_token";
  /** The credential this value came from; supplies the Authorization header. */
  auth: StoredToken;
}

/** Per-target result, so a caller can see which values are still live. */
export interface RevocationOutcome {
  target: RevocationTarget;
  /** null when the server confirmed invalidation (or an ack applies). */
  error: unknown | null;
}

/**
 * Identity of a credential for retention purposes.
 *
 * NOT the access token alone. In split-token deployments two operations can
 * legitimately hold the same short-lived access token while carrying different
 * refresh credentials; collapsing them loses a refresh credential that is
 * still live. The pair is the identity.
 */
export function credentialKey(token: StoredToken): string {
  // Escaped notation, never a literal NUL in source: an embedded control
  // character makes the file binary to git and to every diff tool.
  return `${token.accessToken}\u0000${token.refreshToken ?? ""}`;
}

/** Expand a credential into the distinct values that must be revoked. */
export function revocationTargetsOf(token: StoredToken): RevocationTarget[] {
  // RFC 7009 distinguishes the two token types, and revoking the REFRESH
  // credential is what actually tears down the grant. With split tokens,
  // revoking only the access token leaves the long-lived credential alive.
  if (token.refreshToken && token.refreshToken !== token.accessToken) {
    return [
      { token: token.refreshToken, hint: "refresh_token", auth: token },
      { token: token.accessToken, hint: "access_token", auth: token },
    ];
  }
  // Broker single-token mode: one value in both roles. Hint the stronger type
  // so the server tears down the grant, not just this access token.
  return [
    {
      token: token.accessToken,
      hint: token.refreshToken ? "refresh_token" : "access_token",
      auth: token,
    },
  ];
}

/**
 * Every credential this page knows about that may still be usable.
 *
 * Two populations, one purpose:
 *
 * - **candidates**: minted, in flight, not yet confirmed as stored. A logout
 *   that does not know about them cannot invalidate them.
 * - **pending**: revocation was attempted and did not succeed. These are the
 *   dangerous ones - the credential is live, the server did not confirm
 *   otherwise, and this registry is the last thing that remembers it exists.
 *
 * A third population, **reservations**, holds the slot for an operation that
 * has asked for a credential and not yet received one.
 *
 * No population is ever evicted to satisfy a size limit. When the registry is
 * full, the next credential-producing operation is refused *before* it asks
 * the server for another credential - refusing to create one more is safe;
 * forgetting one that already exists is not.
 */
export class CredentialRegistry {
  /**
   * Slots taken by an operation that has ASKED for a credential but has not
   * yet received one.
   *
   * A reservation occupies its slot immediately, so the capacity check answers
   * "is there still room once I take mine?" rather than "is there room right
   * now?" - otherwise concurrent operations all pass the same check and the
   * limit is one no caller can actually consume.
   */
  private readonly reserved = new Set<CredentialHandle>();
  private readonly candidates = new Map<CredentialHandle, StoredToken>();
  private readonly pending = new Map<string, StoredToken>();
  /**
   * Reservations a logout drained before their response arrived. The operation
   * is over, but the server may still be about to mint for it, and that mint
   * is an orphan the moment it lands.
   */
  private readonly cancelled = new Set<CredentialHandle>();

  constructor(private readonly maxTracked = 32) {}

  /** Slots in use: reservations, registered candidates, and retained ones. */
  private inUse(): number {
    return this.reserved.size + this.candidates.size + this.pending.size;
  }

  /**
   * Reserve capacity for a credential-producing operation and OCCUPY it,
   * before the request that mints the credential is sent.
   */
  reserve(what: string): CredentialHandle {
    if (this.inUse() >= this.maxTracked) {
      throw new AuthError(
        `${what} is refused: this page is already tracking ${this.maxTracked} ` +
          "credentials that have not been confirmed invalid, and dropping one " +
          "to make room would leave a live credential with nothing left to " +
          "revoke it. Complete a logout (which retries the outstanding " +
          "invalidations) before starting more credential-producing work.",
      );
    }
    const handle = Symbol("credential-operation");
    this.reserved.add(handle);
    return handle;
  }

  /**
   * Record what the reserved operation actually received. The slot moves from
   * reserved to registered; the total does not change.
   */
  register(handle: CredentialHandle, token: StoredToken): void {
    this.reserved.delete(handle);
    this.candidates.set(handle, token);
  }

  /**
   * Free a reservation that never produced a credential - a network failure, a
   * parse failure, a storage-contract rejection, a non-success response.
   * No-op once the handle has been registered: that slot holds a real
   * credential now and is released only by `release()`.
   */
  releaseReservation(handle: CredentialHandle): void {
    this.reserved.delete(handle);
    this.cancelled.delete(handle);
  }

  /**
   * The operation finished inside its own session and storage now owns the
   * credential. Releases exactly the handle given - not "whatever has this
   * access token".
   */
  release(handle: CredentialHandle): void {
    this.reserved.delete(handle);
    this.candidates.delete(handle);
    this.cancelled.delete(handle);
  }

  /**
   * True when a logout drained this operation while it was still waiting for
   * its credential. Whatever arrives now belongs to a session that is over.
   */
  wasCancelled(handle: CredentialHandle): boolean {
    return this.cancelled.has(handle);
  }

  /** Move a credential into the retained set: it is live and unrevoked. */
  retain(token: StoredToken): void {
    this.pending.set(credentialKey(token), token);
  }

  /** Confirmed invalid (or an explicit acknowledgement applies). */
  forget(token: StoredToken): void {
    this.pending.delete(credentialKey(token));
  }

  /** True while at least one credential is known to be live and unrevoked. */
  hasPending(): boolean {
    return this.pending.size > 0;
  }

  pendingCount(): number {
    return this.pending.size;
  }

  /** Diagnostics only. */
  trackedCount(): number {
    return this.inUse();
  }

  /**
   * Everything a logout must try to invalidate: the credentials still in
   * flight plus every credential an earlier attempt failed to revoke.
   *
   * Candidates are drained (their operations are being cut off); pending
   * entries are NOT - they stay until a revocation actually succeeds.
   * Outstanding RESERVATIONS are cancelled: their slot is freed so the client
   * is usable again, and the handle is remembered so a response that arrives
   * afterwards is classified as an orphan rather than as a normal completion.
   */
  drainForInvalidation(): StoredToken[] {
    const out: StoredToken[] = [];
    const seen = new Set<string>();
    const add = (t: StoredToken) => {
      const key = credentialKey(t);
      if (seen.has(key)) return;
      seen.add(key);
      out.push(t);
    };
    for (const t of this.candidates.values()) add(t);
    this.candidates.clear();
    for (const handle of this.reserved) this.cancelled.add(handle);
    this.reserved.clear();
    for (const t of this.pending.values()) add(t);
    return out;
  }
}
