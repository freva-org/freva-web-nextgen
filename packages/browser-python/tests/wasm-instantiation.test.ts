import { expect, it, vi } from "vitest";
import {
  MAX_SYNC_WASM_BYTES,
  useSyncInstantiationWhileLoading,
} from "../src/worker/wasm-instantiation.js";
import type { PyodideApi } from "../src/worker/pyodide-runtime.js";

/** A valid empty module: enough for `new WebAssembly.Module()` to succeed. */
const EMPTY = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);

/** The asynchronous call is a stub, so a delegated call is visible without compiling anything. */
function fixture(duringLoad: () => Promise<void> = async () => {}) {
  const native = vi.fn(async () => "delegated to the engine");
  const wasm = {
    Module: WebAssembly.Module,
    Instance: WebAssembly.Instance,
    instantiate: native,
  } as unknown as typeof WebAssembly;
  const load = vi.fn(async () => {
    await duringLoad();
    return [];
  });
  const runtime = {
    loadPackage: load,
    loadPackagesFromImports: load,
  } as unknown as PyodideApi;
  useSyncInstantiationWhileLoading(runtime, wasm);
  return { wasm, runtime, native };
}

it.each(["loadPackage", "loadPackagesFromImports"] as const)(
  "instantiates a side module without the asynchronous call while %s runs",
  async (method) => {
    let instantiated: WebAssembly.WebAssemblyInstantiatedSource | undefined;
    const { wasm, runtime, native } = fixture(async () => {
      instantiated = await wasm.instantiate(EMPTY, {});
    });
    await runtime[method]("cartopy");
    expect(instantiated?.module).toBeInstanceOf(WebAssembly.Module);
    expect(instantiated?.instance).toBeInstanceOf(WebAssembly.Instance);
    expect(native).not.toHaveBeenCalled();
  },
);

it("compiles a view's own bytes, offset and length included", async () => {
  const padded = new Uint8Array([255, ...EMPTY, 255]);
  let instantiated: WebAssembly.WebAssemblyInstantiatedSource | undefined;
  const { wasm, runtime } = fixture(async () => {
    instantiated = await wasm.instantiate(padded.subarray(1, 1 + EMPTY.length));
  });
  await runtime.loadPackage("numpy");
  expect(instantiated?.instance).toBeInstanceOf(WebAssembly.Instance);
});

it("reports a compile failure as a rejection rather than throwing, and never retries it", async () => {
  let outcome: unknown;
  const { wasm, runtime, native } = fixture(async () => {
    outcome = await wasm.instantiate(new Uint8Array([0, 0, 0, 0])).catch((error) => error);
  });
  await runtime.loadPackage("numpy");
  expect(outcome).toBeInstanceOf(WebAssembly.CompileError);
  expect(native).not.toHaveBeenCalled();
});

it("leaves a precompiled module, an oversized binary and compile options to the engine", async () => {
  const module = new WebAssembly.Module(EMPTY);
  const oversized = new Uint8Array(MAX_SYNC_WASM_BYTES + 1);
  const { wasm, runtime, native } = fixture(async () => {
    await wasm.instantiate(module);
    await wasm.instantiate(oversized);
    await (wasm.instantiate as (...args: unknown[]) => Promise<unknown>)(EMPTY, {}, {});
  });
  await runtime.loadPackage("numpy");
  const sources = native.mock.calls.map((call) => (call as unknown[])[0]);
  expect(sources).toHaveLength(3);
  // Identity, not deep equality: comparing 8 MB of zeroes element by element takes a minute.
  expect(sources[0]).toBe(module);
  expect(sources[1]).toBe(oversized);
  expect(sources[2]).toBe(EMPTY);
});

it("is in force only while a load is in flight, so bootstrap keeps its own path", async () => {
  const { wasm, runtime, native } = fixture();
  await wasm.instantiate(EMPTY);
  await runtime.loadPackage("numpy");
  await wasm.instantiate(EMPTY);
  expect(native).toHaveBeenCalledTimes(2);
});
