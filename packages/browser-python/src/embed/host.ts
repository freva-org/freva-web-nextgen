/**
 * The PARENT half of a two-origin embedding: runs in the portal page. It owns the file picker and
 * the gesture allowed to open it, which a cross-origin child cannot - `showSaveFilePicker()` there
 * throws `SecurityError: Cross origin sub frames aren't allowed to show a file picker` (Chromium
 * 141, browser-tests/embedding-two-origin.mjs).
 */
import {
  EMBED_CHANNEL,
  EMBED_PROTOCOL_VERSION,
  accepted,
  basename,
  boundTranscript,
  isBridgeOp,
  isByteCount,
  isEmbeddedArtifact,
  newChallenge,
  newIdentity,
  type BridgeOp,
  type ChunkMessage,
  type EmbeddedArtifact,
  type HostPayload,
  type PlaygroundMessage,
} from "./protocol.js";

/** The artifact a picker is opened for: its metadata, plus the name to suggest saving it as. */
export interface DownloadableArtifact extends EmbeddedArtifact {
  /** `basename(name)` - what `showSaveFilePicker` should offer, never a path. */
  suggestedName: string;
}

/**
 * Where the bytes go. A `FileSystemWritableFileStream` satisfies this, and so does a fake. The
 * contract a sink author can rely on:
 *
 *  * `write` is called ONE AT A TIME; an earlier chunk is a protocol violation.
 *  * `close` is called exactly once, after every write has returned, and only when the delivered
 *    length matches the artifact's size and the playground's count.
 *  * `abort` is called exactly once INSTEAD of `close`, on every failure before the close begins: a
 *    destination closed after a failure is a truncated file wearing the name of a complete one.
 *  * `release` is called exactly once, last.
 *  * `close`, `abort` and the wait for an in-flight `write` are each bounded by `cleanupMs`.
 *
 * `abort` and `release` wait for an in-flight write first, since aborting mid-write tells a
 * destination two things at once and returning the lock mid-write leaves two owners; after
 * `cleanupMs` cleanup proceeds anyway, because JavaScript cannot end an arbitrary promise. Once
 * `close()` has begun nothing can un-write bytes already on disk, so a `close()` that fails reports
 * THAT error rather than an earlier cancellation reason.
 */
export interface HostSink {
  write(chunk: Uint8Array): Promise<void> | void;
  close(): Promise<void> | void;
  abort?(reason?: unknown): Promise<void> | void;
  /**
   * Anything the destination holds that is not the destination itself - a writer lock, a handle.
   * Called exactly once on every exit, after close or abort.
   */
  release?(): void;
}

export interface PlaygroundHostOptions {
  /** The playground iframe. Its `contentWindow` is the only accepted message source. */
  frame: HTMLIFrameElement;
  /** The EXACT origin the playground is served from. Never `"*"`, never a prefix match. */
  playgroundOrigin: string;
  /** Called whenever the playground's artifact list changes. Metadata only; never bytes. */
  onArtifacts?: (artifacts: EmbeddedArtifact[]) => void;
  /** Called when the playground and the portal agree on protocol, challenge and session. */
  onReady?: (sessionId: string) => void;
  /**
   * The previous session stopped being valid - a navigation, or a restarted child. The artifact
   * list is cleared and every download cancelled before this runs.
   */
  onInvalidated?: (reason: string) => void;
  /**
   * The playground resolved a named example and handed it to its interpreter. "Accepted" is about
   * the NAME: whether the snippet raises appears in the playground's own transcript.
   */
  onExampleAccepted?: (exampleId: string) => void;
  /**
   * It did not, and why. The usual cause is a portal and a playground from two different builds.
   */
  onExampleRefused?: (exampleId: string, reason: string) => void;
  /**
   * The playground's transcript, as it last reported it. Pushed on every change so a portal's Copy
   * control can be synchronous: the clipboard needs an activation, which does not survive an
   * `await`.
   */
  onTranscript?: (transcript: { text: string; truncated: boolean }) => void;
  /**
   * How long a bounded operation may wait for its answer, in milliseconds. A number rather than
   * "forever", because a child that stopped answering leaves a menu row broken with no message.
   */
  operationMs?: number;
  scope?: Window;
}

/** How one download may be bounded and cancelled. */
export interface DownloadOptions {
  /**
   * Cancels the transfer wherever it has got to: the sink is aborted and the child is told. Any
   * reason value is honoured - `null`, `0`, `false`, `""`, `NaN`, `0n` included - because
   * cancellation is a flag, never the truthiness of the reason. It does not reach the finishing
   * phase; see `HostSink`.
   */
  signal?: AbortSignal;
  /**
   * How long the portal will wait to hear ANYTHING from the child before giving up. Closing a
   * `MessagePort` does not notify the peer, so a dead child leaves the parent awaiting a message
   * that never arrives. Reset by every message and every ack.
   */
  inactivityMs?: number;
  /** How long the destination's own `close()` or `abort()` may take before it is given up on. */
  cleanupMs?: number;
  /** Chunk size for the child's transfer. Defaults to the bridge's own 4 MiB. */
  chunkBytes?: number;
}

/** The portal will wait this long in silence before deciding the child is not coming back. */
export const DEFAULT_INACTIVITY_MS = 30_000;
/** A destination's own `close()`/`abort()` is given this long. */
export const DEFAULT_CLEANUP_MS = 5_000;

export interface PlaygroundHost {
  /** The playground's session id, once it has said hello. */
  readonly sessionId: string | null;
  readonly artifacts: EmbeddedArtifact[];
  /** Ask the playground to re-announce. */
  refresh(): void;
  /**
   * Ask the playground to run one of ITS OWN registered examples. There is nowhere here to put
   * Python: the portal names a snippet the playground's build holds, and the digest makes "the same
   * name" mean "the same snippet" across two deployed halves.
   */
  runExample(exampleId: string, digest: string, targetSession?: string): void;
  /** The transcript the playground last reported, or `null` if it has reported none. */
  readonly transcript: { text: string; truncated: boolean } | null;
  /**
   * Ask the playground to perform ONE of four named operations on itself - the whole request is a
   * name. Rejects with the child's own reason, and on a timeout.
   */
  perform(op: BridgeOp, targetSession?: string): Promise<void>;
  /**
   * Save one artifact. MUST be called from the portal's own user gesture, and `openSink` MUST be
   * called synchronously by whatever the portal passes here: a picker opened after an `await` has
   * lost the activation and throws.
   */
  download(
    name: string,
    openSink: (artifact: DownloadableArtifact) => Promise<HostSink> | HostSink,
    options?: DownloadOptions,
  ): Promise<{ bytesWritten: number }>;
  /**
   * Stop listening, and settle everything this host is holding. Asynchronous because a `stop()`
   * that returned while transfers were running would leave the caller's destinations open and their
   * promises pending. It waits for every REGISTERED transfer - registered from the moment
   * `download()` is called, before the picker opens - for every ACQUIRED sink to be closed or
   * aborted and released within `cleanupMs`, and for a commit already under way.
   *
   * It cannot wait for `showSaveFilePicker()`: the platform gives no way to close a dialog a
   * visitor has open, so a writable arriving after `stop()` is disposed of by the same bounded
   * path.
   */
  stop(): Promise<void>;
}

/** The default sink: the browser's own save dialog, owned by the portal page. */
export async function saveFilePickerSink(artifact: DownloadableArtifact): Promise<HostSink> {
  const picker = (
    globalThis as unknown as {
      showSaveFilePicker?: (o: unknown) => Promise<{ createWritable: () => Promise<HostSink> }>;
    }
  ).showSaveFilePicker;
  if (typeof picker !== "function") {
    throw new Error(
      "This browser has no showSaveFilePicker(), so the portal cannot own the save location. " +
        "Open the playground as a top-level page instead, where it can save for itself.",
    );
  }
  // The BASENAME, not the workspace name: a name with separators in it is at best rejected by the
  // picker and at worst a path the visitor did not choose.
  const handle = await picker({ suggestedName: artifact.suggestedName });
  return await handle.createWritable();
}

export function createPlaygroundHost(options: PlaygroundHostOptions): PlaygroundHost {
  const scope = options.scope ?? window;
  const origin = options.playgroundOrigin;
  if (!origin || origin === "*") {
    throw new Error(
      "createPlaygroundHost needs the playground's exact origin. A wildcard would accept " +
        "artifact metadata, and act on download replies, from any document at all.",
    );
  }

  /** How long a bounded operation waits before it gives up on a child that is not answering. */
  const operationMs = options.operationMs ?? 15_000;

  let sessionId: string | null = null;
  let artifacts: EmbeddedArtifact[] = [];
  let transcript: { text: string; truncated: boolean } | null = null;
  let nextRequest = 0;
  /**
   * The nonce the child must answer to hold a session, regenerated on every navigation. A `hello`
   * only prompts a fresh hail; a `ready` answering the CURRENT challenge establishes or replaces a
   * session.
   */
  let challenge = newChallenge();

  /**
   * Every download this host currently owns, so all of them can be settled at once when a session
   * ends under a transfer. `cancel` fails it where it is; `done` is how `stop()` waits for it to
   * unwind.
   */
  const active = new Map<string, { cancel: (reason: unknown) => void; done: Promise<unknown> }>();
  /**
   * Cancelling is not the same as being finished, so an entry leaves the registry in its own
   * `finally`: deleting it at cancel time would leave `active` empty while an `abort()` is still
   * running.
   */
  const cancelAll = (reason: string): void => {
    for (const entry of [...active.values()]) entry.cancel(new Error(reason));
  };

  /** A stopped host is terminal: it starts nothing new and answers nothing. */
  let stopped = false;
  const refuseIfStopped = (what: string): void => {
    if (stopped) {
      throw new Error(
        `this playground host was stopped, so it cannot ${what}. Create a new one if the portal ` +
          `needs to talk to the playground again.`,
      );
    }
  };

  const child = (): Window => {
    const target = options.frame.contentWindow;
    if (!target) throw new Error("the playground frame has no document loaded");
    return target;
  };

  const post = (message: HostPayload, ports?: MessagePort[]) => {
    if (!sessionId) throw new Error("the playground has not completed its handshake yet");
    child().postMessage(
      {
        channel: EMBED_CHANNEL,
        version: EMBED_PROTOCOL_VERSION,
        challenge,
        sessionId,
        ...message,
      },
      origin,
      ports,
    );
  };

  /**
   * Post into a conversation captured earlier, refusing if it is no longer the current one: a
   * download composed before a picker opened may be minutes old, and the frame may hold a different
   * document.
   */
  const postTo = (
    conversation: { sessionId: string; challenge: string; target: Window },
    message: HostPayload,
    ports?: MessagePort[],
  ) => {
    if (
      stopped ||
      sessionId !== conversation.sessionId ||
      challenge !== conversation.challenge ||
      options.frame.contentWindow !== conversation.target
    ) {
      throw new Error(
        "the playground this download was started for is no longer the one in the frame, so the " +
          "request was not sent. Nothing was asked of the replacement.",
      );
    }
    conversation.target.postMessage(
      {
        channel: EMBED_CHANNEL,
        version: EMBED_PROTOCOL_VERSION,
        challenge: conversation.challenge,
        sessionId: conversation.sessionId,
        ...message,
      },
      origin,
      ports,
    );
  };

  /** Issue a fresh challenge and ask whoever is in the frame now to answer it. */
  const hail = (): void => {
    challenge = newChallenge();
    const target = options.frame.contentWindow;
    if (!target) return; // nothing loaded yet; the frame's `load` will hail again
    try {
      target.postMessage(
        {
          channel: EMBED_CHANNEL,
          version: EMBED_PROTOCOL_VERSION,
          challenge,
          sessionId: "",
          kind: "hail",
        },
        origin,
      );
    } catch {
      // A frame that has gone away cannot be hailed; its `load` will hail again if it comes back.
    }
  };

  /**
   */
  const pending = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  const settleAll = (why: string): void => {
    for (const [id, entry] of [...pending]) {
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(new Error(why));
    }
  };

  const invalidate = (why: string): void => {
    // Nothing the previous document said still holds. Transfers first - they hold a destination
    // open and a lease taken - and all of it is cleared before the new challenge goes out, so the
    // new session is never paired with the old document's files.
    cancelAll(why);
    settleAll(why);
    sessionId = null;
    artifacts = [];
    transcript = null;
    options.onArtifacts?.([]);
    options.onInvalidated?.(why);
  };

  const onMessage = (event: MessageEvent): void => {
    // Origin, window, channel and version gate everything, including the handshake.
    if (!accepted(event, { origin, source: options.frame.contentWindow })) return;
    const data = event.data as PlaygroundMessage;

    // A `hello` ESTABLISHES NOTHING; it says a document is there and wants to be hailed, which is
    // what happens when the child attached before this host existed. Answering with a fresh
    // challenge is safe precisely because the hello changes no state.
    if (data.kind === "hello") {
      if (sessionId !== null && data.sessionId !== sessionId)
        invalidate("the playground restarted");
      hail();
      return;
    }

    // A `ready` answering the CURRENT challenge is the only thing that starts or replaces a
    // session, which makes a navigated frame recoverable without making the session something any
    // message can claim.
    if (data.kind === "ready") {
      if (data.challenge !== challenge) return;
      if (sessionId !== null && sessionId !== data.sessionId)
        invalidate("the playground restarted");
      sessionId = data.sessionId;
      options.onReady?.(data.sessionId);
      post({ kind: "list" });
      return;
    }

    // Everything else belongs to the established conversation: this challenge, this session.
    if (
      sessionId === null ||
      !accepted(event, { origin, source: options.frame.contentWindow, sessionId, challenge })
    ) {
      return;
    }
    if (data.kind === "example-accepted") {
      options.onExampleAccepted?.(data.exampleId);
      return;
    }
    if (data.kind === "example-refused") {
      options.onExampleRefused?.(data.exampleId, data.reason);
      return;
    }
    if (data.kind === "transcript") {
      // BOUNDED HERE TOO: the child bounds what it sends because it should, this bounds what is
      // believed because a peer may be broken or hostile. A string is the one payload whose size is
      // the sender's choice.
      const bounded = boundTranscript(data.text);
      if (!bounded) return;
      transcript = { text: bounded.text, truncated: bounded.truncated || data.truncated === true };
      options.onTranscript?.({ ...transcript });
      return;
    }
    if (data.kind === "op-result") {
      const entry = typeof data.requestId === "string" ? pending.get(data.requestId) : undefined;
      if (!entry) return;
      pending.delete(data.requestId);
      clearTimeout(entry.timer);
      if (data.ok === true) entry.resolve();
      else
        entry.reject(
          new Error(
            typeof data.message === "string" && data.message
              ? data.message
              : "the playground refused the request",
          ),
        );
      return;
    }
    if (data.kind === "artifacts") {
      // COPIED AND CHECKED. Keeping the peer's own array would hand every caller of `artifacts` a
      // reference the peer's next message replaces underneath them, and unchecked entries would let
      // a `NaN` size become a byte budget.
      artifacts = Array.isArray(data.artifacts)
        ? data.artifacts.filter(isEmbeddedArtifact).map((a) => ({ ...a }))
        : [];
      options.onArtifacts?.(artifacts.map((a) => ({ ...a })));
    }
  };

  // THE FRAME'S OWN `load`, the only reliable signal that the document was replaced:
  // `contentWindow` does not change across a navigation.
  const onNavigate = (): void => {
    if (sessionId !== null) invalidate("the playground navigated");
    hail();
  };
  options.frame.addEventListener("load", onNavigate);

  scope.addEventListener("message", onMessage);
  // Hail immediately: if the child is already there its `hello` may have arrived before this host
  // was listening, and a hail is what recovers that case without waiting for anything.
  hail();

  return {
    get sessionId() {
      return sessionId;
    },
    get transcript() {
      return transcript ? { ...transcript } : null;
    },
    perform(op, targetSession) {
      refuseIfStopped(`perform \u201c${op}\u201d`);
      if (!isBridgeOp(op)) return Promise.reject(new Error(`unknown operation ${String(op)}`));
      const requestId = newIdentity();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error(`the playground did not answer \u201c${op}\u201d in time`));
        }, operationMs);
        pending.set(requestId, { resolve, reject, timer });
        try {
          post({
            kind: "op",
            requestId,
            op,
            ...(targetSession !== undefined ? { targetSession } : {}),
          });
        } catch (error) {
          pending.delete(requestId);
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    get artifacts() {
      // A COPY, every time: a caller that sorts or splices what it is given must not be editing
      // the host's own record of what the playground reported.
      return artifacts.map((a) => ({ ...a }));
    },
    refresh() {
      refuseIfStopped("refresh the artifact list");
      post({ kind: "list" });
    },
    runExample(exampleId, digest, targetSession) {
      refuseIfStopped("run an example");
      // Refused HERE as well as in the child: the child validates because a peer may be hostile,
      // this because a portal may be buggy, and a malformed request that reaches the frame comes
      // back as a refusal the portal has to explain.
      if (typeof exampleId !== "string" || exampleId.length === 0) {
        throw new Error("runExample needs the example's id");
      }
      if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest.trim().toLowerCase())) {
        throw new Error(
          `runExample needs the example's lowercase hex SHA-256; got ${JSON.stringify(digest)}`,
        );
      }
      post({
        kind: "run-example",
        exampleId,
        digest: digest.trim().toLowerCase(),
        ...(targetSession !== undefined ? { targetSession } : {}),
      });
    },
    async download(name, openSink, downloadOptions = {}) {
      refuseIfStopped("start a download");
      const known = artifacts.find((a) => a.name === name);
      if (!known) throw new Error(`the playground has no artifact called ${name}`);
      // NOT READY, NOT DOWNLOADED - and refused BEFORE the picker opens. `open` means Python still
      // has the file open, `transferring` means another download holds it, `failed` means its bytes
      // are not what anyone thinks. Otherwise the dialog spends the visitor's gesture on an empty
      // file.
      if (known.state !== "ready") {
        throw new Error(
          `${name} is ${known.state}, not ready, so it cannot be downloaded yet. A file Python ` +
            `still has open has no settled contents to save.`,
        );
      }
      const suggestedName = basename(known.name);
      if (suggestedName === null) {
        throw new Error(`${name} has no usable file name to suggest for saving.`);
      }
      /** What the picker is offered: the artifact, plus the basename to suggest saving it as. */
      const artifact = { ...known, suggestedName };
      const inactivityMs = downloadOptions.inactivityMs ?? DEFAULT_INACTIVITY_MS;
      const cleanupMs = downloadOptions.cleanupMs ?? DEFAULT_CLEANUP_MS;
      const signal = downloadOptions.signal;
      // `signal.reason` EXACTLY, with no `??` in front of it: `??` still treats `null` specially,
      // so a fallback here silently replaces a portal's `abort(null)` with a manufactured Error. A
      // no-argument `abort()` already stores the platform's own `AbortError`.
      if (signal?.aborted) throw signal.reason;

      // THE CONVERSATION, CAPTURED BEFORE ANY CALLER CODE RUNS. `openSink()` is usually a save
      // dialog a visitor can leave open indefinitely, during which the frame can navigate or the
      // host can be stopped.
      const conversation = {
        sessionId,
        challenge,
        target: options.frame.contentWindow as Window | null,
      };
      if (conversation.sessionId === null || conversation.target === null) {
        throw new Error(
          `${name} cannot be downloaded yet: the playground has not completed its handshake.`,
        );
      }
      const bound = conversation as { sessionId: string; challenge: string; target: Window };

      const requestId = `dl-${++nextRequest}`;
      // WHETHER THIS TRANSACTION FAILED IS A BOOLEAN. WHY IT FAILED IS DATA. `abort(reason)` takes
      // any JavaScript value, so one nullable variable cannot also answer "was this cancelled": a
      // portal aborting with `0`, `false` or `""` would cancel nothing at all.
      let hasFailure = false;
      let failureReason: unknown = undefined;
      /** Rejectors for whatever this transfer is currently waiting on. */
      const waiters = new Set<(error: unknown) => void>();
      /** First failure wins: a later one cannot rewrite why the caller was told it stopped. */
      const fail = (error: unknown): void => {
        if (!hasFailure) {
          hasFailure = true;
          failureReason = error;
        }
        for (const waiter of [...waiters]) waiter(failureReason);
        waiters.clear();
      };
      /** Reject `work` if this transaction is cancelled before `work` settles. */
      const race = <T>(work: Promise<T>): Promise<T> => {
        work.catch(() => undefined);
        if (hasFailure) return Promise.reject(failureReason);
        return new Promise<T>((resolve, reject) => {
          const waiter = (error: unknown) => reject(error);
          waiters.add(waiter);
          work.then(
            (value) => {
              waiters.delete(waiter);
              resolve(value);
            },
            (error) => {
              waiters.delete(waiter);
              reject(error);
            },
          );
        });
      };

      // REGISTERED BEFORE THE PICKER OPENS. Otherwise, while `openSink()` is pending, the host has
      // registered nothing and is bound to no session, so an abort, a `stop()` or a navigation
      // during the dialog goes unobserved.
      let finished: () => void = () => undefined;
      const done = new Promise<void>((resolve) => {
        finished = resolve;
      });
      // REGISTERED ONCE, AND NEVER REPLACED: one entry, one completion promise, one finalizer.
      // Overwriting it once the transfer exists leaves this promise pending on every path but a
      // picker that throws synchronously, and hangs one abort listener per download off a shared
      // `AbortSignal`.
      active.set(requestId, { cancel: fail, done });

      // The same rule on the listener: whatever the signal holds is the reason. See above.
      const onAbort = signal ? () => fail(signal.reason) : null;
      if (signal && onAbort) signal.addEventListener("abort", onAbort, { once: true });

      // A SINK IS DISPOSED EXACTLY ONCE, whoever ends up holding it: the transfer, or a picker that
      // answered after this transaction was cancelled. The platform offers no way to close a dialog
      // a visitor has open, so the honest thing is to dispose of the result when it arrives.
      let sinkSettled = false;
      /**
       * True once the transfer has validated and the destination is being committed: from here
       * cancellation and `stop()` no longer change the outcome. See `HostSink`.
       */
      let committing = false;
      /**
       * `release()` happens exactly once, whichever path got there first: a transfer that closed,
       * one that aborted, or a picker that answered after cancellation.
       */
      let released = false;
      const releaseOnce = (target: HostSink | null): void => {
        if (released || !target) return;
        released = true;
        try {
          target.release?.();
        } catch {
          // nothing left to do about a destination that will not let go
        }
      };
      /**
       * Dispose of a destination nobody is waiting for any more - BOUNDED, because a picker's
       * writable is arbitrary code whose `abort()` can never settle. `release()` is in the
       * `finally`.
       */
      const disposeSink = async (sink: HostSink, reason: unknown): Promise<void> => {
        if (sinkSettled) return;
        sinkSettled = true;
        try {
          const attempt = Promise.resolve().then(() => sink.abort?.(reason));
          attempt.catch(() => undefined);
          let timer: ReturnType<typeof setTimeout> | undefined;
          const limit = new Promise<void>((resolve) => {
            timer = setTimeout(resolve, cleanupMs);
          });
          try {
            await Promise.race([attempt, limit]);
          } finally {
            clearTimeout(timer);
          }
        } catch {
          // a destination that cannot be aborted is not worth losing the cause over
        } finally {
          releaseOnce(sink);
        }
      };

      // ONE `try` FROM HERE: constructing the channel, wiring it and posting through the frame can
      // all throw - a frame that navigated while the picker was open makes `post()` throw - and
      // none of those may leave the caller's destination open with a promise that never settles.
      const run = (async (): Promise<{ bytesWritten: number }> => {
        const unwind: Array<() => void> = [];
        let port: MessagePort | null = null;
        let inactivity: ReturnType<typeof setTimeout> | undefined;

        /** A destination's own cleanup, bounded: it cannot hold the portal hostage. */
        const bounded = async (
          what: "close" | "abort" | "settle",
          work: () => unknown,
        ): Promise<void> => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const limit = new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    what === "settle"
                      ? `a write to the download destination for ${name} did not return within ` +
                          `${cleanupMs}ms. JavaScript cannot end an arbitrary promise, so cleanup ` +
                          `proceeded without it.`
                      : `the download destination's ${what}() did not return within ${cleanupMs}ms, ` +
                          `so ${name} was given up on rather than left holding the portal.`,
                  ),
                ),
              cleanupMs,
            );
          });
          limit.catch(() => undefined);
          const attempt = Promise.resolve().then(work);
          attempt.catch(() => undefined);
          try {
            await Promise.race([attempt, limit]);
          } finally {
            clearTimeout(timer);
          }
        };

        /**
         * The destination write currently in flight, if any. JavaScript cannot force an arbitrary
         * promise to settle, so cleanup WAITS for it, bounded by `cleanupMs`, then proceeds
         * regardless.
         */
        let activeWrite: Promise<void> | null = null;
        /** Nothing touches the destination while one of its own writes is still running. */
        const writesQuiet = async (): Promise<void> => {
          const inFlight = activeWrite;
          if (!inFlight) return;
          try {
            await bounded("settle", () => inFlight);
          } catch {
            // A write that will not return within the cleanup budget is not one anything here can
            // end; cleanup proceeds rather than hanging the caller for ever.
          }
        };

        /** The destination, once the picker has answered. Undefined until then. */
        let sink: HostSink | null = null;

        try {
          // THE PICKER, INVOKED SYNCHRONOUSLY IN THE CALLER'S TURN. An async body runs
          // synchronously up to its first `await`, so this call still sits inside the click
          // handler's user activation, which `showSaveFilePicker()` requires. Inside the try, so a
          // synchronous throw unwinds through the same finalizer.
          const opening = Promise.resolve(openSink(artifact));
          // The late arrival: if this transaction is already cancelled by the time the visitor
          // picks a file, that file's writable is disposed of and no transfer starts. A late
          // REJECTION is absorbed, so a second reason cannot become an unhandled rejection.
          opening.then(
            (late) => {
              if (hasFailure) void disposeSink(late, failureReason);
            },
            () => undefined,
          );

          // RACED AGAINST CANCELLATION, with no pretence that the dialog was closed: the platform
          // offers no way to close one a visitor has open, so what is cancelled is this side's
          // interest in the result.
          sink = await race(opening);
          // Cancellation can land between the picker answering and this line.
          if (hasFailure) throw failureReason;
          /** Bound from here on: the transfer below only exists because a sink does. */
          const destination = sink;

          const channel = new MessageChannel();
          port = channel.port1;
          const local = port;
          unwind.push(() => {
            local.onmessage = null;
            try {
              local.close();
            } catch {
              // already closed
            }
          });

          // THE CLOCK RUNS ONLY WHILE THIS SIDE IS WAITING FOR THE PEER. Left armed through
          // `sink.write()`, a destination slower than `inactivityMs` makes the host announce that
          // the CHILD went quiet and abort it mid-write while the child is healthy.
          const waitForPeer = (): void => {
            clearTimeout(inactivity);
            inactivity = setTimeout(
              () =>
                fail(
                  new Error(
                    `${name}: the playground sent no response for ${inactivityMs}ms. Closing a ` +
                      `MessagePort does not notify the other side, so silence is all a stopped, ` +
                      `navigated or crashed frame looks like. The download was given up on.`,
                  ),
                ),
              inactivityMs,
            );
          };
          /** We are no longer waiting on the peer - it answered, or it is our turn to work. */
          const peerAnswered = (): void => {
            clearTimeout(inactivity);
            inactivity = undefined;
          };
          unwind.push(() => clearTimeout(inactivity));

          // THE PROTOCOL'S STATE, kept here rather than inferred from the child's messages.
          // `written` is the portal's OWN count: trusting `done.bytesWritten` lets a child that
          // sent no chunks and then `done: 10` get an empty destination CLOSED as a complete file.
          // `writing` is the backpressure.
          let written = 0;
          let writing = false;
          let terminal = false;
          const expected = artifact.size;

          const violation = (why: string): void => {
            terminal = true;
            fail(new Error(`${name}: ${why}`));
          };

          const transferred = new Promise<{ bytesWritten: number }>((resolve, reject) => {
            waiters.add(reject);
            local.onmessage = (event: MessageEvent<ChunkMessage>) => {
              // After a terminal result nothing is acted on, and `hasFailure` is the same door for
              // the cancelled case: a chunk posted before the `cancel` reached the child must not
              // write to a destination whose `abort()` is being awaited.
              if (terminal || hasFailure) return;
              // The peer spoke, so the clock stops here. Only the ack below restarts it.
              peerAnswered();
              const message = event.data as Partial<ChunkMessage> | null;
              if (!message || typeof message !== "object") {
                violation("the playground sent something that is not a protocol message.");
                return;
              }

              if (message.kind === "chunk") {
                if (writing) {
                  violation(
                    "the playground sent a chunk before the previous one was acknowledged. One " +
                      "ack per chunk is the backpressure, and writing two at once to one " +
                      "destination interleaves them.",
                  );
                  return;
                }
                const bytes = (message as { bytes?: unknown }).bytes;
                if (!(bytes instanceof ArrayBuffer)) {
                  violation("the playground sent a chunk whose payload is not an ArrayBuffer.");
                  return;
                }
                if (written + bytes.byteLength > expected) {
                  violation(
                    `the playground sent more bytes than ${name} has: ` +
                      `${written + bytes.byteLength} of a ${expected}-byte artifact.`,
                  );
                  return;
                }
                writing = true;
                // TRACKED, so cleanup can wait for it. Releasing a sink mid-write hands the lock
                // back to a caller still using it; aborting one mid-write tells a destination two
                // things at once.
                activeWrite = (async () => {
                  try {
                    await destination.write(new Uint8Array(bytes));
                    written += bytes.byteLength;
                    writing = false;
                    if (terminal || hasFailure) return;
                    // Our turn is over; we are waiting on the peer again from here.
                    waitForPeer();
                    local.postMessage({ kind: "ack" });
                  } catch (error) {
                    writing = false;
                    fail(error);
                  } finally {
                    activeWrite = null;
                  }
                })();
                activeWrite.catch(() => undefined);
                return;
              }

              if (message.kind === "done") {
                if (writing) {
                  violation("the playground ended the transfer while a write was still running.");
                  return;
                }
                const claimed = (message as { bytesWritten?: unknown }).bytesWritten;
                if (!isByteCount(claimed)) {
                  violation("the playground ended the transfer with a byte count that is not one.");
                  return;
                }
                // THREE NUMBERS THAT MUST AGREE: what this side wrote, what the child says it sent,
                // and what the artifact's metadata says. Any disagreement is a file that is not the
                // file, so the destination is aborted rather than closed.
                if (written !== claimed || written !== expected) {
                  violation(
                    `the transfer does not add up - ${written} bytes were written, the playground ` +
                      `reported ${claimed}, and ${name} is ${expected} bytes. The destination was ` +
                      `aborted rather than closed as complete.`,
                  );
                  return;
                }
                terminal = true;
                resolve({ bytesWritten: written });
                return;
              }

              if (message.kind === "error") {
                const detail = (message as { message?: unknown }).message;
                violation(
                  typeof detail === "string" && detail
                    ? detail
                    : "the playground refused the download.",
                );
                return;
              }

              violation("the playground sent a message of an unknown kind.");
            };
          });
          transferred.catch(() => undefined);
          local.start?.();

          // REVALIDATED, then posted: the conversation captured before the picker opened has to
          // still be the one in the frame, and `postTo` refuses rather than delivering into a
          // session this download was never part of.
          postTo(
            bound,
            {
              kind: "download",
              requestId,
              name,
              ...(downloadOptions.chunkBytes === undefined
                ? {}
                : { chunkBytes: downloadOptions.chunkBytes }),
            },
            [channel.port2],
          );
          // From here we are waiting on the child for its first chunk.
          waitForPeer();

          const result = await transferred;
          void written;
          // THE FINISHING PHASE, WHICH IS NOT CANCELLABLE - see `HostSink`. `sinkSettled` is set
          // BEFORE the close, because `close()` IS this destination's settling and an abort must
          // not follow it.
          committing = true;
          sinkSettled = true;
          // Nothing touches the destination while one of its own writes is still running.
          await writesQuiet();
          await bounded("close", () => destination.close());
          return result;
        } catch (error) {
          // A FAILURE IN THE FINISHING PHASE IS THE FINISHING PHASE'S OWN. Reporting
          // `failureReason` would tell a caller whose disk refused the commit that their download
          // had been cancelled.
          if (committing) throw error;
          fail(error);
          // TELL THE CHILD, then abort. Closing this port would not reach it, so a child left
          // streaming would hold its lease and keep an artifact frozen until its own transfer
          // finished.
          try {
            port?.postMessage({
              kind: "cancel",
              reason:
                failureReason instanceof Error ? failureReason.message : String(failureReason),
            });
          } catch {
            // the port is already unusable, which is the case the child's own bound covers
          }
          // DETACHED BEFORE THE DESTINATION IS TOUCHED. The guard above stops a queued chunk from
          // acting, but the handler itself must not run at all once `abort()` starts, and the
          // unwind step that clears it does not run until the `finally`.
          if (port) port.onmessage = null;
          if (sink && !sinkSettled) {
            sinkSettled = true;
            // ORDERED: the in-flight write first, then abort, then release. A destination told to
            // abort while still writing is told two things at once, and a lock given back while a
            // write holds it has two owners.
            await writesQuiet();
            // Abort, never close: a destination closed after a failure is a truncated file wearing
            // the name of a complete one.
            try {
              await bounded("abort", () => sink?.abort?.(failureReason));
            } catch {
              // a destination that cannot be aborted is not worth losing the cause over
            }
          }
          throw failureReason;
        } finally {
          // THE ONE FINALIZER. Whatever happened - a picker that threw, a cancellation while the
          // dialog was open, a failed transfer, a successful one - these four steps run, in this
          // order, exactly once.
          for (const step of unwind.reverse()) {
            try {
              step();
            } catch {
              // one failing cleanup step must not skip the rest
            }
          }
          // LAST, after close or abort, and exactly once - see `releaseOnce`.
          releaseOnce(sink);
          if (signal && onAbort) signal.removeEventListener("abort", onAbort);
          active.delete(requestId);
          waiters.clear();
          finished();
        }
      })();

      return run;
    },
    async stop() {
      // IDEMPOTENT, and still a barrier: a second `stop()` waits for the same unwinding rather
      // than returning while the first one is mid-flight.
      const settling = [...active.values()].map((entry) => entry.done);
      if (!stopped) {
        stopped = true;
        scope.removeEventListener("message", onMessage);
        options.frame.removeEventListener("load", onNavigate);
      }
      cancelAll("the portal stopped the playground bridge");
      // …and every operation still waiting for an answer, rejected with a reason. A promise left
      // pending on a bridge that has stopped listening is a promise that never settles.
      settleAll("the portal stopped the playground bridge");
      // AWAITED, not merely requested: a `stop()` that returned while transfers were unwinding
      // would leave the caller's destinations open and their promises pending.
      await Promise.allSettled(settling);
    },
  };
}
