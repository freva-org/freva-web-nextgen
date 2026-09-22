/**
 * browser-python.worker.ts - the worker's message loop. Deliberately dull: every interesting
 * decision is in `repl.ts`, `pyodide-runtime.ts` or `protocol.ts`. Two properties it must guarantee
 * - requests are serialised through one queue, because Python is single-threaded and two
 * overlapping `push` calls would interleave one console's line buffer with another's; and every
 * request either replies or errors with ITS OWN id, because the main thread's pending table is
 * keyed on that.
 */

import { PROTOCOL_VERSION, type WorkerMessage, type WorkerRequest } from "../protocol.js";
import { defaultAddonBase, describeAddons, prepareAddons } from "./addons.js";
import { ArtifactWatcher } from "./artifacts.js";
import { Workspace } from "./opfs-workspace.js";
import { OutputBridge } from "./output.js";
import { Repl } from "./repl.js";
import {
  PROFILE_PACKAGES,
  PROFILE_REPORTED,
  RuntimeError,
  checkEnvironment,
  collapsePackageErrors,
  filterPackageNotes,
  installFrevaClient,
  installPythonHelpers,
  mountPersistentStorage,
  loadProfilePackages,
  loadRuntime,
  supportsJspi,
  type PyodideApi,
} from "./pyodide-runtime.js";
import type { BrowserPythonReadyInfo, WorkspaceStatus } from "../types.js";

declare const self: DedicatedWorkerGlobalScope;

const postRaw: (message: WorkerMessage, transfer?: Transferable[]) => void = (
  message,
  transfer,
) => {
  if (transfer && transfer.length > 0) self.postMessage(message, transfer);
  else self.postMessage(message);
};
const output = new OutputBridge(postRaw);

/**
 * Every message this file sends, with the pending output batch emitted first: `OutputBridge`
 * batches text, so a reply or artifact notice posted straight past it would arrive BEFORE the
 * output Python produced first. `postRaw` is the bridge's own escape hatch.
 */
const post: (message: WorkerMessage, transfer?: Transferable[]) => void = (message, transfer) => {
  output.flush();
  postRaw(message, transfer);
};

/**
 * What `ready` will report about storage. Set during init whether the workspace opened or not, so
 * the "unavailable" answer is as much a result as the available one.
 */
let workspaceStatus: WorkspaceStatus = {
  available: false,
  reason: "open-failed",
  detail: "The interpreter did not finish starting.",
  path: "/workspace",
  maxFiles: 0,
  sessionId: "",
};

/**
 * Whether credentials will actually survive a reload. Reported in `ready` rather than only on
 * stderr: a host that asked for persistence and did not get it cannot tell from outside.
 */
let credentialsPersisted = false;

/**
 * Which Worker instance this is, as the engine named it in `init`. Checked on every artifact
 * message: lease ids are a per-Worker counter, so a message left over from a transfer that outlived
 * a restart carries one THIS worker would also recognise.
 */
let workerSession = "";

/**
 * Whether the interpreter is still coming up. Read by `filterPackageNotes`, which keeps Pyodide's
 * `Loading …` notes once a session is running - a visitor's own `import matplotlib` fetches
 * megabytes - and drops them during startup.
 */
let phase: "starting" | "running" = "starting";

let pyodide: PyodideApi | null = null;
let repl: Repl | null = null;
let workspace: Workspace | null = null;
let watcher: ArtifactWatcher | null = null;

/**
 * The serialisation point: every handler is chained onto this, so requests run one at a time in
 * arrival order. Without it a `complete()` fired by a keystroke would re-enter Python while a
 * `push()` was awaiting a future.
 */
let queue: Promise<void> = Promise.resolve();

function enqueue(task: () => Promise<void>): void {
  queue = queue.then(task).catch((error) => {
    // A handler is expected to answer its own request; reaching here means one threw first, which
    // is a bug in this file rather than in the user's Python - fatal, and named as such rather than
    // swallowed into a stalled queue.
    post({ kind: "fatal", message: `The Python worker failed: ${describe(error)}` });
  });
}

/**
 * Where the Freva wheels live when the host does not say: beside the runtime, in `freva-wheels/`. A
 * host that keeps them elsewhere passes `wheelhouseURL`.
 */
function defaultWheelhouse(indexURL: string): string {
  return new URL("../freva-wheels/", indexURL).href;
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function handleInit(request: Extract<WorkerRequest, { kind: "init" }>): Promise<void> {
  if (request.protocol !== PROTOCOL_VERSION) {
    post({
      kind: "fatal",
      id: request.id,
      // Names BOTH possibilities, because the version numbers alone do not say which file is old. A
      // long-cached page against a freshly deployed worker and a fresh page against a cached worker
      // produce the same mismatch and need opposite answers - reload versus purge the asset cache.
      message:
        `Protocol mismatch: the page speaks v${request.protocol} and this worker speaks ` +
        `v${PROTOCOL_VERSION}. One of the two is cached from an older deployment - reload the ` +
        `page, and if that does not fix it, check that the worker asset is not being served from ` +
        `a stale cache.`,
    });
    return;
  }

  workerSession = request.workerSession;
  const started = Date.now();
  const unsupported = checkEnvironment();
  if (unsupported) {
    post({
      kind: "fatal",
      id: request.id,
      message: "This browser cannot run WebAssembly, which the Python runtime requires.",
      reason: unsupported,
    });
    return;
  }

  try {
    output.status("loading", "downloading the Python runtime");
    pyodide = await loadRuntime({
      indexURL: request.indexURL,
      ...(request.packageBaseURL !== undefined ? { packageBaseURL: request.packageBaseURL } : {}),
      // Pyodide's own startup chatter, before any user code exists. Routed to stderr under the
      // empty execution id rather than dropped, so a failing wheel download is visible - but
      // reshaped first, because `PyodideConsole` loads packages from inside Python and its failures
      // arrive as one run-on paragraph. See `collapsePackageErrors` and `filterPackageNotes`.
      onStdout: (text) => {
        const kept = filterPackageNotes(text, phase);
        if (kept) output.stdout(kept);
      },
      onStderr: (text) => output.stderr(collapsePackageErrors(text)),
    });

    installPythonHelpers(pyodide);

    // The workspace, BEFORE any package loads and long before user code: mounting changes the
    // working directory, and a relative path opened by a library at import time would otherwise
    // land in MEMFS and appear to move. Failure is never fatal - `Workspace.open` reports why, and
    // the reason travels in `ready`.
    output.status("loading", "opening the workspace");
    const opened = await Workspace.open(pyodide, {
      ...(request.workspaceMaxFiles !== undefined ? { maxFiles: request.workspaceMaxFiles } : {}),
    });
    if ("workspace" in opened) {
      workspace = opened.workspace;
      workspace.mount();
      workspaceStatus = workspace.status();
      // The terse `[Errno 33]` a pool exhaustion produces is about a limit that belongs to this
      // package rather than to an operating system, so the explanation is appended to the traceback
      // that carries it.
      output.annotate(workspace.annotate);
      watcher = new ArtifactWatcher(workspace, post);
    } else {
      workspaceStatus = opened.status;
      // Said out loud, at the prompt, once. `ready.workspace.available` is false and a host can
      // read it, but the person about to type `ds.to_netcdf(...)` is not reading a status object,
      // and "files went to memory" is not a conclusion anyone reaches from a crashed tab. The
      // workspace is deliberately NOT mounted in this mode.
      output.stderr(
        `[browser-python] ${workspaceStatus.detail ?? "The disk-backed workspace is unavailable."}` +
          `\n[browser-python] Files written by Python are kept in memory in this session, and ` +
          `there is no download panel. Exporting anything large may exhaust the tab.\n`,
      );
    }

    const packages = [...PROFILE_PACKAGES[request.profile], ...request.packages];
    if (packages.length > 0) {
      output.status("loading", `loading ${packages.join(", ")}`);
      // Not a bare `loadPackage`: it resolves when a wheel fails to download. See the helper.
      await loadProfilePackages(pyodide, packages, request.packageBaseURL ?? request.indexURL);
    }

    // ADD-ONS, after the profile's packages and before anything imports the libraries they change.
    // xarray decides whether Dask exists the first time anything asks, caching that in two
    // `lru_cache`s and on `DaskManager.available` at import. The ready payload below imports
    // xarray, so an add-on installed any later would land in an interpreter that had already
    // decided Dask was absent: `import dask` succeeds and `chunks={}` raises "chunk manager 'dask'
    // is not available". A local binding, because the two callbacks below are closures and a
    // closure reads the module-scope `let` at its declared type - which includes the `null` this
    // branch has ruled out.
    const runtime = pyodide;
    const { prepared, unavailable } =
      request.addons.length > 0
        ? await prepareAddons(runtime, {
            addons: request.addons,
            ...(request.optionalAddons?.length ? { optional: request.optionalAddons } : {}),
            profile: request.profile,
            addonBaseURL: request.addonBaseURL ?? defaultAddonBase(request.indexURL),
            onStatus: (message) => output.status("loading", message),
            // ONE line on stderr, at the moment the decision is made - not a traceback, and not one
            // per restart. The ready payload carries the same fact in `unavailableAddons`, which is
            // where a UI should read it; this is for somebody watching the transcript.
            onWarning: (message) => output.stderr(`[browser-python] ${message}\n`),
            loadPackages: (names, where) =>
              loadProfilePackages(
                runtime,
                [...names],
                request.packageBaseURL ?? request.indexURL,
                `${where} needs packages from the pinned runtime, but`,
              ),
          })
        : { prepared: [], unavailable: [] };

    // The Freva client, before the REPL. Order matters and is asserted by a browser test: the
    // compatibility adapter replaces attributes `freva_client`'s own modules bind at IMPORT time,
    // so it has to run before anything imports freva_client, and the REPL is the first thing that
    // could.
    if (request.profile === "freva-client") {
      // Storage BEFORE the wheels, and well before anything imports freva_client: IDBFS fills
      // asynchronously, so a token store read before the populate lands finds nothing and asks the
      // visitor to log in again over a credential sitting in IndexedDB.
      if (request.persistCredentials) {
        output.status("loading", "opening persistent storage");
        const persisted = await mountPersistentStorage(pyodide, (reason) => {
          // The flush worked at startup and has stopped working: the quota filled, or the origin's
          // storage was evicted. Python swallows this on purpose - a storage failure must not fail
          // an authentication that succeeded - so this callback is the only place the fact exists,
          // and the hook removes itself after one report.
          credentialsPersisted = false;
          output.stderr(
            "[browser-python] persistent storage stopped accepting writes, so credentials will " +
              `not survive a reload from here on: ${describe(reason)}. This session is unaffected.\n`,
          );
          post({ kind: "storage", credentialsPersisted: false, detail: describe(reason) });
        });
        credentialsPersisted = persisted;
        if (!persisted) {
          // Not fatal, and not silently claimed either. Authentication still works; it just ends
          // with the tab.
          output.stderr(
            "[browser-python] persistent storage is unavailable in this browser, so credentials " +
              "will not survive a reload. Authentication still works for this session.\n",
          );
        }
      }

      output.status("loading", "installing the Freva client");
      await installFrevaClient(
        pyodide,
        request.wheelhouseURL ?? defaultWheelhouse(request.indexURL),
      );
      output.status("loading", "applying browser compatibility");
      await pyodide.runPythonAsync("import freva_client_compat\nfreva_client_compat.install()\n");
    }

    output.status("loading", "starting the console");
    // JSPI is detected HERE, in the worker that will run the code, and never inferred from a
    // browser's name: the answer is what `ready.jspi` reports and what the REPL uses to decide how
    // to enter Python. Its absence is not announced at startup - see `_freva_bridge.set_jspi`.
    const console_ = new Repl(pyodide, output, { jspi: supportsJspi() });
    repl = console_;
    await console_.start();

    // Registered for every profile that has fsspec, which is both of them. They load the same
    // scientific stack, and naming one would leave `xr.open_zarr("https://…")` failing with an
    // unknown-protocol error on `freva-client`. `minimal` is excluded on purpose: with no fsspec
    // loaded `install()` raises on import.
    if (PROFILE_PACKAGES[request.profile].includes("fsspec")) {
      output.status("loading", "registering the browser filesystem");
      repl.installBrowserHttp();
      // NOTHING is said here about JSPI. Stack switching is what lets a synchronous Zarr read call
      // an asynchronous fetch underneath, and without it everything else - local Python, NumPy,
      // xarray on local data, /workspace - works unchanged. A warning at every startup told the
      // people who never open a remote store about a problem they do not have, and told the ones
      // who do before they had done anything. The interpreter says it once, at the moment a
      // remote read actually needs it: see `_freva_bridge._needs_jspi`.
    }

    // CARTOPY'S DOWNLOADS, armed for EVERY profile that could plot, `minimal` included. Independent
    // of the fsspec branch and of the prepared add-on: a reader who draws a REGIONAL map gets 50m
    // or 10m selected by Cartopy whatever was prepared. Arming it costs one `sys.meta_path` entry
    // and imports nothing.
    {
      const cartopyData = repl.installCartopyData();
      if (cartopyData.startsWith("unavailable")) {
        output.stderr(
          "[browser-python] Cartopy's on-demand map data could not be armed " +
            `(${cartopyData}). Any prepared Natural Earth data still works; a map that needs a ` +
            "resolution this deployment did not prepare will report missing data.\n",
        );
      }
    }

    const info: BrowserPythonReadyInfo = {
      profile: request.profile,
      pythonVersion: repl.pythonVersion(),
      pyodideVersion: pyodide.version,
      packages: repl.resolveVersions(PROFILE_REPORTED[request.profile]),
      addons: describeAddons(prepared, (names) => console_.resolveVersions(names)),
      unavailableAddons: unavailable,
      startupMs: Date.now() - started,
      workspace: workspaceStatus,
      credentialsPersisted,
      jspi: supportsJspi(),
    };
    phase = "running";
    post({ kind: "ready", id: request.id, info });
  } catch (error) {
    const reason = error instanceof RuntimeError ? error.reason : undefined;
    post({
      kind: "fatal",
      id: request.id,
      message: describe(error),
      ...(reason !== undefined ? { reason } : {}),
    });
  }
}

function requireRepl(id: string): Repl | null {
  if (repl) return repl;
  post({ kind: "request-error", id, message: "The interpreter is not running." });
  return null;
}

/**
 * Diff the workspace after an execution, and never let that failure become the execution's: turning
 * a listing that throws into a failed execution would tell a visitor their correct code was wrong.
 */
function settleArtifacts(executionId?: string): void {
  try {
    watcher?.settle(executionId);
  } catch (error) {
    output.stderr(`[browser-python] could not list the workspace: ${describe(error)}\n`);
  }
}

/**
 * Refuse a message addressed to a different Worker instance. Never expected to fire - the engine
 * addresses by Worker reference - but the alternative is answering a dead transfer's lease request
 * with this workspace's bytes.
 */
function requireSession(request: { id: string; workerSession: string }): boolean {
  if (request.workerSession === workerSession) return true;
  post({
    kind: "request-error",
    id: request.id,
    message:
      `This request is addressed to worker session ${request.workerSession}, and this worker is ` +
      `${workerSession}. It belongs to an interpreter that has been replaced.`,
  });
  return false;
}

function requireWorkspace(id: string): Workspace | null {
  if (workspace) return workspace;
  post({
    kind: "request-error",
    id,
    message:
      workspaceStatus.detail ??
      "This browser cannot back Python file output with storage, so there are no artifacts.",
  });
  return null;
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  switch (request.kind) {
    case "init":
      enqueue(() => handleInit(request));
      return;

    case "push":
      enqueue(async () => {
        const active = requireRepl(request.id);
        if (!active) return;
        // Set BEFORE Python runs: stdout written during the execution has to carry this id, and
        // the console's callbacks fire synchronously from inside `push`.
        output.beginExecution(request.executionId);
        try {
          const result = await active.push(request.line);
          // AFTER the execution and BEFORE its reply: a console that renders the reply and then
          // hears about the file has already told the visitor the block finished with nothing in
          // it. Ordinary Python file output is detected here and nowhere else, by comparing the
          // workspace with what it held before.
          settleArtifacts(request.executionId);
          // Anything Python prints from here on belongs to no statement in particular.
          output.endExecution();
          post({
            kind: "push-reply",
            id: request.id,
            result: { executionId: request.executionId, ...result },
          });
        } catch (error) {
          output.endExecution();
          post({ kind: "request-error", id: request.id, message: describe(error) });
        }
      });
      return;

    case "run":
      enqueue(async () => {
        const active = requireRepl(request.id);
        if (!active) return;
        output.beginExecution(request.executionId);
        try {
          const result = await active.run(request.code);
          settleArtifacts(request.executionId);
          output.endExecution();
          post({
            kind: "run-reply",
            id: request.id,
            result: { executionId: request.executionId, ...result },
          });
        } catch (error) {
          output.endExecution();
          post({ kind: "request-error", id: request.id, message: describe(error) });
        }
      });
      return;

    case "complete":
      enqueue(async () => {
        const active = requireRepl(request.id);
        if (!active) return;
        try {
          post({
            kind: "completion",
            id: request.id,
            result: active.complete(request.source, request.cursor),
          });
        } catch (error) {
          post({ kind: "request-error", id: request.id, message: describe(error) });
        }
      });
      return;

    case "clear-buffer":
      enqueue(async () => {
        const active = requireRepl(request.id);
        if (!active) return;
        try {
          active.clearBuffer();
          post({ kind: "ack", id: request.id });
        } catch (error) {
          post({ kind: "request-error", id: request.id, message: describe(error) });
        }
      });
      return;

    // NOT ENQUEUED, and that is the entire point. The queue is serialised behind the execution this
    // is asking to end, so an interrupt that took its turn would run after it had finished. Safe to
    // jump because it runs none of the visitor's Python and awaits nothing. The reply is sent from
    // here, so a wedged queue cannot also wedge the answer.
    case "interrupt": {
      let requested = false;
      try {
        requested = repl?.interrupt() ?? false;
      } catch (error) {
        post({ kind: "request-error", id: request.id, message: describe(error) });
        return;
      }
      post({ kind: "interrupt-reply", id: request.id, requested });
      return;
    }

    case "artifact-list":
      enqueue(async () => {
        if (!requireWorkspace(request.id)) return;
        try {
          watcher?.settle(undefined, request.id);
        } catch (error) {
          // A request must always be answered. Listing walks live OPFS handles and can fail, and a
          // silent return leaves `await engine.artifacts()` pending forever.
          post({ kind: "request-error", id: request.id, message: describe(error) });
        }
      });
      return;

    case "artifact-read":
      enqueue(async () => {
        const active = requireWorkspace(request.id);
        if (!active) return;
        try {
          const data = await active.read(request.name, {
            ...(request.maxBytes !== undefined ? { maxBytes: request.maxBytes } : {}),
          });
          post({
            kind: "artifact-data",
            id: request.id,
            name: request.name,
            mime: data.mime,
            size: data.size,
            blob: data.blob,
            truncated: data.truncated,
          });
        } catch (error) {
          post({ kind: "request-error", id: request.id, message: describe(error) });
        }
      });
      return;

    case "artifact-open":
      enqueue(async () => {
        if (!requireSession(request)) return;
        const active = requireWorkspace(request.id);
        if (!active) return;
        try {
          const lease = active.openLease(request.name);
          post({ kind: "artifact-lease", id: request.id, workerSession, ...lease });
          // Announced, because a lease CHANGES the artifact: it goes from `ready` to
          // `transferring`, and while it is held Python cannot write, rename or delete it. A second
          // console sharing the engine would otherwise offer a Delete button that can only produce
          // an error.
          settleArtifacts();
        } catch (error) {
          post({ kind: "request-error", id: request.id, message: describe(error) });
        }
      });
      return;

    case "artifact-chunk":
      enqueue(async () => {
        if (!requireSession(request)) return;
        const active = requireWorkspace(request.id);
        if (!active) return;
        try {
          const bytes = active.readChunk(request.lease, request.offset, request.length);
          const size = active.leaseSize(request.lease);
          const generation = active.leaseGeneration(request.lease);
          // `bytes.buffer` is handed over in the transfer list, so this costs no copy - and the
          // worker's own view is neutered by the send, which is the property that keeps a
          // multi-gigabyte download from existing twice.
          post(
            {
              kind: "artifact-chunk-data",
              id: request.id,
              workerSession,
              lease: request.lease,
              offset: request.offset,
              bytes: bytes.buffer as ArrayBuffer,
              generation,
              eof: request.offset + bytes.byteLength >= size,
            },
            [bytes.buffer as ArrayBuffer],
          );
        } catch (error) {
          post({ kind: "request-error", id: request.id, message: describe(error) });
        }
      });
      return;

    case "artifact-close":
      enqueue(async () => {
        if (!requireSession(request)) return;
        // Deliberately NOT `requireWorkspace`: releasing a lease on a workspace that has gone away
        // is a no-op, not an error, and a cancel that rejects would leave the caller's cleanup path
        // reporting a failure it cannot act on.
        workspace?.closeLease(request.lease);
        // Back to `ready` (or gone). Same reason as opening: every console sharing this engine has
        // to see the same state.
        settleArtifacts();
        post({ kind: "ack", id: request.id });
      });
      return;

    case "artifact-delete":
      enqueue(async () => {
        const active = requireWorkspace(request.id);
        if (!active) return;
        try {
          active.delete(request.name);
          watcher?.settle(undefined, request.id);
        } catch (error) {
          // Covers both the delete itself and the listing that answers it - either way the request
          // gets a reply rather than a promise nobody ever settles.
          post({ kind: "request-error", id: request.id, message: describe(error) });
        }
      });
      return;

    case "dispose":
      enqueue(async () => {
        // Best effort. The main thread calls `terminate()` immediately after this, and that - not
        // this message - is what actually stops running Python. See `BrowserPython.restart`.
        repl?.destroy();
        repl = null;
        pyodide = null;
        // Releases the OPFS handles and removes this session's directory. Best effort: a worker
        // that is terminated instead leaves its directory behind, and the next session's stale
        // sweep - which tests the lock rather than a timestamp - reclaims it.
        const closing = workspace?.close();
        workspace = null;
        watcher = null;
        await closing;
        post({ kind: "ack", id: request.id });
      });
      return;
  }
};

// Announce liveness before `init` arrives, so a host can distinguish "the worker script failed to
// load" from "the runtime download is slow" while its own timeout is still running.
output.status("loading", "worker started");
