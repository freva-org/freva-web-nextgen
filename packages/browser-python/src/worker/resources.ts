// resources.ts - the narrow adapter between the runtime and a resource sample. Every reader
// returns `undefined` rather than a guess: 0 is a real answer for some of these and an "unknown"
// for others.

import type { WorkerResourceSample } from "../protocol.js";

interface HeapHolder {
  _module?: { HEAPU8?: { buffer?: { byteLength?: unknown } } };
}

/**
 * The WebAssembly linear memory's CURRENT capacity: the heap buffer after any growth. It is what
 * the interpreter has reserved, not what Python objects use and not the tab's RSS.
 */
export function wasmCapacityBytes(runtime: unknown): number | undefined {
  try {
    const size = (runtime as HeapHolder | null)?._module?.HEAPU8?.buffer?.byteLength;
    return typeof size === "number" && Number.isSafeInteger(size) && size > 0 ? size : undefined;
  } catch {
    return undefined;
  }
}

interface ResourceEntry {
  transferSize?: number;
  decodedBodySize?: number;
}

/**
 * What this worker fetched, from Resource Timing. A cross-origin response without
 * `Timing-Allow-Origin` and a cache hit both report 0, so zeros are skipped and an all-zero sum is
 * reported as unknown. The two sums are kept apart: transfer is on the wire, decoded is in memory.
 */
export function fetchedBytes(
  perf: { getEntriesByType?(type: string): unknown[] } | undefined = globalThis.performance,
): Pick<WorkerResourceSample, "fetchedDecodedBytes" | "transferBytesEstimate"> {
  let decoded = 0;
  let transfer = 0;
  let entries: unknown[] = [];
  try {
    entries = perf?.getEntriesByType?.("resource") ?? [];
  } catch {
    return {};
  }
  for (const entry of entries as ResourceEntry[]) {
    if (typeof entry.decodedBodySize === "number" && entry.decodedBodySize > 0) {
      decoded += entry.decodedBodySize;
    }
    if (typeof entry.transferSize === "number" && entry.transferSize > 0) {
      transfer += entry.transferSize;
    }
  }
  return {
    ...(decoded > 0 ? { fetchedDecodedBytes: decoded } : {}),
    ...(transfer > 0 ? { transferBytesEstimate: transfer } : {}),
  };
}
