// One session's lifecycle: a locked setup, a live slot while it has an interpreter, and manual
// sleep. Sleeping keeps the front end's document and the committed workspace files and loses
// Python's variables; waking starts a fresh interpreter with the same setup, restores the files
// before any code runs, and never replays cells.
//
//     configured -> starting -> ready <-> busy
//     ready -> sleeping -> asleep -> waking -> restoring -> ready
//                                        \-> wake-error -> waking (retry)
//     any live state -> crashed (the worker died) ; any -> closed

import type { BrowserPython, SessionResources } from "../types.js";
import { CheckpointError, type CheckpointManifest, type CheckpointStore } from "./checkpoint.js";
import { sameSetup, type SessionSetup } from "./policy.js";
import { slotsInUse, type Slot, type SlotBroker, type SlotHolder } from "./slots.js";

export type SessionState =
  | "configured"
  | "starting"
  | "restoring"
  | "ready"
  | "busy"
  | "sleeping"
  | "asleep"
  | "waking"
  | "wake-error"
  | "crashed"
  | "closed";

export interface SessionControllerOptions {
  /** Unique on this page; names the checkpoint. */
  id: string;
  setup: SessionSetup;
  /** The fingerprint of the policy `setup` was validated under. */
  policy: string;
  slots: SlotBroker;
  /** A slot reserved before the session existed (a chooser's Start); used by the first start. */
  slot?: Slot;
  createEngine(setup: SessionSetup): BrowserPython;
  /** Resolves to `null` where checkpoints cannot be kept. */
  store(): Promise<CheckpointStore | null>;
  /** Runs the deployment's starter code; called only when `setup.runStarter`. */
  starter?(engine: BrowserPython): Promise<void>;
  /** Hand the engine to the front end, and take it back before it is disposed. */
  attach(engine: BrowserPython): void;
  detach(engine: BrowserPython): void;
  /** Bytes of output the front end retains, for telemetry. */
  retainedBytes?(): number;
}

export class SessionError extends Error {
  constructor(
    readonly code: "no-slot" | "state" | "unsupported" | "busy" | "checkpoint",
    message: string,
  ) {
    super(message);
    this.name = "SessionError";
  }
}

export interface SessionSnapshot {
  state: SessionState;
  setup: SessionSetup;
  /** Increments with every new interpreter. */
  generation: number;
  /** What went wrong last, for a status line. */
  message?: string;
  /** Files kept while asleep. */
  checkpoint?: { files: number; bytes: number };
}

/** No live slot for this session: every one runs code (one or both, as the page allows). */
const noSlot = (capacity: number): string =>
  `${slotsInUse(capacity)} Wait for it to finish or stop it, then try again.`;

/** What an idle session says once it was put to sleep to make room for another. */
export const RECLAIMED =
  "Put to sleep to make room for another session: its files are kept, its variables are not. " +
  "Wake it to continue.";

export class SessionController {
  readonly id: string;
  readonly setup: SessionSetup;
  #options: SessionControllerOptions;
  #state: SessionState = "configured";
  #generation = 0;
  #message: string | undefined;
  #engine: BrowserPython | null = null;
  #slot: Slot | null = null;
  #reserved: Slot | null;
  #unsubscribe: (() => void) | null = null;
  #checkpoint: CheckpointManifest | null = null;
  #pending: Promise<void> | null = null;
  #listeners = new Set<(snapshot: SessionSnapshot) => void>();
  /** When it last ran code, for the least-recently-used choice of which idle session sleeps. */
  #lastUsed = Date.now();

  constructor(options: SessionControllerOptions) {
    this.id = options.id;
    this.setup = Object.freeze({
      ...options.setup,
      addons: Object.freeze([...options.setup.addons]),
    });
    this.#options = options;
    this.#reserved = options.slot ?? null;
  }

  get state(): SessionState {
    return this.#state;
  }
  get engine(): BrowserPython | null {
    return this.#engine;
  }

  snapshot(): SessionSnapshot {
    return {
      state: this.#state,
      setup: this.setup,
      generation: this.#generation,
      ...(this.#message ? { message: this.#message } : {}),
      ...(this.#checkpoint
        ? {
            checkpoint: {
              files: this.#checkpoint.files.length,
              bytes: this.#checkpoint.totalBytes,
            },
          }
        : {}),
    };
  }

  onChange(listener: (snapshot: SessionSnapshot) => void): () => void {
    this.#listeners.add(listener);
    listener(this.snapshot());
    return () => this.#listeners.delete(listener);
  }

  /** Bring the first interpreter up. Idempotent while starting or live. */
  start(): Promise<void> {
    if (this.#pending) return this.#pending;
    if (this.#state === "configured" || this.#state === "crashed") {
      return this.#exclusive(() => this.#boot("starting"));
    }
    if (this.#state === "closed") return Promise.reject(this.#wrongState("start"));
    return Promise.resolve();
  }

  /** A new interpreter with the same setup. Workspace files go with the old one. */
  restart(): Promise<void> {
    const engine = this.#engine;
    if (!engine || !(this.#live() || this.#state === "crashed")) {
      return Promise.reject(this.#wrongState("restart"));
    }
    return this.#exclusive(async () => {
      // A crashed worker gave its slot back: the restarted one takes a slot again first.
      if (!this.#slot) {
        const slot = await this.#options.slots.reserve(this.id, this.#holder());
        if (this.#state === "closed") {
          slot?.release();
          throw this.#closedDuringStart();
        }
        if (!slot) {
          this.#set("crashed", noSlot(this.#options.slots.capacity));
          throw new SessionError("no-slot", noSlot(this.#options.slots.capacity));
        }
        this.#slot = slot;
      }
      this.#set("starting");
      try {
        await engine.restart();
        this.#generation += 1;
        await this.#runStarter(engine);
        this.#set("ready");
      } catch (error) {
        // No live interpreter: its reservation goes too.
        this.#releaseSlot();
        this.#set("crashed", messageOf(error));
        throw error;
      }
    });
  }

  /**
   * Save the committed files and stop the interpreter. Refused - and nothing changes - when
   * code is running, a file is open in Python, or the files cannot be kept.
   */
  sleep(reason?: string): Promise<void> {
    const engine = this.#engine;
    if (engine && this.#state === "busy") {
      return Promise.reject(
        new SessionError("busy", "Python is running, so the session cannot sleep now."),
      );
    }
    if (!engine || this.#state !== "ready") return Promise.reject(this.#wrongState("sleep"));
    return this.#exclusive(async () => {
      const store = await this.#options.store();
      if (!store) {
        throw new SessionError(
          "unsupported",
          "This browser cannot keep files for a sleeping session. Download the files you need, " +
            "then close the session instead.",
        );
      }
      let release: () => void;
      try {
        release = await engine.quiesce();
      } catch (error) {
        throw new SessionError(
          "busy",
          `Python is busy, so the session cannot sleep now: ${messageOf(error)}`,
        );
      }
      this.#set("sleeping");
      let writer: Awaited<ReturnType<CheckpointStore["begin"]>> | null = null;
      try {
        const files = (await engine.artifacts()).filter((file) => file.state === "ready");
        writer = await store.begin(
          this.id,
          files.map(({ name, size }) => ({ name, size })),
        );
        for (const file of files) await engine.streamArtifact(file.name, writer.file(file.name));
        this.#checkpoint = await writer.commit({ setup: this.setup, policy: this.#options.policy });
      } catch (error) {
        await writer?.abort();
        release();
        this.#set("ready", `The session stayed awake: ${messageOf(error)}`);
        throw error instanceof CheckpointError
          ? new SessionError("checkpoint", error.message)
          : error;
      }
      this.#drop(engine);
      await engine.disposeAsync().catch(() => undefined);
      this.#set("asleep", reason);
    });
  }

  /** A fresh interpreter with the same setup, its files restored before any code runs. */
  wake(): Promise<void> {
    if (this.#state !== "asleep" && this.#state !== "wake-error") {
      return Promise.reject(this.#wrongState("wake"));
    }
    return this.#exclusive(() => this.#boot("waking"));
  }

  /** A resource sample, or `null` with no interpreter. Never rejects for a busy worker. */
  async resources(): Promise<(SessionResources & { live: number; capacity: number }) | null> {
    const engine = this.#engine;
    if (!engine || !this.#live()) return null;
    const sample = await engine.observeResources();
    const retained = this.#options.retainedBytes?.();
    return {
      ...sample,
      ...(retained !== undefined ? { outputRetainedBytes: retained } : {}),
      live: await this.#options.slots.held(),
      capacity: this.#options.slots.capacity,
    };
  }

  /** Stop the interpreter and delete any checkpoint. Terminal. */
  async close(): Promise<void> {
    if (this.#state === "closed") return;
    const engine = this.#engine;
    this.#state = "closed";
    this.#reserved?.release();
    this.#reserved = null;
    if (engine) {
      this.#drop(engine);
      await engine.disposeAsync().catch(() => undefined);
    }
    this.#releaseSlot();
    const store = await this.#options.store().catch(() => null);
    await store?.discard(this.id).catch(() => undefined);
    this.#checkpoint = null;
    this.#emit();
  }

  async #boot(phase: "starting" | "waking"): Promise<void> {
    const dead = this.#engine;
    if (dead) {
      this.#drop(dead);
      await dead.disposeAsync().catch(() => undefined);
    }
    const holder = this.#holder();
    const slot = this.#reserved ?? (await this.#options.slots.reserve(this.id, holder));
    slot?.claim?.(holder);
    this.#reserved = null;
    if (this.#state === "closed") {
      // Closed while the slot was being reserved: give it back, start nothing.
      slot?.release();
      throw this.#closedDuringStart();
    }
    if (!slot) {
      this.#set(phase === "waking" ? "asleep" : this.#state, noSlot(this.#options.slots.capacity));
      throw new SessionError("no-slot", noSlot(this.#options.slots.capacity));
    }
    this.#slot = slot;
    this.#set(phase);
    let manifest: CheckpointManifest | null = null;
    let store: CheckpointStore | null = null;
    let engine: BrowserPython | null = null;
    try {
      if (phase === "waking") {
        store = await this.#options.store();
        if (!store)
          throw new SessionError("unsupported", "the saved files are no longer available");
        manifest = await store.read(this.id);
        this.#stopIfClosed();
        if (!sameSetup(manifest.setup, this.setup) || manifest.policy !== this.#options.policy) {
          throw new CheckpointError("corrupt", "the saved files belong to a different setup");
        }
      }
      engine = this.#options.createEngine(this.setup);
      this.#engine = engine;
      this.#unsubscribe = engine.onStatus((event) => this.#onEngineState(event.state));
      // A woken session's front end gets the engine only once its files are back, so nothing
      // typed there can run before the restore.
      if (!manifest) this.#options.attach(engine);
      await engine.start();
      this.#stopIfClosed();
      this.#generation += 1;
      if (manifest && store) {
        this.#set("restoring");
        for (const file of manifest.files) {
          await engine.writeWorkspaceFile(file.name, store.open(manifest, file), {
            size: file.size,
          });
          this.#stopIfClosed();
        }
      }
      if (manifest) this.#options.attach(engine);
      await this.#runStarter(engine);
      this.#stopIfClosed();
      if (manifest && store) await store.discard(this.id);
      this.#checkpoint = null;
      this.#set("ready");
    } catch (error) {
      if (engine) {
        this.#drop(engine);
        await engine.disposeAsync().catch(() => undefined);
      }
      this.#releaseSlot();
      if (phase === "waking") {
        if (error instanceof CheckpointError && error.code === "corrupt" && store) {
          await store.quarantine(this.id, error.message).catch(() => undefined);
        }
        this.#set("wake-error", `The session could not wake: ${messageOf(error)}`);
      } else {
        this.#set("crashed", messageOf(error));
      }
      throw error;
    }
  }

  /** An idle session elsewhere on the page may be put to sleep for this one; so may this one. */
  #holder(): SlotHolder {
    return {
      idle: () => this.#state === "ready" && !this.#pending,
      lastUsed: () => this.#lastUsed,
      sleep: () => this.sleep(RECLAIMED),
    };
  }

  async #runStarter(engine: BrowserPython): Promise<void> {
    if (this.setup.runStarter && this.#options.starter) await this.#options.starter(engine);
  }

  #onEngineState(state: string): void {
    if (!this.#live()) return;
    if (state === "busy") this.#set("busy");
    else if (state === "ready") {
      if (this.#state === "busy") this.#lastUsed = Date.now();
      this.#set("ready");
    } else if (state === "error") {
      // The worker is gone: so is its claim on a live slot (a restart takes one again).
      this.#releaseSlot();
      this.#set("crashed", "Python stopped unexpectedly.");
    }
  }

  #live(): boolean {
    return this.#state === "ready" || this.#state === "busy";
  }

  /** Detach and unsubscribe; the slot goes with the engine. */
  #drop(engine: BrowserPython): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    try {
      this.#options.detach(engine);
    } catch {
      // the front end may already be gone
    }
    this.#engine = null;
    this.#releaseSlot();
  }

  #releaseSlot(): void {
    this.#slot?.release();
    this.#slot = null;
  }

  #exclusive(work: () => Promise<void>): Promise<void> {
    if (this.#pending)
      return Promise.reject(new SessionError("state", "the session is changing state"));
    const run = work().finally(() => {
      this.#pending = null;
    });
    this.#pending = run;
    return run;
  }

  /** `close()` ran during a start or wake: everything that start acquired is given back. */
  #stopIfClosed(): void {
    if (this.#state === "closed") throw this.#closedDuringStart();
  }

  #closedDuringStart(): SessionError {
    return new SessionError("state", "the session was closed while it started");
  }

  #wrongState(action: string): SessionError {
    return new SessionError("state", `cannot ${action} a session that is ${this.#state}`);
  }

  #set(state: SessionState, message?: string): void {
    if (this.#state === "closed") return;
    this.#state = state;
    this.#message = message;
    this.#emit();
  }

  #emit(): void {
    const snapshot = this.snapshot();
    for (const listener of [...this.#listeners]) listener(snapshot);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
