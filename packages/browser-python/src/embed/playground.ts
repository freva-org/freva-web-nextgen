/**
 * The CHILD half of a two-origin embedding: runs in the playground document.
 *
 * It answers three questions from the parent - "what artifacts are there", "send me this one",
 * "run the example you know by this name" - and nothing else. The parent cannot send Python: it
 * sends an id and a digest, resolved against a manifest THIS BUILD registered, and anything
 * unrecognised is refused out loud. Bytes leave through a dedicated `MessagePort` per download,
 * one chunk at a time, the next not requested until the parent acknowledges the last;
 * `streamArtifact` supplies them, so the artifact stays frozen and the lease is always released.
 */
import {
  EMBED_CHANNEL,
  EMBED_PROTOCOL_VERSION,
  MAX_TRANSCRIPT_CHARS,
  accepted,
  isBridgeOp,
  newSessionId,
  type BridgeOp,
  type ChunkAck,
  type EmbeddedArtifact,
  type HostMessage,
  type PlaygroundPayload,
} from "./protocol.js";
import type { ExampleRegistry, RegisteredExample } from "./examples.js";
import type { ArtifactInfo, BrowserPython } from "../types.js";

export interface PlaygroundBridgeOptions {
  /** The engine whose artifacts may be listed and sent. */
  engine: BrowserPython;
  /** The EXACT origin of the portal page allowed to talk to this frame. Never `"*"`. */
  hostOrigin: string;
  /** Bytes per chunk. 4 MiB matches the engine's own default transfer window. */
  chunkBytes?: number;
  /**
   * The snippets this playground may be asked to run, by name. Omitted means `run-example` is
   * refused outright: a bridge with no manifest has no way to know what a name means, and one
   * that guessed would be the thing this mechanism exists to avoid.
   */
  examples?: ExampleRegistry;
  /**
   * Hand a resolved example to whatever runs Python here. Required alongside `examples` and
   * separate from the engine on purpose: HOW a snippet runs belongs to the page, and the
   * bridge's job ends at "this name resolves to this source, and the digests agree".
   */
  onRunExample?: (example: RegisteredExample) => void | Promise<void>;
  /**
   * The console's transcript, when this page has one to share. Called for the parent's
   * `transcript` operation and after every example this bridge runs, so the parent can keep a
   * copy and make its own Copy control synchronous - a clipboard write needs the visitor's
   * activation, which does not survive a cross-origin round trip. Omitted means the parent is
   * told the operation is unsupported rather than handed an empty string.
   */
  transcript?: () => string;
  /** Clear the visible transcript. Omitted means the operation is refused, not silently ignored. */
  onClearTranscript?: () => void | Promise<void>;
  /** Clear the prompt's history. Same rule. */
  onClearHistory?: () => void | Promise<void>;
  /**
   * Bring up a NEW interpreter in this same document. Different from the parent reloading the
   * frame: this keeps the document, and therefore the session, so anything the parent holds
   * against that session stays valid.
   */
  onRestart?: () => void | Promise<void>;
  /** Injectable for tests; defaults to this frame's own window. */
  scope?: Window;
}

export interface PlaygroundBridge {
  readonly sessionId: string;
  /** Push the current artifact list to the parent. Called automatically on every change. */
  announce(): Promise<void>;
  stop(): void;
}

/**
 * Wire an engine up to a portal parent. Returns immediately; the handshake is a `hello` the
 * parent answers with `welcome`. The parent is addressed with an explicit `targetOrigin` every
 * time - never `"*"`, which delivers to whatever document occupies the parent slot, after a
 * navigation not necessarily the portal.
 */
export function attachPlaygroundBridge(options: PlaygroundBridgeOptions): PlaygroundBridge {
  const scope = options.scope ?? window;
  const parent = scope.parent;
  const hostOrigin = options.hostOrigin;
  const chunkBytes = options.chunkBytes ?? 4 * 1024 * 1024;
  const sessionId = newSessionId();

  if (!hostOrigin || hostOrigin === "*") {
    throw new Error(
      "attachPlaygroundBridge needs the portal's exact origin. A wildcard would send artifact " +
        "metadata, and then artifact bytes, to whatever document occupies the parent slot.",
    );
  }
  if (parent === scope) {
    throw new Error(
      "attachPlaygroundBridge was called in a document that is not framed, so there is no portal " +
        "to talk to. A top-level playground owns its own file picker and needs no bridge.",
    );
  }

  /**
   * The challenge this child is currently answering, or `""` before it has been hailed.
   * Everything except `hello` carries it and must match, so a message aimed at the conversation
   * the parent had with the PREVIOUS document in this frame is refused here as well as there.
   */
  let challenge = "";

  const send = (message: PlaygroundPayload): void => {
    parent.postMessage(
      {
        channel: EMBED_CHANNEL,
        version: EMBED_PROTOCOL_VERSION,
        challenge,
        sessionId,
        ...message,
      },
      hostOrigin,
    );
  };

  /** The metadata the portal may see, and nothing else. Built from a list already in hand. */
  const describe = (artifacts: readonly ArtifactInfo[]): EmbeddedArtifact[] =>
    artifacts.map((a) => ({
      name: a.name,
      size: a.size,
      mime: a.mime,
      state: a.state,
      modifiedMs: a.modifiedMs,
    }));

  /**
   * Tell the portal about a list SOMEBODY ELSE ALREADY HAS. No Worker request of its own.
   *
   * `engine.artifacts()` asks the Worker, and the reply is both settled for the caller AND
   * broadcast to every `onArtifacts` listener - deliberately, so a UI need not know whether a
   * change came from its own button or from an `os.remove()` at the prompt. A listener that
   * answered the broadcast by asking again would close that cycle on a completely idle engine,
   * so it forwards what the EVENT carries and only an explicit request asks the Worker.
   */
  const announce = (artifacts: readonly ArtifactInfo[]): void => {
    send({ kind: "artifacts", artifacts: describe(artifacts) });
  };

  /**
   * Send the transcript, bounded at this end as well as checked at the other: this end says "I
   * will not send more than the console may hold", the parent's says "I will not believe more
   * than that from a peer". Cut from the OLDEST end, matching the console's own pruning.
   */
  const sendTranscript = (): boolean => {
    if (!options.transcript) return false;
    const text = options.transcript();
    const truncated = text.length > MAX_TRANSCRIPT_CHARS;
    send({
      kind: "transcript",
      text: truncated ? text.slice(text.length - MAX_TRANSCRIPT_CHARS) : text,
      truncated,
    });
    return true;
  };

  /**
   * Perform one of the four named operations, and ALWAYS answer - including for an operation
   * this page did not wire up and for one that threw. A parent waiting on a request id that
   * never comes back is a menu row that stays disabled with no explanation.
   */
  const perform = async (requestId: string, op: BridgeOp): Promise<void> => {
    const reply = (ok: boolean, message?: string): void =>
      send({ kind: "op-result", requestId, ok, ...(message ? { message } : {}) });
    try {
      if (op === "transcript") {
        reply(
          sendTranscript(),
          options.transcript ? undefined : "this playground does not share a transcript",
        );
        return;
      }
      const handler =
        op === "clear-transcript"
          ? options.onClearTranscript
          : op === "clear-history"
            ? options.onClearHistory
            : options.onRestart;
      if (!handler) {
        reply(false, `this playground does not support \u201c${op}\u201d`);
        return;
      }
      await handler();
      // A cleared or restarted console has a different transcript, and the parent's copy of it is
      // now wrong. Correcting it here means the parent never has to ask.
      if (op !== "clear-history") sendTranscript();
      reply(true);
    } catch (error) {
      reply(false, error instanceof Error ? error.message : String(error));
    }
  };

  /** An explicit request from the portal: exactly one Worker listing, and one reply. */
  const list = async (): Promise<void> => {
    announce(await options.engine.artifacts());
  };

  // Serve one download into the port the parent transferred. The sink is the port: each chunk is
  // posted with its `ArrayBuffer` in the transfer list, so the bytes move rather than copy AND
  // the buffer is detached here. The `await` on the ack bounds live memory.

  /**
   * Transfers this child is currently serving, so they can all be stopped at once. A child told
   * to stop must not keep reading an artifact into a port nobody is listening to, because each
   * transfer holds a LEASE and a lease held is an artifact frozen against Python. Every transfer
   * carries an `AbortController` whose signal goes to `streamArtifact`.
   */
  const active = new Set<AbortController>();
  const abortAll = (reason: string): void => {
    for (const controller of [...active]) {
      active.delete(controller);
      controller.abort(new Error(reason));
    }
  };

  const serve = async (
    port: MessagePort,
    name: string,
    requestId: string,
    chunkOverride?: number,
  ): Promise<void> => {
    let acknowledge: ((ack: ChunkAck) => void) | null = null;
    let cancelled: string | null = null;
    const controller = new AbortController();
    active.add(controller);
    port.onmessage = (event: MessageEvent<ChunkAck>) => {
      const ack = event.data;
      if (ack?.kind === "cancel") {
        cancelled = ack.reason || "the portal cancelled the download";
        // Straight to the engine: a cancel that only unblocked the ack would still let the current
        // chunk read finish, and a cancel that arrives while nothing is awaiting an ack would do
        // nothing at all.
        controller.abort(new Error(cancelled));
      }
      acknowledge?.(ack);
      acknowledge = null;
    };
    port.start?.();

    const waitForAck = () =>
      new Promise<ChunkAck>((resolve) => {
        acknowledge = resolve;
      });

    try {
      const result = await options.engine.streamArtifact(
        name,
        {
          async write(chunk: Uint8Array) {
            if (cancelled) throw new Error(cancelled);
            // A COPY into a fresh buffer, then transferred: `chunk` is a view the engine owns and
            // may reuse, and detaching a buffer somebody else still references is a crash rather
            // than an optimisation.
            const copy = chunk.slice().buffer;
            port.postMessage({ kind: "chunk", bytes: copy }, [copy]);
            const ack = await waitForAck();
            if (ack.kind === "cancel") throw new Error(ack.reason);
          },
          async close() {},
          async abort() {},
        },
        {
          // A chunk size the PARENT asked for is a number from another origin. Anything that is
          // not a sane positive integer is ignored in favour of this bridge's own default rather
          // than passed into the engine, where `NaN` would become a transfer that never advances.
          chunkBytes:
            typeof chunkOverride === "number" &&
            Number.isSafeInteger(chunkOverride) &&
            chunkOverride > 0
              ? chunkOverride
              : chunkBytes,
          signal: controller.signal,
        },
      );
      port.postMessage({ kind: "done", bytesWritten: result.bytesWritten });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // TELL THE PARENT, then give up. A parent waiting on a port learns nothing from that port
      // closing - closing does not notify the peer - so silence here becomes a timeout there,
      // and a timeout is a worse answer than the reason.
      try {
        port.postMessage({ kind: "error", message });
      } catch {
        // the port is already gone; the parent's own inactivity bound covers it
      }
      try {
        send({ kind: "download-refused", requestId, reason: message });
      } catch {
        // the parent's window is gone too
      }
    } finally {
      active.delete(controller);
      try {
        port.close();
      } catch {
        // already closed
      }
    }
  };

  /**
   * Resolve a named example and run it. Refuse everything else, out loud. Each check is answered
   * separately so the reason that comes back is true: a frame that is not the addressee, a build
   * with no manifest, a name nobody registered, and a digest from another deployment are four
   * different problems.
   */
  const runExample = async (
    exampleId: unknown,
    digest: unknown,
    targetSession: unknown,
  ): Promise<void> => {
    // Addressed elsewhere. Silently ignored rather than refused: a portal with two playgrounds
    // broadcasts one message, and the frame that was not meant has nothing to report.
    if (typeof targetSession === "string" && targetSession !== sessionId) return;

    const id = typeof exampleId === "string" ? exampleId : "";
    const refuse = (reason: string): void =>
      send({ kind: "example-refused", exampleId: id, reason });

    if (!options.examples || !options.onRunExample) {
      refuse("this playground registers no examples, so it can run nothing by name");
      return;
    }
    const resolved = options.examples.resolve(exampleId, digest);
    if (!resolved.ok) {
      refuse(resolved.message);
      return;
    }
    // Accepted BEFORE it runs. "Accepted" answers "did the name resolve", which is what the
    // portal waits on to stop showing a pending state; whether the Python then raises appears in
    // the transcript, and waiting for it would tie a button's feedback to somebody's `open_zarr`.
    send({ kind: "example-accepted", exampleId: resolved.example.id });
    try {
      await options.onRunExample(resolved.example);
      // The transcript has changed, and the parent's copy of it is what its Copy control will use.
      // Pushing it here is what lets that control stay synchronous.
      sendTranscript();
    } catch (error) {
      refuse(error instanceof Error ? error.message : String(error));
    }
  };

  const onMessage = (event: MessageEvent): void => {
    // A HAIL IS THE ONE MESSAGE THAT DOES NOT CARRY THIS CHILD'S SESSION: the parent asking "who
    // is in this frame now", answered whatever session the child holds, because the parent may be
    // hailing precisely because it does not know. It must still come from the parent's window, at
    // the parent's exact origin, on this channel, at this version.
    if (!accepted(event, { origin: hostOrigin, source: parent })) return;
    const data = event.data as HostMessage;
    if (data.kind === "hail") {
      // A NEW challenge means the parent has moved on - it navigated, or decided this
      // conversation is over. Whatever is being served belongs to the previous conversation and
      // has nowhere to go, so it is stopped rather than left holding a lease.
      if (challenge && data.challenge !== challenge) abortAll("the portal restarted the session");
      challenge = data.challenge;
      send({ kind: "ready" });
      return;
    }
    // Everything else must belong to the conversation this child is actually having: the parent's
    // current challenge, and this frame's session.
    if (!accepted(event, { origin: hostOrigin, source: parent, sessionId, challenge })) return;
    if (data.kind === "list") {
      // A list the child cannot produce yet is not an error to report anywhere: the usual reason
      // is a portal hailing a document whose interpreter has not started. The engine emits an
      // artifacts event as soon as it is ready, and that announcement is the real answer.
      void list().catch(() => undefined);
      return;
    }
    if (data.kind === "run-example") {
      void runExample(data.exampleId, data.digest, data.targetSession);
      return;
    }
    if (data.kind === "op") {
      // Addressed like `run-example`: a portal running two playgrounds names the one it means, and
      // a child that is not it ignores the message rather than racing to answer.
      if (data.targetSession && data.targetSession !== sessionId) return;
      if (!isBridgeOp(data.op)) {
        send({
          kind: "op-result",
          requestId: typeof data.requestId === "string" ? data.requestId : "",
          ok: false,
          message: "unknown operation",
        });
        return;
      }
      void perform(data.requestId, data.op);
      return;
    }
    if (data.kind === "download") {
      const port = event.ports[0];
      if (!port) {
        send({
          kind: "download-refused",
          requestId: data.requestId,
          reason: "no MessagePort was transferred with the download request",
        });
        return;
      }
      void serve(port, data.name, data.requestId, data.chunkBytes);
    }
  };

  scope.addEventListener("message", onMessage);
  // The event already carries the list. Forwarding it is the entire handler: no `await`, no
  // request, and therefore no way for this listener to cause the event that calls it again.
  const unsubscribe = options.engine.onArtifacts((event) => announce(event.artifacts));
  // ATTACHING ASKS THE WORKER FOR NOTHING. The portal sends `list` as soon as the handshake
  // completes, and that is the initial listing; a second one here would be one request nobody
  // asked for, on every attach, forever.
  send({ kind: "hello" });

  return {
    sessionId,
    announce: list,
    stop() {
      scope.removeEventListener("message", onMessage);
      unsubscribe();
      // Every transfer in flight, stopped - so no artifact is left frozen by a bridge that is no
      // longer listening to anything.
      abortAll("the playground bridge was stopped");
    },
  };
}
