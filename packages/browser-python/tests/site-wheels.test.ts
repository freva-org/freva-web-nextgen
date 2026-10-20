/**
 * Wheels a site pins itself: checked at construction, carried to the worker as absolute URLs with
 * their digests, and verified there before anything is installed.
 */

import { describe, expect, it, vi } from "vitest";
import { createBrowserPython } from "../src/browser-python.js";
import { describeFailure } from "../src/worker/startup-failure.js";
import { installSiteWheels, siteWheelFile } from "../src/worker/site-wheels.js";
import type { PyodideApi } from "../src/worker/pyodide-runtime.js";
import { healthyWorker } from "./fake-worker.js";

const WHEEL = "healpix_geo-2026.5.1-cp314-cp314-pyemscripten_2026_0_wasm32.whl";
const SHA = "a".repeat(64);

describe("siteWheels at construction", () => {
  it("refuses a digest that is not a SHA-256", () => {
    expect(() =>
      createBrowserPython({ siteWheels: [{ url: `https://x.org/${WHEEL}`, sha256: "abc" }] }),
    ).toThrow(/hex sha256/);
  });

  it("refuses a URL that does not name a wheel, or is not http(s)", () => {
    expect(() =>
      createBrowserPython({ siteWheels: [{ url: "https://x.org/healpix.zip", sha256: SHA }] }),
    ).toThrow(/wheel file name/);
    expect(() =>
      createBrowserPython({ siteWheels: [{ url: `data:text/plain,${WHEEL}`, sha256: SHA }] }),
    ).toThrow(/http\(s\) url/);
  });

  it("sends absolute URLs and lowercase digests in `init`, and nothing when unset", async () => {
    const worker = healthyWorker();
    const engine = createBrowserPython({
      workerFactory: () => worker as unknown as Worker,
      siteWheels: [{ url: `https://x.org/wheels/${WHEEL}`, sha256: SHA.toUpperCase() }],
    });
    await engine.start();
    const init = worker.sent.find((m) => m.kind === "init") as { siteWheels?: unknown };
    expect(init.siteWheels).toEqual([{ url: `https://x.org/wheels/${WHEEL}`, sha256: SHA }]);
    engine.dispose();

    const plain = healthyWorker();
    const other = createBrowserPython({ workerFactory: () => plain as unknown as Worker });
    await other.start();
    expect("siteWheels" in (plain.sent.find((m) => m.kind === "init") as object)).toBe(false);
    other.dispose();
  });
});

describe("installSiteWheels in the worker", () => {
  const bytes = new TextEncoder().encode("wheel bytes");
  async function digest(data: Uint8Array<ArrayBuffer>): Promise<string> {
    const out = await crypto.subtle.digest("SHA-256", data);
    return [...new Uint8Array(out)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  function fakePyodide() {
    const files = new Map<string, Uint8Array>();
    const ran: string[] = [];
    const api = {
      FS: {
        mkdirTree: () => undefined,
        writeFile: (path: string, data: Uint8Array) => files.set(path, data),
      },
      runPythonAsync: async (code: string) => {
        ran.push(code);
      },
    } as unknown as PyodideApi;
    return { api, files, ran };
  }

  it("installs verified bytes from the filesystem, with deps=False", async () => {
    const sha256 = await digest(bytes);
    const fetchMock = vi.fn(async () => new Response(bytes));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const py = fakePyodide();
      const installed = await installSiteWheels(py.api, [
        { url: `https://x.org/${WHEEL}`, sha256 },
      ]);
      expect(installed).toEqual([WHEEL]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(py.files.get(`/freva-site-wheels/${WHEEL}`)).toEqual(bytes);
      expect(py.ran[0]).toContain(`emfs:/freva-site-wheels/${WHEEL}`);
      expect(py.ran[0]).toContain("deps=False");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("installs nothing when any wheel is missing or altered, and says which", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("missing") ? new Response("", { status: 404 }) : new Response(bytes),
      ),
    );
    try {
      const py = fakePyodide();
      const run = installSiteWheels(py.api, [
        { url: `https://x.org/${WHEEL}`, sha256: SHA },
        { url: `https://x.org/missing/marray-0.0.12-py3-none-any.whl`, sha256: SHA },
      ]);
      await expect(run).rejects.toThrow(/not the artefact this build pinned/);
      await expect(run).rejects.toThrow(/HTTP 404/);
      expect(py.files.size).toBe(0);
      expect(py.ran).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("names the wheel and the setting in its failure", () => {
    const text = describeFailure({
      resource: "site-wheel",
      artefact: WHEEL,
      url: `https://x.org/${WHEEL}`,
      kind: "unavailable",
      status: 404,
    });
    expect(text).toContain("A wheel this site pins");
    expect(text).toContain("siteWheels");
    expect(siteWheelFile(`https://x.org/a%2Bb/${WHEEL}`)).toBe(WHEEL);
  });
});
