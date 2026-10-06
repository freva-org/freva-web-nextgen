// Resource telemetry as a status line. Only what was measured is shown, under its real name:
// WASM capacity is not memory use, and a field the browser does not report is left out.

import type { SessionResources } from "../types.js";

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

/** e.g. `WASM 312.0 MiB · files 4.2 MiB · fetched 48.1 MiB · 1/2 live`. */
export function describeResources(
  sample: SessionResources & { live?: number; capacity?: number },
): string {
  const parts: string[] = [];
  if (sample.wasmCapacityBytes !== undefined)
    parts.push(`WASM ${formatBytes(sample.wasmCapacityBytes)}`);
  if (sample.workspaceBytes !== undefined)
    parts.push(`files ${formatBytes(sample.workspaceBytes)}`);
  if (sample.outputRetainedBytes !== undefined)
    parts.push(`output ${formatBytes(sample.outputRetainedBytes)}`);
  if (sample.fetchedDecodedBytes !== undefined)
    parts.push(`fetched ${formatBytes(sample.fetchedDecodedBytes)}`);
  if (sample.timeToUsableMs !== undefined)
    parts.push(`ready in ${(sample.timeToUsableMs / 1000).toFixed(1)} s`);
  if (sample.live !== undefined && sample.capacity !== undefined)
    parts.push(`${sample.live}/${sample.capacity} live`);
  if (sample.sampleStale) parts.push("busy, last sample");
  return parts.join(" · ");
}
