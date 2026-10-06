// Run at DKRZ, its decisions: the cell's imports are checked at DKRZ first (a missing module is
// said, with how to run the cell in the notebook's own Python, and the cell is never rewritten
// around it); a fix that ran is offered with its own output, for a new cell below; after the last
// failed attempt, it says it could not fix the cell.
import { describe, expect, it, vi } from "vitest";

import { ClimateClawApi } from "../src/api.js";
import { RunAndFixJobs } from "../src/runfix-jobs.js";
import { RunAtDkrzRunner } from "../src/runfix-runner.js";
import { importedModules, moduleCheckCode, type NbOutput } from "../src/runfix.js";
import { ThreadGate } from "../src/thread-gate.js";

const END = '{"variant":"StreamEnd","content":"Stream ended."}\n';
const v = (variant: string, content: unknown, id = "") =>
  `${JSON.stringify({ variant, content, ...(id ? { id } : {}) })}\n`;
const code = (id: string, source: string) => v("Code", JSON.stringify({ code: source }), id);
const out = (id: string, o: Record<string, unknown>) => v("CodeOutput", { error: "", ...o }, id);

/** A DKRZ that answers a run with the lines given (then, with `broken`, a failed read). */
function dkrz(
  lines: string[],
  options: { broken?: boolean; stopFails?: boolean; stopHangs?: boolean } = {},
) {
  const inputs: string[] = [];
  const stops: string[] = [];
  let threads = 0;
  const fetch = async (input: string, init: RequestInit = {}) => {
    const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
    if (input.endsWith("/newthread")) return Response.json(`T${++threads}`);
    if (input.endsWith("/stop") || input.includes("/stop?")) {
      stops.push(String(body.thread_id ?? input));
      if (options.stopFails) throw new TypeError("Failed to fetch");
      // A server that never answers (and a fetch that does not listen to its signal).
      if (options.stopHangs) return new Promise<Response>(() => undefined);
      return Response.json({});
    }
    inputs.push(String(body.input ?? ""));
    if (!options.broken) return new Response(lines.join(""));
    const bytes = new TextEncoder().encode(lines.join(""));
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(bytes);
          controller.error(new TypeError("network error"));
        },
      }),
    );
  };
  return { api: new ClimateClawApi("https://freva.example/api/chatbot", fetch), inputs, stops };
}

function run(
  lines: string[],
  source: string,
  options: Parameters<typeof dkrz>[1] & { stopConfirmMs?: number } = {},
) {
  const { api, inputs, stops } = dkrz(lines, options);
  const jobs = new RunAndFixJobs<object, object>();
  const cell: NbOutput[] = [];
  const said: Array<[string, ...unknown[]]> = [];
  const abandoned: string[] = [];
  const runner = new RunAtDkrzRunner<object, object>({
    api: () => api,
    gate: new ThreadGate(),
    jobs,
    sessionOf: (n) => n,
    threadOf: () => null,
    commitThread: () => undefined,
    abandon: (_notebook, thread) => void abandoned.push(thread),
    write: (_job, outputs) => void cell.push(...outputs),
    offer: (_job, fixed, verified, note, outputs) =>
      void said.push(["offer", fixed, verified, note, outputs]),
    missing: (_job, modules) => void said.push(["missing", modules]),
    gaveUp: (_job, reason, runs) => void said.push(["gaveUp", reason, runs]),
    changed: () => undefined,
    settleMs: 1,
    ...(options.stopConfirmMs !== undefined ? { stopConfirmMs: options.stopConfirmMs } : {}),
    retry: { attempts: 1, delayMs: 1 },
  });
  const notebook = {};
  const job = jobs.reserve({ notebook, cell: {} }, source)!;
  return {
    done: jobs.schedule(job, () => runner.run(job, "m")),
    /** Another cell of the same notebook, queued behind the first. */
    next: (code: string) => {
      const second = jobs.reserve({ notebook, cell: {} }, code)!;
      return { job: second, done: jobs.schedule(second, () => runner.run(second, "m")) };
    },
    job,
    cell,
    said,
    inputs,
    stops,
    abandoned,
  };
}

describe("Run at DKRZ", () => {
  const source = "import xarray as xr\nfrom healpix_geo import nested\nprint(1)";
  const check = moduleCheckCode(["xarray", "healpix_geo"]);

  it("checks the imports first; a module DKRZ lacks is said, and the cell is not rewritten", async () => {
    const r = run(
      [
        code("c", check),
        out("c", { stdout: "climateclaw-missing: healpix_geo\n" }),
        v("Assistant", "MISSING: healpix_geo"),
        END,
      ],
      source,
    );
    await r.done;
    expect(r.inputs[0]).toContain(check);
    expect(r.said).toEqual([["missing", ["healpix_geo"]]]);
    expect(r.job.state).toBe("failed");
    // The check's own output never reaches the cell.
    expect(JSON.stringify(r.cell)).not.toContain("climateclaw-missing");
  });

  it("a module the error names counts as missing too, when ClimateClaw did not say so", async () => {
    const r = run(
      [
        code("a", "import cartopy"),
        out("a", { error: "ModuleNotFoundError: No module named 'cartopy'" }),
        END,
      ],
      "import cartopy",
    );
    await r.done;
    expect(r.said).toEqual([["missing", ["cartopy"]]]);
  });

  it("a fix that ran is offered with its own output; the cell keeps the run as written", async () => {
    const r = run(
      [
        code("a", "1/0"),
        out("a", { error: "ZeroDivisionError: division by zero" }),
        code("b", "1/1"),
        out("b", { stdout: "1.0\n" }),
        v("Assistant", "Divided by 1 instead."),
        END,
      ],
      "1/0",
    );
    await r.done;
    expect(r.job.state).toBe("finished");
    const [kind, fixed, verified, note, outputs] = r.said[0]!;
    expect([kind, fixed, verified, note]).toEqual(["offer", "1/1", true, "Divided by 1 instead."]);
    expect(outputs).toEqual([{ output_type: "stream", name: "stdout", text: "1.0\n" }]);
    expect(r.cell.map((o) => o.output_type)).toEqual(["error", "display_data", "display_data"]);
    expect(JSON.stringify(r.cell)).not.toContain("1.0");
  });

  it("after the last failed attempt it says it could not fix the cell", async () => {
    const r = run(
      [
        code("a", "f()"),
        out("a", { error: "NameError: name 'f' is not defined" }),
        code("b", "g()"),
        out("b", { error: "NameError: name 'g' is not defined" }),
        code("d", "h()"),
        out("d", { error: "NameError: name 'h' is not defined" }),
        v("Assistant", "GAVE UP: nothing defines the function"),
        END,
      ],
      "f()",
    );
    await r.done;
    expect(r.said.find(([k]) => k === "gaveUp")).toEqual([
      "gaveUp",
      "nothing defines the function",
      3,
    ]);
    expect(r.job.state).toBe("failed");
  });

  it("a read that fails gives the thread up, even when the stop cannot be asked", async () => {
    const r = run([code("a", "print(1)")], "print(1)", { broken: true, stopFails: true });
    await r.done;
    expect(r.job.state).toBe("failed");
    expect(r.abandoned).toEqual(["T1"]);
  });

  it("a changed first run is not the cell's: its outputs go with the fix offered", async () => {
    const r = run(
      [
        code("a", "print(1.0)"),
        out("a", { stdout: "1.0\n" }),
        v("Assistant", "Printed a float."),
        END,
      ],
      "print(1)",
    );
    await r.done;
    const [kind, fixed, verified, , outputs] = r.said[0]!;
    expect([kind, fixed, verified]).toEqual(["offer", "print(1.0)", true]);
    expect(outputs).toEqual([{ output_type: "stream", name: "stdout", text: "1.0\n" }]);
    // The cell, as written, did not run: it gets a line saying so, not those outputs.
    expect(JSON.stringify(r.cell)).not.toContain('"1.0\\n"');
    expect(JSON.stringify(r.cell)).toContain("changed version");
  });

  it("a cell is never reported run when nothing ran (only the import check)", async () => {
    const check = moduleCheckCode(["xarray"]);
    const r = run(
      [
        code("c", check),
        out("c", { stdout: "climateclaw-missing: \n" }),
        v("Assistant", "Looks fine."),
        END,
      ],
      "import xarray",
    );
    await r.done;
    expect(r.job.state).toBe("failed");
    expect(r.said).toEqual([]);
    expect(JSON.stringify(r.cell)).toMatch(/without running the cell/);
  });

  const overLimit = [
    code("a", "f()"),
    out("a", { error: "NameError: f" }),
    code("b", "g()"),
    out("b", { error: "NameError: g" }),
    code("d", "h()"),
    out("d", { error: "NameError: h" }),
    code("e", "print('ok')"),
    out("e", { stdout: "ok\n" }),
    END,
  ];

  it("takes at most three runs: at a fourth it stops reading, asks DKRZ to stop, gives the session up", async () => {
    const r = run(overLimit, "f()");
    await r.done;
    expect(r.stops.length).toBeGreaterThanOrEqual(1);
    expect(r.abandoned).toEqual(["T1"]);
    expect(r.said.some(([kind]) => kind === "offer")).toBe(false);
    expect(r.said.find(([kind]) => kind === "gaveUp")?.[2]).toBe(3);
    const cell = JSON.stringify(r.cell);
    expect(cell).not.toMatch(/run 4/);
    expect(cell).not.toContain("ok\\n");
    expect(cell).toMatch(/beyond the 3 allowed: it is not used/);
    expect(cell).toMatch(/DKRZ took the request to stop that run/);
    expect(r.job.state).toBe("failed");
  });

  it("past the limit, a stop that fails is said as such, never as stopped", async () => {
    const r = run(overLimit, "f()", { stopFails: true });
    await r.done;
    const cell = JSON.stringify(r.cell);
    expect(cell).toMatch(/DKRZ did not take the request to stop that run.*may still be running/);
    expect(cell).not.toMatch(/took the request|it was stopped/);
    expect(r.abandoned).toEqual(["T1"]);
  });

  it("past the limit, an unanswered stop is waited for only so long, then said as such", async () => {
    const r = run(overLimit, "f()", { stopHangs: true, stopConfirmMs: 20 });
    await r.done;
    expect(JSON.stringify(r.cell)).toMatch(/DKRZ did not take the request to stop that run/);
    expect(r.abandoned).toEqual(["T1"]);
    expect(r.job.state).toBe("failed");
  });

  it("an unanswered stop never holds up the notebook's next cell: aborting the job ends the wait", async () => {
    const r = run(overLimit, "f()", { stopHangs: true, stopConfirmMs: 60_000 });
    const next = r.next("print(2)");
    // The first job is waiting on its stop; the second is queued behind it.
    await vi.waitFor(() => expect(r.stops.length).toBeGreaterThan(0));
    expect(next.job.state).toBe("queued");
    r.job.controller.abort();
    await r.done;
    expect(JSON.stringify(r.cell)).toMatch(/DKRZ did not take the request to stop that run/);
    expect(r.abandoned).toContain("T1");
    // Released: the next cell runs (and, answered the same, is ended the same way).
    await vi.waitFor(() => expect(r.inputs.length).toBe(2));
    next.job.controller.abort();
    await next.done;
  });

  it("a repair whose result never came is not a success", async () => {
    const r = run(
      [
        code("a", "1/0"),
        out("a", { error: "ZeroDivisionError: division by zero" }),
        code("b", "1/1"),
        END,
      ],
      "1/0",
    );
    await r.done;
    expect(r.job.state).toBe("failed");
    expect(JSON.stringify(r.cell)).toMatch(/last run \(run 2\) reported no result/);
    // Offered for a look only (not verified), with no outputs.
    expect(r.said).toEqual([["offer", "1/1", false, "", []]]);
  });
});

describe("the imports a cell needs", () => {
  it("only top-level imports, which run whatever happens; never those in strings or comments", () => {
    expect(importedModules('doc = """\nimport fake\n"""\nimport numpy  # import z')).toEqual([
      "numpy",
    ]);
    expect(importedModules("import os, healpy\nfrom xarray.core import utils")).toEqual([
      "healpy",
      "xarray",
    ]);
  });

  it("not conditional or lazy ones: a try and its fallback, a function, an if", () => {
    const cases = [
      "try:\n    import cartopy\nexcept ImportError:\n    cartopy = None",
      "try:\n    import cupy as xp\nexcept ModuleNotFoundError:\n    import numpy as xp",
      "try:\n    import cartopy\nexcept ValueError:\n    pass",
      "def plot():\n    import matplotlib.pyplot as plt\n    return plt",
      "class A:\n    import healpy",
      "if False:\n    import nothing_here",
    ];
    for (const source of cases)
      expect(importedModules(`${source}\nimport numpy`)).toEqual(["numpy"]);
  });
});
