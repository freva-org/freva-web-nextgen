// ClimateClaw as an AI SDK language model (specification v4, what `ai@7` - the version
// jupyterlite-ai 0.20.1 bundles - calls). Only the newest user message is sent, with the chat's
// thread id; ClimateClaw keeps the conversation itself.

import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";

import type { ActivityStore } from "./activity.js";
import { STOP_CONFIRM_MS, type ClimateClawApi } from "./api.js";
import { fetchFigure, savedFigures, type SavedFigure } from "./figures.js";
import { RunCards, type RunPointer } from "./run-card.js";
import { NdjsonDecoder, VariantMapper, type CodeOutput, type StreamEvent } from "./stream.js";
import { PROVIDER_ID } from "./config.js";
import { delay, retryConflict, SETTLE_MS, type ThreadGate } from "./thread-gate.js";
import {
  ThreadTable,
  branchOf,
  latestUserText,
  localTitle,
  markedThread,
  stripBranch,
  threadMarker,
  turnMarker,
} from "./threads.js";

export interface ModelContext {
  /** The API, or null when the extension is not configured. */
  api(): ClimateClawApi | null;
  /** Null when signed in; otherwise the sentence to show. */
  signInProblem(): string | null;
  hideCode(): boolean;
  scopeNote(): string;
  /**
   * The in-memory fallback for replies that left no marker. Absent, the model keeps its own:
   * jupyterlite-ai creates one model per chat, so a per-model table belongs to exactly one chat,
   * and two chats that begin with the same words never share a thread.
   */
  threads?: ThreadTable;
  /**
   * Where code that ran goes instead of the chat (the thread's notebook, named `title` when it
   * is made), or null to keep it in the chat.
   */
  codeSink?(threadId: string, title: string): CodeSink | null;
  /** Where each thread's current activity is published (the composer's status line). */
  activity?: ActivityStore;
  /** Remote threads still busy (shared with Run & fix): a request waits for its thread. */
  gate?: ThreadGate;
  /** How a 409 (the thread still busy) is retried; tests shorten it. */
  retry?: { attempts?: number; delayMs?: number };
  /** How long a thread stays held after a stop or a broken stream; tests shorten it. */
  settleMs?: number;
  /** How long a stopped stream is read on for the server's confirmation; tests shorten it. */
  stopWaitMs?: number;
  /** How long a stop request may go unanswered before its thread is let go; tests shorten it. */
  stopConfirmMs?: number;
  /**
   * Signed out where a reply can carry a sign-in button (ClimateClaw's own panel): the reply asks
   * to sign in, instead of an error.
   */
  signedOut?(): boolean;
  /** Reads a saved figure's bytes (tests replace it). */
  fetchFigure?: typeof fetchFigure;
  /** Where the page may show saved figures from by their address. */
  imageOrigin?: string;
}

/** Receives the code ClimateClaw ran, its output and figures, in stream order. */
export interface CodeSink {
  /**
   * The code so far, while it streams: the first call makes its cell and returns which cell it
   * is (for the run's card in the chat); later ones return null.
   */
  partial(id: string, code: string): RunPointer | null;
  /** The whole code: completes its cell (or makes one); returns the new cell, or null. */
  code(id: string, code: string): RunPointer | null;
  /** The output: goes to its cell. */
  output(id: string, output: CodeOutput): void;
  /** A figure: goes to its cell. */
  image(id: string, mime: string, base64: string): void;
  /**
   * A figure the code saved to a file (not streamed): goes to its cell, as an image when its bytes
   * are here (`base64`), else by its address.
   */
  savedFigure?(id: string, figure: SavedFigure, base64: string | null): void;
  /** The server forked the thread: the notebook and its cells now belong to `thread`. */
  follow?(thread: string): void;
}

const USAGE: LanguageModelV4Usage = {
  inputTokens: {
    total: undefined,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};

/** The note shown at the top of a new thread's first reply. */
export function scopeNoteMarkdown(note: string): string {
  const quoted = note
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `> **Scope note** - sent with the first message of this conversation. It guides the answers; it does not restrict them.\n>\n${quoted}\n\n`;
}

/** The input for a request: the scope note goes in front of a new thread's first message only. */
export function composeInput(input: string, isNewThread: boolean, scopeNote: string): string {
  return isNewThread && scopeNote ? `${scopeNote}\n\n${input}` : input;
}

export class ClimateClawModel implements LanguageModelV4 {
  readonly specificationVersion = "v4" as const;
  readonly provider = PROVIDER_ID;
  readonly supportedUrls = {};

  /** This chat's fallback thread table (see `ModelContext.threads`). */
  readonly #threads: ThreadTable;

  constructor(
    readonly modelId: string,
    private readonly context: ModelContext,
  ) {
    this.#threads = context.threads ?? new ThreadTable();
  }

  /**
   * jupyterlite-ai uses non-streaming calls only for chat titles: answered here, from the first
   * user message, without a request - a title request sent to ClimateClaw would land in a thread.
   */
  async doGenerate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
    return {
      content: [{ type: "text", text: localTitle(options.prompt) }],
      finishReason: { unified: "stop", raw: undefined },
      usage: USAGE,
      warnings: [],
    };
  }

  async doStream(options: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamResult> {
    const api = this.context.api();
    if (!api) {
      throw new Error(
        "ClimateClaw is not configured for this site (no Freva host). Ask the site's operator.",
      );
    }
    const problem = this.context.signInProblem();
    if (problem && this.context.signedOut?.()) return signInReply();
    if (problem) throw new Error(problem);
    // An edited question names its branch; the marker is never sent.
    const question = latestUserText(options.prompt);
    const branch = branchOf(question);
    const input = stripBranch(question).trim();
    if (!input) throw new Error("There is no message to send.");
    const signal = options.abortSignal;
    const gate = this.context.gate ?? null;
    const settle = this.context.settleMs ?? SETTLE_MS;
    const stopWait = this.context.stopWaitMs ?? STOP_WAIT_MS;
    const stopConfirm = this.context.stopConfirmMs ?? STOP_CONFIRM_MS;
    /**
     * Asks the server to stop `id`, and holds the thread until it answers - at most `stopConfirm`
     * - and then a settling while. Unanswered, the thread is let go all the same: a request that
     * still meets the stream is refused with 409, which is retried (`retryConflict`).
     */
    const holdStopped = (id: string) =>
      gate?.hold(
        id,
        api.stopConfirmed(id, { timeoutMs: stopConfirm }).then(() => delay(settle)),
      );
    const readFigure = this.context.fetchFigure ?? fetchFigure;
    const imageOrigin = this.context.imageOrigin;
    const activity = this.context.activity ?? null;

    let threadId = branch ?? this.#threads.resolve(options.prompt);
    // A new conversation (for the server too, or a branch with no reply yet): marked in the
    // reply, with the scope note.
    const isNew = branch ? markedThread(options.prompt) !== branch : threadId === null;
    threadId ??= await api.newThread(signal);
    const thread = threadId;
    this.#threads.remember(options.prompt, thread);
    const scopeNote = this.context.scopeNote();
    const waiting = () => activity?.set(thread, "thinking", "Waiting for the last reply to stop");

    // Not tied to the chat's signal: after a stop the stream is read on, unseen, until the server
    // has ended it, so the thread is known to be free. Aborted only before the reply starts, or
    // when the server takes too long to confirm the stop.
    const request = new AbortController();
    const abortEarly = () => request.abort();
    signal?.addEventListener("abort", abortEarly, { once: true });
    // Stopped while the thread was being made: the abort came before the listener, so nothing
    // would cancel the request. Nothing is sent.
    if (signal?.aborted) {
      signal.removeEventListener("abort", abortEarly);
      throw abortError();
    }
    let response: Response;
    try {
      if (gate?.busy(thread)) waiting();
      await gate?.wait(thread, signal);
      response = await retryConflict(
        () =>
          api.streamResponse(
            {
              thread_id: thread,
              input: composeInput(input, isNew, scopeNote),
              ...(this.modelId ? { chatbot: this.modelId } : {}),
            },
            request.signal,
          ),
        { ...this.context.retry, signal, onWait: waiting },
      );
    } catch (error) {
      activity?.end(thread);
      // The request may have reached the server: ask it to stop, and keep the thread a while.
      if (signal?.aborted) holdStopped(thread);
      throw error;
    } finally {
      signal?.removeEventListener("abort", abortEarly);
    }

    const reader = response.body!.getReader();
    const sink = this.context.codeSink?.(thread, localTitle(options.prompt)) ?? null;
    activity?.start(thread);
    const mapper = new VariantMapper({
      hideCode: this.context.hideCode(),
      codeToNotebook: !!sink,
      activity: !!activity,
      cards: true,
    });
    // Each run as one card in the reply, written when it is over (see run-card.ts).
    const cards = new RunCards({ open: !this.context.hideCode(), imageOrigin });
    const threads = this.#threads;
    let current = thread;
    let release: () => void = () => undefined;
    const ended = new Promise<void>((resolve) => (release = resolve));
    gate?.hold(thread, ended);
    let stop: () => void = () => undefined;

    const stream = new ReadableStream<LanguageModelV4StreamPart>({
      async start(controller) {
        const textId = "climateclaw-text";
        /** The consumer stopped: the rest of the stream is read, not shown. */
        let detached = false;
        let give: ReturnType<typeof setTimeout> | null = null;
        const send = (part: LanguageModelV4StreamPart) => {
          if (detached) return;
          try {
            controller.enqueue(part);
          } catch {
            // The consumer cancelled (a stop): nothing more is wanted.
            detached = true;
          }
        };
        const close = () => {
          try {
            controller.close();
          } catch {
            // Already closed by the consumer.
          }
        };
        stop = () => {
          if (detached) return;
          detached = true;
          pending = "";
          close();
          activity?.set(current, "thinking", "Stopping");
          void api.stop(current);
          // Unconfirmed after this long: stop reading, and keep the thread a while longer.
          give = setTimeout(() => request.abort(), stopWait);
        };
        signal?.addEventListener("abort", stop, { once: true });
        let pending = "";
        const emit = (delta: string) => {
          if (delta) send({ type: "text-delta", id: textId, delta });
        };
        // Typed out: a host that sends its reply in a few large blocks still reads as a stream.
        // Each tick releases a share of what is waiting, so a burst drains in well under a second.
        let timer: ReturnType<typeof setInterval> | null = null;
        let drainedWaiter: (() => void) | null = null;
        const tick = () => {
          if (!pending) {
            if (timer) clearInterval(timer);
            timer = null;
            drainedWaiter?.();
            drainedWaiter = null;
            return;
          }
          let cut = Math.min(pending.length, Math.max(4, Math.ceil(pending.length / 12)));
          if (cut < pending.length && /[\uD800-\uDBFF]/.test(pending[cut - 1] ?? "")) cut += 1;
          emit(pending.slice(0, cut));
          pending = pending.slice(cut);
        };
        // A chip ends the text inline (the next chip joins its line); text after it starts anew.
        let inline = false;
        const text = (delta: string) => {
          if (!delta || detached) return;
          if (inline) {
            inline = false;
            delta = `\n\n${delta}`;
          }
          pending += delta;
          timer ??= setInterval(tick, 20);
        };
        const flushNow = () => {
          if (timer) clearInterval(timer);
          timer = null;
          emit(pending);
          pending = "";
          drainedWaiter?.();
          drainedWaiter = null;
        };
        const drained = () =>
          pending || timer
            ? new Promise<void>((resolve) => {
                drainedWaiter = resolve;
              })
            : Promise.resolve();
        send({ type: "stream-start", warnings: [] });
        send({ type: "text-start", id: textId });
        if (isNew) {
          // Not typed out: half an HTML comment would show as text.
          emit(`${threadMarker(current)}\n`);
          if (scopeNote) emit(scopeNoteMarkdown(scopeNote));
        }
        /** HTML, whole: typed out, half a tag would show as text. */
        const chip = (html: string) => {
          if (!html) return;
          flushNow();
          emit(html);
          inline = true;
        };
        /** The cards of the runs that are over, before what follows them. */
        const runsOver = () => {
          if (cards.pending) chip(cards.flush());
        };
        const handle = (events: StreamEvent[]) => {
          for (const event of events) {
            if (event.type === "text") {
              runsOver();
              text(event.text);
            } else if (event.type === "code-partial" || event.type === "code") {
              // A new run: the one before it is over.
              if (cards.isNew(event.id)) runsOver();
              const pointer = sink
                ? event.type === "code"
                  ? sink.code(event.id, event.code)
                  : sink.partial(event.id, event.code)
                : null;
              cards.code(event.id, event.code, pointer);
            } else if (event.type === "activity") activity?.set(current, event.phase, event.label);
            else if (event.type === "output") {
              sink?.output(event.id, event.output);
              cards.output(event.id, event.output);
              for (const figure of savedFigures(event.output)) figures.push([event.id, figure]);
            } else if (event.type === "image") {
              sink?.image(event.id, event.mime, event.base64);
              cards.image(event.id, event.mime, event.base64);
            } else if (event.type === "status") {
              runsOver();
              text(`\n\n_${event.text}_\n\n`);
            } else if (event.type === "error") {
              runsOver();
              flushNow();
              send({ type: "error", error: new Error(event.message) });
            } else if (event.type === "thread" && event.threadId !== current) {
              // The server forked the thread (it belonged to someone else): everything follows -
              // the activity and cells, the notebook, a stop, and the thread held until the end.
              activity?.move(current, event.threadId);
              sink?.follow?.(event.threadId);
              current = event.threadId;
              gate?.hold(current, ended);
              threads.remember(options.prompt, current);
              flushNow();
              emit(`${threadMarker(current)}\n`);
            }
          }
        };
        /** Saved figures named by the outputs so far, shown in stream order before what follows. */
        const figures: Array<[string, SavedFigure]> = [];
        const showFigures = async () => {
          while (figures.length && !detached) {
            const [id, figure] = figures.shift()!;
            const base64 = await readFigure(figure, { signal: request.signal });
            sink?.savedFigure?.(id, figure, base64);
            cards.figure(id, figure, base64);
          }
        };
        const decoder = new TextDecoder();
        const lines = new NdjsonDecoder();
        let broken = false;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            for (const line of lines.push(decoder.decode(value, { stream: true }))) {
              if ("value" in line) handle(mapper.map(line.value));
              // In stream order: before the text that follows the output naming it.
              if (figures.length) await showFigures();
            }
            if (mapper.finished) break;
          }
          for (const line of lines.push(decoder.decode())) {
            if ("value" in line) handle(mapper.map(line.value));
          }
          for (const line of lines.flush()) if ("value" in line) handle(mapper.map(line.value));
          handle(mapper.flush());
          await showFigures();
          runsOver();
          await drained();
          broken = !mapper.finished;
          if (mapper.finished && !detached) {
            // Where the server stored this reply, for rating it and editing its question.
            const turn = await storedTurn(api, current);
            if (turn !== null) emit(turnMarker(current, turn));
          }
          send({ type: "text-end", id: textId });
          send({
            type: "finish",
            usage: USAGE,
            finishReason: {
              unified: mapper.finished ? "stop" : "other",
              raw: mapper.finished ? "StreamEnd" : "closed",
            },
          });
          close();
        } catch (error) {
          broken = true;
          if (!detached) runsOver();
          flushNow();
          if (!detached && !signal?.aborted) send({ type: "error", error });
          close();
        } finally {
          if (give) clearTimeout(give);
          signal?.removeEventListener("abort", stop);
          activity?.end(current);
          // Ended without the server saying so (a broken connection, an unconfirmed stop): the
          // server may still be answering. Asked to stop, the thread is held a little longer.
          if (broken && !mapper.finished) holdStopped(current);
          release();
        }
      },
      cancel() {
        // The consumer went away (a stop, or an error it gave up on).
        if (!mapper.finished) stop();
      },
    });
    return { stream, request: { body: { thread_id: thread, chatbot: this.modelId } } };
  }
}

/** Marks the reply that asks to sign in (the panel's button refills the question after it). */
export const SIGN_IN_MARKER = "<!-- climateclaw:sign-in -->";

/** A reply, not an error: sign in, and the question comes back to the composer. */
export const SIGN_IN_REPLY =
  `${SIGN_IN_MARKER}\n**Sign in to ask ClimateClaw.** It runs on your Freva account at DKRZ.\n\n` +
  '<a class="jp-ClimateClaw-signInLink" href="#sign-in">👉 Sign in with Freva</a>\n\n' +
  "_Your question comes back to the box below once you are signed in._";

function signInReply(): LanguageModelV4StreamResult {
  const id = "climateclaw-sign-in";
  const parts: LanguageModelV4StreamPart[] = [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id },
    { type: "text-delta", id, delta: SIGN_IN_REPLY },
    { type: "text-end", id },
    { type: "finish", usage: USAGE, finishReason: { unified: "stop", raw: "SignIn" } },
  ];
  return {
    stream: new ReadableStream<LanguageModelV4StreamPart>({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    }),
  };
}

/** How long a stopped stream is read on for the server's confirmation. */
export const STOP_WAIT_MS = 20_000;

/** The user message (from 0) the newest reply of a stored thread answers, or null. */
async function storedTurn(api: ClimateClawApi, thread: string): Promise<number | null> {
  try {
    const variants = await api.thread(thread);
    const users = variants.filter((v) => (v as { variant?: unknown })?.variant === "User").length;
    return users > 0 ? users - 1 : null;
  } catch {
    return null;
  }
}

/** The error for a request stopped before it was sent. */
function abortError(): DOMException {
  return new DOMException("The request was stopped before it was sent.", "AbortError");
}
