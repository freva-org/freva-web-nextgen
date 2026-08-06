/**
 * Mutation gate.
 *
 * Removing a security control must make its test fail. A regression test that
 * still passes with the control deleted is proving nothing — this catches the
 * "274 tests green while 14 adversarial probes reproduce" failure mode.
 *
 * Each mutation edits a source file in place, runs ONE named test, and requires
 * a FAILURE. The file is always restored.
 *
 * Every lease check that guards a distinct continuation is mutated separately,
 * each pinned to the one test that ends the session at exactly that boundary.
 * A single global `assertLease()` mutation would prove only that *some* lease
 * check matters somewhere; it says nothing about the individual call sites, and
 * a boundary with no call site at all would still look covered.
 *
 * ANCHORING: a `find` literal is the `// MUTATION ANCHOR: <label>.` comment line
 * plus the code line(s) it guards, and nothing else. The anchor line is what
 * makes the target unique, so the explanatory prose above it in the source can
 * be rewritten freely without touching this file.
 */
import fs from "node:fs";
import { runTest } from "./mutation-runner.mjs";

const MUTATIONS = [
  // ------------------------------- validation, blocking and storage ordering
  {
    name: "runtime boolean validation removed",
    file: "src/validate.ts",
    find: 'if (typeof value !== "boolean") {',
    replace: "if (false) {",
    test: "tests/config-coercion-and-request-integrity.test.ts",
  },
  {
    name: "logout blocking removed",
    file: "src/client.ts",
    find: "    if (this.gate.blocked()) {",
    replace: "    if (false) {",
    test: "tests/config-coercion-and-request-integrity.test.ts",
  },
  {
    // The control is re-anchoring the owned Request to the VALIDATED absolute
    // href. Passing the caller's original input through instead reintroduces
    // the mutable-URL bug: the caller can change the destination after
    // validation.
    name: "destination re-anchoring removed",
    file: "src/client.ts",
    find: "    const request = new Request(dest.href, base);",
    replace: "    const request = new Request(input as RequestInfo, base);",
    test: "tests/destination-binding-and-telemetry.test.ts",
  },
  {
    // Erasing an explicitly declared refresh-capable flag lets
    // bearer-from-endpoint accept the credential it exists to exclude.
    name: "refresh-capability preservation removed",
    file: "src/token.ts",
    find: "    t.accessTokenIsRefreshCredential === true || equalTokens ? true : undefined;",
    replace: "    equalTokens ? true : undefined;",
    test: "tests/post-logout-arrivals.test.ts",
  },
  {
    name: "storage serialization removed",
    file: "src/client.ts",
    find: "    const next = this.storageMutation.then(fn, fn);",
    replace: "    const next = Promise.resolve().then(fn);",
    test: "tests/storage-serialization-and-single-flight.test.ts",
  },
  {
    // Paired edit: the `login-started` re-entrancy recheck also refuses to
    // navigate while a lifecycle operation is running, so it covers `login()`
    // even with the admission check gone. Both are removed, which is the only
    // way the admission check itself becomes observable to U1.
    name: "local-logout ownership removed",
    file: "src/client.ts",
    edits: [
      {
        // The admission check itself.
        find:
          "    if (this.gate.lifecycleBusy() || this.gate.blocked()) {\n" +
          "      throw new NotAuthenticatedError(\n" +
          "        `${what} is not available while this client is fail-closed",
        replace:
          "    if (false) {\n" +
          "      throw new NotAuthenticatedError(\n" +
          "        `${what} is not available while this client is fail-closed",
      },
      {
        // ...and the `login-started` re-entrancy recheck, which covers login()
        // even with the admission check gone.
        find:
          "    if (this.gate.lifecycleBusy() || this.gate.blocked()) {\n" +
          "      this.removeSession(this.txnKey());",
        replace: "    if (false) {\n" + "      this.removeSession(this.txnKey());",
      },
    ],
    test: "tests/logout-ownership-under-concurrency.test.ts",
    only: "login() cannot clear a locally owned logout block",
  },
  {
    name: "refresh failure-branch validation removed",
    file: "src/client.ts",
    find:
      "      // MUTATION ANCHOR: refresh failure-branch lease validation.\n" +
      "      this.assertLease(lease);",
    replace: "      // mutated",
    test: "tests/lease-propagation.test.ts",
    only: "a transient NETWORK refresh failure after a peer clear returns no stale token",
  },
  {
    name: "identity-checked single-flight cleanup removed",
    file: "src/storage/serverManaged.ts",
    find: "        if (this.inflight === mine) this.inflight = null;",
    replace: "        this.inflight = null;",
    test: "tests/storage-serialization-and-single-flight.test.ts",
  },
  {
    name: "fragment scrubbing removed",
    file: "src/url.ts",
    find: "  if (!sawProtocol) return hash;",
    replace: "  return hash; // mutated",
    test: "tests/config-coercion-and-request-integrity.test.ts",
  },

  // ------------------------------------------------------- lease call sites
  {
    name: "lease call site 1/10: initial refresh load validation",
    file: "src/client.ts",
    find:
      "    // MUTATION ANCHOR: initial refresh load validation.\n" + "    this.assertLease(lease);",
    replace: "    // mutated",
    test: "tests/lease-propagation.test.ts",
    only: "a refresh whose first storage load resolves after logout fails as session-ended",
  },
  {
    name: "lease call site 2/10: cross-tab-lock validation",
    file: "src/client.ts",
    find:
      "        // MUTATION ANCHOR: cross-tab-lock validation.\n" +
      "        this.assertLease(lease);",
    replace: "        // mutated",
    test: "tests/lease-propagation.test.ts",
    only: "a refresh that acquires the cross-tab lock after logout reads no storage",
  },
  {
    // Paired edit: the public `refresh()` completion check revalidates the same
    // lease on the way out, so it hides every deeper control on this path. The
    // mutation removes both, which is exactly the code shape being guarded
    // against.
    name: "lease call site 3/10: peer-rotation early return",
    file: "src/client.ts",
    edits: [
      {
        find:
          "          // MUTATION ANCHOR: peer-rotation early return.\n" +
          "          this.assertLease(lease);",
        replace: "          // mutated",
      },
      {
        find:
          "    // MUTATION ANCHOR: public refresh() completion lease validation.\n" +
          "    return this.refreshWithOutcome(options.force === true, lease).then((r) => {\n" +
          "      this.assertLease(lease);\n" +
          "      return r.token;\n" +
          "    });",
        replace:
          "    return this.refreshWithOutcome(options.force === true, lease).then((r) => r.token);",
      },
    ],
    test: "tests/lease-propagation.test.ts",
    only: "a peer-rotation early return does not hand back a token read after logout",
  },
  {
    // Paired edit: the public `refresh()` completion check revalidates the same
    // lease on the way out, so it hides every deeper control on this path. The
    // mutation removes both, which is exactly the code shape being guarded
    // against.
    name: "lease call site 4/10: refresh 401 branch validation",
    file: "src/client.ts",
    edits: [
      {
        find:
          "        // MUTATION ANCHOR: refresh 401 branch validation.\n" +
          "        this.assertLease(lease);",
        replace: "        // mutated",
      },
      {
        // Same branch, post-emit half.
        find:
          "          // MUTATION ANCHOR: refresh 401 branch post-emit validation.\n" +
          "          this.assertLease(lease);",
        replace: "          // mutated",
      },
      {
        find:
          "    // MUTATION ANCHOR: public refresh() completion lease validation.\n" +
          "    return this.refreshWithOutcome(options.force === true, lease).then((r) => {\n" +
          "      this.assertLease(lease);\n" +
          "      return r.token;\n" +
          "    });",
        replace:
          "    return this.refreshWithOutcome(options.force === true, lease).then((r) => r.token);",
      },
    ],
    test: "tests/lease-propagation.test.ts",
    only: "a refresh receiving 401 after logout+login does not return the new token",
  },
  {
    name: "lease call site 5/10: fetch response validation",
    file: "src/client.ts",
    find: "    // MUTATION ANCHOR: fetch response validation.\n" + "    this.assertLease(lease);",
    replace: "    // mutated",
    test: "tests/lease-propagation.test.ts",
    only: "an authenticated response arriving after logout is not returned",
  },
  {
    // Two edits, deliberately: reverting the retry to the PUBLIC refresh() is
    // only observable once the post-response check is also gone, because that
    // check would otherwise stop the operation before the retry begins.
    // Together they reconstruct the shape R3 reproduces against.
    name: "lease call site 6/10: fetch retry lease propagation",
    file: "src/client.ts",
    edits: [
      {
        find: "          token = await this.forcedRefresh(lease);",
        replace: "          token = await this.refresh({ force: true });",
      },
      {
        find:
          "    // MUTATION ANCHOR: fetch response validation.\n" + "    this.assertLease(lease);",
        replace: "    // mutated",
      },
    ],
    test: "tests/lease-propagation.test.ts",
    only: "an eligible 401 arriving after a new login does not refresh or retry",
  },
  {
    name: "lease call site 7/10: server-managed post-CSRF validation",
    file: "src/client.ts",
    find:
      "      // MUTATION ANCHOR: server-managed post-CSRF validation.\n" +
      "      this.assertLease(lease);",
    replace: "      // mutated",
    test: "tests/lease-propagation.test.ts",
    only: "a refresh waiting on CSRF after logout sends no health request and returns no token",
  },
  {
    name: "lease call site 8/10: retained failed-logout block",
    file: "src/client.ts",
    find: "            this.retainLogoutFailureBlock();",
    replace: "            void 0; // mutated",
    test: "tests/lease-propagation.test.ts",
    only: "after a rejected local clear, getToken() remains blocked",
  },
  {
    name: "lease call site 9/10: queued token snapshot",
    file: "src/client.ts",
    find:
      "        invalidate.push(...this.credentials.drainForInvalidation());\n" +
      "        if (sm) {",
    replace: "        if (sm) { // mutated",
    test: "tests/lease-propagation.test.ts",
    only: "a token still inside storage.save() when logout begins is revoked",
  },
  {
    name: "lease call site 10/10: retired peer-operation handling",
    file: "src/client.ts",
    find:
      "      if (this.isRetiredPeerOperation(key)) return;\n" +
      "      const tracked = this.peerOperations.get(key);",
    replace: "      const tracked = this.peerOperations.get(key);",
    test: "tests/lease-propagation.test.ts",
    only: "a retired peer operation's terminal message does not kill the new session",
  },

  // ----------------------------------------------------- recovery lifecycle
  {
    // The registry is the ONLY thing that remembers a credential whose
    // revocation failed. Dropping the retention makes the second logout send
    // nothing and report success.
    name: "recovery 1/9: failed revocation removed from retry registry",
    file: "src/client.ts",
    find: "      if (anyFailed) this.credentials.retain(current);",
    replace: "      if (false) this.credentials.retain(current);",
    test: "tests/recovery-lifecycle.test.ts",
    only: "a retained credential is resent to /revoke",
  },
  {
    name: "recovery 2/9: successful local recovery no longer releases peer blocks",
    file: "src/client.ts",
    find: "          this.resolveAllRecoveryBlocks();",
    replace: "          this.releaseLogoutFailureBlock();",
    test: "tests/recovery-lifecycle.test.ts",
    only: "a completed logout releases a peer-owned block",
  },
  {
    name: "recovery 3/9: pending peer clear no longer refuses login",
    file: "src/client.ts",
    edits: [
      {
        find:
          "      // MUTATION ANCHOR: pending peer clear blocks login.\n" +
          "      this.gate.beginPendingOp();",
        replace: "      // mutated",
      },
      {
        // Paired: "refuse login in every fail-closed state" also refuses while
        // this block is held, so it shadows the control under test. Both are
        // removed to make that control observable again.
        find: "    if (this.gate.lifecycleBusy() || this.gate.blocked()) {\n      throw new NotAuthenticatedError(\n        `${what} is not available while this client is fail-closed",
        replace:
          "    if (false) {\n      throw new NotAuthenticatedError(\n        `${what} is not available while this client is fail-closed",
      },
    ],
    test: "tests/recovery-lifecycle.test.ts",
    only: "an unsettled peer clear refuses login",
  },
  {
    name: "recovery 4/9: terminal refresh generation invalidation removed",
    file: "src/client.ts",
    find:
      "    const held = this.gate.blockLocal();\n" +
      "    this.gate.terminate();\n" +
      "    this.gate.beginPendingOp();",
    replace: "    const held = this.gate.block();\n    this.gate.beginPendingOp();",
    test: "tests/recovery-lifecycle.test.ts",
    only: "a terminal refresh invalidates an unrelated in-flight lease",
  },
  {
    name: "recovery 5/9: terminal clear-failure retention removed",
    file: "src/client.ts",
    find:
      "        // MUTATION ANCHOR: terminal clear-failure retention.\n" +
      "        this.retainTerminalFailureBlock();",
    replace: "        void 0; // mutated",
    test: "tests/recovery-lifecycle.test.ts",
    only: "a terminal transition whose clear fails stays blocked",
  },
  {
    // This IS the ordering: moving the scrub back after the blocked-state
    // assertion is the leak — a callback refused because the session is blocked
    // keeps `code` and `state` in the address bar and browser history.
    name: "recovery 6/9: callback scrub moved after the blocked-state assertion",
    file: "src/client.ts",
    edits: [
      {
        find:
          "    // MUTATION ANCHOR: callback scrub precedes lifecycle rejection.\n" +
          "    this.scrubCallbackParams(u, isCurrentLocation);\n" +
          '    this.assertBrowserCodeFlowAllowed("handleCallback()");\n' +
          "    this.assertNotLoggingOut();",
        replace:
          '    this.assertBrowserCodeFlowAllowed("handleCallback()");\n' +
          "    this.assertNotLoggingOut();\n" +
          "    this.scrubCallbackParams(u, isCurrentLocation);",
      },
    ],
    test: "tests/recovery-lifecycle.test.ts",
    only: "a callback refused by the blocked-session check is already scrubbed",
  },
  {
    // Both halves of the same control: the check that runs immediately after
    // the `token-refreshed` listeners, and the one in the public `refresh()`
    // completion handler. Removing either alone leaves the other covering the
    // path, so the pair is what makes the re-entrancy guard observable.
    name: "recovery 7/9: post-event lease validation removed",
    file: "src/client.ts",
    edits: [
      {
        find:
          "    // MUTATION ANCHOR: post-event lease validation.\n" + "    this.assertLease(lease);",
        replace: "    // mutated",
      },
      {
        find:
          "    // MUTATION ANCHOR: public refresh() completion lease validation.\n" +
          "    return this.refreshWithOutcome(options.force === true, lease).then((r) => {\n" +
          "      this.assertLease(lease);\n" +
          "      return r.token;\n" +
          "    });",
        replace:
          "    return this.refreshWithOutcome(options.force === true, lease).then((r) => r.token);",
      },
    ],
    test: "tests/recovery-lifecycle.test.ts",
    only: "a logout started by a token-refreshed listener wins",
  },
  {
    name: "recovery 8/9: orphan revocation result ignored",
    file: "src/client.ts",
    find:
      "    // MUTATION ANCHOR: orphan revocation result inspected.\n" +
      "    if (outcome.some((o) => o.error !== null)) this.noteOrphanRetained();",
    replace: "    void outcome; // mutated: revokeAll RETURNS its error, it does not throw",
    test: "tests/recovery-lifecycle.test.ts",
    only: "a failed orphan revocation is not reported as clean",
  },
  {
    // Two edits: both mechanisms that made a new generation wait on an old
    // one — the `settled` chain and the page-local lock chain key.
    name: "recovery 9/9: cross-generation refresh waiting restored",
    file: "src/client.ts",
    edits: [
      {
        find:
          "    const settled: Promise<RefreshOutcome | null> =\n" +
          "      current && current.generation === lease.generation\n" +
          "        ? current.promise.then(",
        replace:
          "    const settled: Promise<RefreshOutcome | null> =\n" +
          "      current\n" +
          "        ? current.promise.then(",
      },
      {
        find: "      `${this.channelName}:refresh:${lease.generation}`,",
        replace: "      `${this.channelName}:refresh`,",
      },
    ],
    test: "tests/recovery-lifecycle.test.ts",
    only: "a new generation's refresh starts without the old one settling",
  },
  {
    name: "recovery: diagnose() hides the recovery state",
    file: "src/client.ts",
    find: "    if (this.gate.hasRetained() || this.credentials.hasPending()) {",
    replace: "    if (false) {",
    test: "tests/recovery-lifecycle.test.ts",
    only: "diagnose() fails while a recovery state is held",
  },

  // --------------------------------------------------- recovery bookkeeping
  {
    // Comparing the sizes and returning a handle recorded nowhere makes the
    // capacity limit unenforceable: no caller can ever occupy a slot.
    name: "recovery bookkeeping 1/9: reservations do not occupy a slot",
    file: "src/recovery.ts",
    find: '    const handle = Symbol("credential-operation");\n    this.reserved.add(handle);',
    replace: '    const handle = Symbol("credential-operation");',
    test: "tests/credential-registry-accounting.test.ts",
    only: "with capacity 1, a second reservation is refused",
  },
  {
    name: "recovery bookkeeping 2/9: failed operations never give their slot back",
    file: "src/recovery.ts",
    find: "  releaseReservation(handle: CredentialHandle): void {\n    this.reserved.delete(handle);",
    replace:
      "  releaseReservation(handle: CredentialHandle): void {\n    if (false) this.reserved.delete(handle);",
    test: "tests/credential-registry-accounting.test.ts",
    only: "a failed callback exchange does not leak its reservation",
  },
  {
    name: "recovery bookkeeping 3/9: drained reservations are not marked cancelled",
    file: "src/recovery.ts",
    find: "    for (const handle of this.reserved) this.cancelled.add(handle);",
    replace: "    // mutated",
    test: "tests/credential-registry-accounting.test.ts",
    only: "a drained reservation classifies its late mint as an orphan",
  },
  {
    name: "recovery bookkeeping 4/9: discarded server-managed mints are dropped",
    file: "src/storage/serverManaged.ts",
    find: "        if (token) this.reportDiscardedMint(token);",
    replace: "        // mutated",
    test: "tests/credential-registry-accounting.test.ts",
    only: "a token minted after logout is revoked, not silently dropped",
  },
  {
    name: "recovery bookkeeping 5/9: terminal transition forgets the known credential",
    file: "src/client.ts",
    find: "    if (options.known) invalidate.push(options.known);",
    replace: "    void options.known; // mutated",
    test: "tests/credential-registry-accounting.test.ts",
    only: "a split-token terminal 401 still revokes the access token",
  },
  {
    name: "recovery bookkeeping 6/9: peer operations collapse to one",
    file: "src/client.ts",
    find: "  private peerKey(message: { tabId: string; operationId: string }): string {\n    return `${message.tabId}\\u0000${message.operationId}`;",
    replace:
      '  private peerKey(message: { tabId: string; operationId: string }): string {\n    void message; return "the-one-and-only-peer-operation";',
    test: "tests/credential-registry-accounting.test.ts",
    only: "one peer's terminal message does not unblock while another is outstanding",
  },
  {
    name: "recovery bookkeeping 7/9: terminal messages are not bound to a session",
    file: "src/client.ts",
    find: "      if (!tracked && !this.messageTargetsThisSession(message)) return;",
    replace: "      // mutated",
    test: "tests/credential-registry-accounting.test.ts",
    only: "a terminal message for an operation never seen cannot clear a new session",
  },
  {
    name: "recovery bookkeeping 8/9: login admitted in a retained fail-closed state",
    file: "src/client.ts",
    find: "    if (this.gate.lifecycleBusy() || this.gate.blocked()) {\n      throw new NotAuthenticatedError(\n        `${what} is not available while this client is fail-closed",
    replace:
      "    if (this.gate.lifecycleBusy()) {\n      throw new NotAuthenticatedError(\n        `${what} is not available while this client is fail-closed",
    test: "tests/credential-registry-accounting.test.ts",
    only: "after a failed peer clear, beginLogin() and login() throw and write nothing",
  },
  {
    name: "recovery bookkeeping 9/9: clear failures reported as a memory mirror",
    file: "src/client.ts",
    find:
      "    this.emit({\n" +
      '      type: "session-clear-failed",\n' +
      "      scope,\n" +
      '      reasonCode: "storage-threw",\n' +
      "      blocked: true,\n" +
      "    });",
    replace:
      "    this.emit({\n" +
      '      type: "storage-write-failed",\n' +
      '      phase: "refresh",\n' +
      '      reasonCode: "storage-threw",\n' +
      '      token: { tokenType: "Bearer", expiresAt: 0, sessionVersion: "unavailable" },\n' +
      "      degradedToMemory: false,\n" +
      "    });",
    test: "tests/credential-registry-accounting.test.ts",
    only: "a peer clear failure reports a clear failure, not a memory mirror",
  },
  {
    // Beyond the nine: the duplicate-suppression and the try/finally cleanup.
    name: "recovery bookkeeping: duplicate peer messages take a second block",
    file: "src/client.ts",
    find: "      if (this.peerOperations.has(key)) return;",
    replace: "      // mutated",
    test: "tests/credential-registry-accounting.test.ts",
    only: "a duplicate peer session-cleared does not take a second block",
  },

  // -------------------------------------------------------- session binding
  {
    name: "session binding 1/4: logout binds from stale state, not the snapshot",
    file: "src/client.ts",
    find:
      "    const endingSessionVersion =\n" +
      "      activeToken?.sessionVersion ?? this.currentSessionVersion ?? undefined;",
    replace: "    const endingSessionVersion = this.currentSessionVersion ?? undefined;",
    test: "tests/session-binding.test.ts",
    only: "a logout from an unobserved stored token still carries the fingerprint",
  },
  {
    name: "session binding 2/4: a verified token update is not adopted",
    file: "src/client.ts",
    find:
      "          // MUTATION ANCHOR: adoption of a verified token update.\n" +
      "          this.adoptObservedSession(token);",
    replace: "          // mutated",
    test: "tests/session-binding.test.ts",
    only: "after token-updated for B, a session-cleared bound to B is honoured",
  },
  {
    name: "session binding 3/4: session-cleared skips the targeting decision",
    file: "src/client.ts",
    find:
      "      // MUTATION ANCHOR: stale session-cleared rejection.\n" +
      "      if (!this.messageTargetsThisSession(message)) return;",
    replace:
      "      if (\n" +
      "        message.sessionVersion !== undefined &&\n" +
      "        this.currentSessionVersion !== null &&\n" +
      "        message.sessionVersion !== this.currentSessionVersion\n" +
      "      ) {\n" +
      "        return;\n" +
      "      }",
    test: "tests/session-binding.test.ts",
    only: "a versionless clear that predates the session is refused",
  },
  {
    // Both checks guard the same continuation: the read, and the window
    // between verifying the fingerprint and acting on it. Either alone still
    // covers the path, so the pair is what makes the control observable.
    name: "session binding 4/4: token-updated has no post-await lifecycle check",
    file: "src/client.ts",
    edits: [
      {
        find:
          "          // MUTATION ANCHOR: post-await lifecycle validation in token-updated.\n" +
          "          if (!lease.valid()) return;\n" +
          "          if (!raw) return;",
        replace: "          if (!raw) return;",
      },
      {
        find:
          "          if (summary.sessionVersion !== message.sessionVersion) return;\n" +
          "          if (!lease.valid()) return;",
        replace: "          if (summary.sessionVersion !== message.sessionVersion) return;",
      },
    ],
    test: "tests/session-binding.test.ts",
    only: "a read that resolves after logout and a replacement login does nothing",
  },

  // ------------------------------------------------------ topology identity
  {
    // The architectural control: an access-token fingerprint is NOT a universal
    // session identifier. Forcing every deployment back to
    // "shared-credential" is the bug this exists to prevent.
    name: "topology 1/2: every storage treated as a shared credential",
    file: "src/client.ts",
    find:
      "  const declared = (storage as { lifecycleIdentity?: unknown }).lifecycleIdentity;\n" +
      "  const claimed = claimedLifecycleIdentity(storage);",
    replace:
      '  if (storage) return "shared-credential"; // mutated\n' +
      "  const declared = (storage as { lifecycleIdentity?: unknown }).lifecycleIdentity;\n" +
      "  const claimed = claimedLifecycleIdentity(storage);",
    test: "tests/lifecycle-topology.test.ts",
    only: "a completed logout in one tab clears another tab's own token",
  },
  {
    name: "topology 2/2: peer lifecycle does not invalidate the managed cache",
    file: "src/client.ts",
    find: '    (this.storage as { invalidateCache?: () => void }).invalidateCache?.();\n    await this.storage.clear("logout");',
    replace: '    await this.storage.clear("logout");',
    test: "tests/lifecycle-topology.test.ts",
    only: "a server-managed storage whose clear() spares its cache is still invalidated",
  },

  // ------------------------------------------ establishment and declaration
  {
    name: "establishment 1/6: first observation establishes a session again",
    file: "src/client.ts",
    find:
      "    if (options.established) {\n" +
      "      this.sessionEstablishedAt = wallClockMs();\n" +
      "    }",
    replace:
      "    if (options.established || this.currentSessionVersion === null) {\n" +
      "      this.sessionEstablishedAt = wallClockMs();\n" +
      "    }",
    test: "tests/session-establishment-and-declaration.test.ts",
    only: "a managed-bearer late listener honours the terminal logout",
  },
  {
    name: "establishment 2/6: the terminal message skips invalidation",
    file: "src/client.ts",
    find: "  private clearForTerminalLifecycle(): Promise<void> {\n    return this.clearForPeerLifecycle();",
    replace:
      "  private clearForTerminalLifecycle(): Promise<void> {\n    return Promise.resolve();",
    test: "tests/session-establishment-and-declaration.test.ts",
    only: "a preloaded per-tab credential is not a newer session",
  },
  {
    name: "declaration 3/6: topology inferred from persistence again",
    file: "src/client.ts",
    find: '  if (crossTabEnabled) {\n    throw new AuthError(\n      "AuthConfig.storage.lifecycleIdentity is required when cross-tab " +',
    replace:
      '  if (storage.persistent === true) return "shared-credential";\n' +
      '  if (crossTabEnabled) {\n    throw new AuthError(\n      "AuthConfig.storage.lifecycleIdentity is required when cross-tab " +',
    test: "tests/session-establishment-and-declaration.test.ts",
    only: "a custom storage with cross-tab enabled must declare its topology",
  },
  {
    name: "declaration 4/6: the custom declaration is ignored",
    file: "src/client.ts",
    find: "  const declared = (storage as { lifecycleIdentity?: unknown }).lifecycleIdentity;",
    replace: "  const declared = undefined as unknown;",
    test: "tests/session-establishment-and-declaration.test.ts",
    only: "a persistent shared custom storage is shared-credential",
  },
  {
    name: "declaration 5/6: a missing or invalid declaration is accepted",
    file: "src/client.ts",
    find:
      "  if (crossTabEnabled) {\n" +
      "    throw new AuthError(\n" +
      '      "AuthConfig.storage.lifecycleIdentity is required when cross-tab " +\n' +
      '        "coordination is enabled',
    replace:
      "  if (false) {\n" +
      "    throw new AuthError(\n" +
      '      "AuthConfig.storage.lifecycleIdentity is required when cross-tab " +\n' +
      '        "coordination is enabled',
    test: "tests/session-establishment-and-declaration.test.ts",
    only: "a non-persistent custom storage must declare its topology too",
  },
  {
    name: "establishment 6/6: newer-callback-session protection removed",
    file: "src/client.ts",
    find:
      "  private startedAfterOurSession(message: { startedAt: number }): boolean {\n" +
      "    if (this.sessionEstablishedAt === 0) return true;\n" +
      "    return message.startedAt >= this.sessionEstablishedAt;",
    replace:
      "  private startedAfterOurSession(message: { startedAt: number }): boolean {\n" +
      "    void message;\n" +
      "    return true;",
    test: "tests/lifecycle-topology.test.ts",
    only: "a stale operation cannot clear a genuinely newer per-tab session",
  },

  // --------------------------------------------- the declaration is universal
  {
    // Reinstates the shortcut the declaration requirement removes: recognise a
    // `kind` string and return an identity before the requirement is reached.
    // Pinned to the impersonation test, so the kill is the bypass reappearing —
    // not some unrelated constructor failure.
    name: "declaration: a `kind` claim waives the requirement again",
    file: "src/client.ts",
    find: "    return declared as LifecycleIdentity;\n" + "  }\n\n" + "  if (crossTabEnabled) {",
    replace:
      "    return declared as LifecycleIdentity;\n" +
      "  }\n\n" +
      "  if (claimed) return claimed; // mutated\n\n" +
      "  if (crossTabEnabled) {",
    test: "tests/topology-declaration-integrity.test.ts",
    only: 'an undeclared storage claiming kind="cookie" is refused (cookie)',
  },

  // ---- beyond the requested ten: the peer-side counterpart of call site 8.
  {
    name: "peer clear-failure block retention removed",
    file: "src/client.ts",
    edits: [
      {
        find: "          this.gate.retain(owned);\n          this.recoveryBlocks.add(owned);",
        replace: "          this.gate.release(owned); // mutated",
      },
      {
        // Paired: "refuse login in every fail-closed state" also refuses while
        // this block is held, so it shadows the control under test. Both are
        // removed to make that control observable again.
        find: "    if (this.gate.lifecycleBusy() || this.gate.blocked()) {\n      throw new NotAuthenticatedError(\n        `${what} is not available while this client is fail-closed",
        replace:
          "    if (false) {\n      throw new NotAuthenticatedError(\n        `${what} is not available while this client is fail-closed",
      },
    ],
    test: "tests/lease-propagation.test.ts",
    only: "beginLogin() does not expose a token a failed peer clear left behind",
  },
];

let failures = 0;
for (const m of MUTATIONS) {
  // A mutation is one or more edits to ONE file. Most are a single edit; a
  // couple remove two lines that guard the same continuation (see mutation
  // 6/10), because a control that is shadowed by a later check is only
  // observable once that later check is out of the way too.
  const edits = m.edits ?? [{ find: m.find, replace: m.replace }];
  const original = fs.readFileSync(m.file, "utf8");
  let mutated = original;
  let anchorProblem = null;
  for (const edit of edits) {
    const occurrences = mutated.split(edit.find).length - 1;
    if (occurrences === 0) {
      anchorProblem = `ANCHOR NOT FOUND in ${m.file} — gate is stale`;
      break;
    }
    if (occurrences !== 1) {
      anchorProblem = `anchor matches ${occurrences}x in ${m.file} — not targeted`;
      break;
    }
    mutated = mutated.replace(edit.find, edit.replace);
  }
  if (anchorProblem) {
    console.error(`  ${m.name}: ${anchorProblem}`);
    failures++;
    continue;
  }
  fs.writeFileSync(m.file, mutated);
  let outcome;
  try {
    // The verdict comes from what Vitest REPORTED, never from the exit code
    // alone: a toolchain failure exits non-zero too, and counting that as a
    // kill reports every control as verified when no test ever ran.
    outcome = runTest({ file: m.test, only: m.only });
  } finally {
    fs.writeFileSync(m.file, original);
  }
  if (outcome.verdict === "infrastructure") {
    console.error(`  ${m.name}: GATE ERROR — ${outcome.detail}`);
    failures++;
  } else if (outcome.verdict === "survived") {
    console.error(`  ${m.name}: SURVIVED — ${outcome.detail}`);
    failures++;
  } else {
    console.log(`  ${m.name}: killed (${outcome.detail})`);
  }
}

if (failures) {
  console.error(`mutation gate FAILED: ${failures} surviving mutation(s)`);
  process.exit(1);
}
console.log(`mutation gate: PASS (${MUTATIONS.length} controls, each detected when removed)`);
