// The RST subprocess adapter.
//
// The helper is not "any process that speaks the protocol". The builder compares the whole
// handshake - protocol, helper package, helper version and the exact Docutils version the
// profile pins - and refuses to render otherwise, because a near-miss helper produces HTML
// that differs from the golden fixtures in ways nobody notices until a page looks wrong in
// production. The npm path never installs Python: it finds the helper or it stops.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import type { Diagnostic } from "../../diagnostics.js";
import { PACKAGE_ROOT } from "../../util/package.js";
import type { IrDocument } from "../ir.js";
import type { ContentProfile } from "../profile.js";

export interface RstHandshake {
  protocol: string;
  package: string;
  version: string;
  docutils: string;
}

export interface RstRenderResult {
  document?: IrDocument;
  diagnostics: Diagnostic[];
}

export class RstHelperError extends Error {
  constructor(
    message: string,
    readonly diagnostic: Diagnostic,
  ) {
    super(message);
    this.name = "RstHelperError";
  }
}

export interface Candidate {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

/**
 * Where the helper may come from. `FREVA_PORTAL_RST` is an exclusive pin; with no pin the
 * order is the canonical image's console script, the repository's bootstrapped virtual
 * environment, then the repository checkout run by whatever `python3` is on PATH. Nothing is
 * downloaded; `npm run bootstrap` creates the virtual environment.
 */
export function helperCandidates(): Candidate[] {
  const list: Candidate[] = [];

  // A pin is exclusive: silently falling back to a different interpreter tells the caller the
  // wrong thing about their build, and the handshake in the artifact would record the helper
  // that ran rather than the one that was asked for.
  const pinned = process.env.FREVA_PORTAL_RST;
  if (pinned) return [{ command: pinned, args: [] }];

  list.push({ command: "freva-portal-rst", args: [] });

  const toolRoot = join(PACKAGE_ROOT, "..", "..", "tools", "portal-rst-renderer");
  const repoHelper = join(toolRoot, "src");

  // The bootstrapped virtual environment, where a machine without a global Docutils 0.23 finds
  // the pinned one. Both layouts are listed because Windows puts the interpreter in `Scripts`.
  for (const dir of ["bin", "Scripts"]) {
    const script = join(
      toolRoot,
      ".venv",
      dir,
      dir === "bin" ? "freva-portal-rst" : "freva-portal-rst.exe",
    );
    if (existsSync(script)) list.push({ command: script, args: [] });
    const python = join(toolRoot, ".venv", dir, dir === "bin" ? "python3" : "python.exe");
    if (existsSync(python) && existsSync(repoHelper)) {
      list.push({
        command: python,
        args: ["-m", "freva_portal_rst"],
        env: { ...process.env, PYTHONPATH: repoHelper, PYTHONDONTWRITEBYTECODE: "1" },
      });
    }
  }

  if (existsSync(repoHelper)) {
    list.push({
      command: process.env.PYTHON ?? "python3",
      args: ["-m", "freva_portal_rst"],
      env: { ...process.env, PYTHONPATH: repoHelper, PYTHONDONTWRITEBYTECODE: "1" },
    });
  }
  return list;
}

/** How long the helper may take to identify itself before it is refused. */
const HANDSHAKE_TIMEOUT_MS = 20_000;
/** How long one document may take. A parser that hangs is a build that hangs. */
const RENDER_TIMEOUT_MS = 120_000;

export interface RstHelperOptions {
  /** Injectable so a test can prove the timeout path without waiting minutes. */
  renderTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  /**
   * Injectable so a test can drive a helper that misbehaves on purpose. A build
   * never sets it: the candidate list is the supported discovery order.
   */
  candidates?: Candidate[];
}

export class RstHelper {
  private child?: ChildProcessWithoutNullStreams;
  private lines?: Interface;
  private queue: Promise<unknown> = Promise.resolve();
  private exited?: Error;
  private readonly pending: ((error: Error) => void)[] = [];
  private readonly renderTimeoutMs: number;
  private readonly handshakeTimeoutMs: number;
  private readonly candidates: Candidate[] | undefined;
  handshake?: RstHandshake;

  constructor(
    private readonly profile: ContentProfile,
    options: RstHelperOptions = {},
  ) {
    this.renderTimeoutMs = options.renderTimeoutMs ?? RENDER_TIMEOUT_MS;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
    this.candidates = options.candidates;
  }

  /**
   * End this helper's life and fail everything waiting on it, whenever the protocol has been
   * broken - a timeout, or a line that is not a response. Rejecting only the one request and
   * leaving the process running is a correctness bug: the helper is line-delimited and
   * stateless, so a late answer to document one is indistinguishable from the answer to
   * document two, and a stream whose framing is lost cannot be resynchronized.
   */
  private poison(error: Error): void {
    this.exited ??= error;
    for (const reject of this.pending.splice(0)) reject(error);
    this.lines?.removeAllListeners("line");
    this.lines?.close();
    if (this.child) {
      this.child.removeAllListeners("exit");
      this.child.removeAllListeners("error");
      try {
        this.child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
    delete this.child;
    delete this.lines;
    delete this.handshake;
  }

  private async trySpawn(candidate: Candidate): Promise<RstHandshake> {
    const child = spawn(candidate.command, candidate.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: candidate.env ?? process.env,
    }) as ChildProcessWithoutNullStreams;

    const handshake = await new Promise<RstHandshake>((resolve, reject) => {
      const rl = createInterface({ input: child.stdout });
      let settled = false;
      // The timer is cleared on every exit from this promise. Left armed after a successful
      // handshake, it would kill a healthy helper twenty seconds into a long build.
      const timer = setTimeout(() => {
        finish(new Error(`the helper did not identify itself within ${this.handshakeTimeoutMs}ms`));
      }, this.handshakeTimeoutMs);

      const cleanup = (): void => {
        clearTimeout(timer);
        rl.close();
        child.off("error", onError);
        child.off("exit", onExit);
      };
      function finish(error: Error): void {
        if (settled) return;
        settled = true;
        cleanup();
        child.kill();
        reject(error);
      }
      const succeed = (value: RstHandshake): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const onError = (error: Error): void => finish(error);
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void =>
        finish(
          new Error(`the helper exited during the handshake (code ${code}, signal ${signal})`),
        );

      child.once("error", onError);
      child.once("exit", onExit);
      rl.once("line", (line: string) => {
        try {
          succeed(JSON.parse(line) as RstHandshake);
        } catch {
          finish(new Error(`the helper's first line was not a handshake: ${line.slice(0, 120)}`));
        }
      });
    });

    this.child = child;
    this.lines = createInterface({ input: child.stdout });
    // A helper that dies later must fail the requests in flight rather than leave a build
    // waiting for a line that will never arrive.
    const die = (error: Error): void => {
      this.exited = error;
      for (const reject of this.pending.splice(0)) reject(error);
    };
    child.once("exit", (code, signal) =>
      die(new Error(`the RST helper exited (code ${code}, signal ${signal})`)),
    );
    child.once("error", die);
    return handshake;
  }

  /** Start the helper and verify the complete handshake, or throw FP1701. */
  async start(): Promise<void> {
    if (this.handshake) return;
    const attempts: string[] = [];
    for (const candidate of this.candidates ?? helperCandidates()) {
      let handshake: RstHandshake;
      try {
        handshake = await this.trySpawn(candidate);
      } catch (err) {
        attempts.push(`${candidate.command}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const expected = {
        protocol: this.profile.rst.protocol,
        package: this.profile.rst.helper.package,
        version: this.profile.rst.helper.version,
        docutils: this.profile.rst.docutilsVersion,
      };
      const mismatch = (Object.keys(expected) as (keyof RstHandshake)[]).filter(
        (key) => handshake[key] !== expected[key],
      );
      if (mismatch.length > 0) {
        this.stop();
        throw new RstHelperError("RST helper handshake mismatch", {
          code: "FP1701",
          severity: "error",
          message:
            `The RST helper does not match portal-content-v1. Expected ` +
            mismatch.map((k) => `${k}=${expected[k]}`).join(", ") +
            `; got ` +
            mismatch.map((k) => `${k}=${handshake[k]}`).join(", ") +
            ".",
          hint: "Use the canonical builder image, or install tools/portal-rst-renderer with its pinned Docutils.",
        });
      }
      this.handshake = handshake;
      return;
    }
    throw new RstHelperError("RST helper unavailable", {
      code: "FP1701",
      severity: "error",
      message: `No RST helper could be started. Tried: ${attempts.join(" | ") || "no candidates"}.`,
      hint: "RST rendering requires the pinned freva-portal-rst helper. The builder never downloads Python during a build.",
    });
  }

  /** One document at a time: the protocol is line-delimited and stateless. */
  async render(source: string, name: string): Promise<RstRenderResult> {
    await this.start();
    const run = async (): Promise<RstRenderResult> => {
      if (this.exited) throw this.exited;
      const child = this.child;
      const lines = this.lines;
      if (!child || !lines) throw new Error("the RST helper is not running");
      const response = new Promise<RstRenderResult>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          // Poison, not just reject: a late line would be read as the *next* document's
          // response.
          this.poison(
            new Error(
              `the RST helper did not answer for '${name}' within ${this.renderTimeoutMs}ms and was terminated`,
            ),
          );
        }, this.renderTimeoutMs);

        const cleanup = (): void => {
          clearTimeout(timer);
          lines.off("line", onLine);
          const index = this.pending.indexOf(fail);
          if (index !== -1) this.pending.splice(index, 1);
        };
        function fail(error: Error): void {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        }
        const onLine = (line: string): void => {
          if (settled) return;
          settled = true;
          cleanup();
          try {
            const parsed = JSON.parse(line) as RstRenderResult;
            resolve({ ...parsed, diagnostics: parsed.diagnostics ?? [] });
          } catch (err) {
            // A line that is not a response means the framing is already lost.
            const error = err instanceof Error ? err : new Error(String(err));
            this.poison(
              new Error(
                `the RST helper sent a line that is not a response (${error.message}) and was terminated`,
              ),
            );
            reject(error);
          }
        };
        lines.on("line", onLine);
        // Registered so a helper crash rejects this request instead of leaving the build
        // waiting for a line that will never arrive.
        this.pending.push(fail);
      });
      child.stdin.write(`${JSON.stringify({ source, name, profile: this.profile })}\n`);
      return response;
    };

    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next as Promise<RstRenderResult>;
  }

  stop(): void {
    // A stopped helper stays stopped: a later render must fail immediately rather than attach
    // a listener to a closed stream and wait forever.
    this.exited ??= new Error("the RST helper has been stopped");
    for (const reject of this.pending.splice(0)) {
      reject(new Error("the RST helper was stopped while a request was in flight"));
    }
    this.lines?.close();
    if (this.child) {
      try {
        this.child.stdin.write(`${JSON.stringify({ op: "shutdown" })}\n`);
      } catch {
        // the helper already exited
      }
      this.child.kill();
    }
    delete this.child;
    delete this.lines;
  }
}
