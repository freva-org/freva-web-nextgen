// Structured listing failures. A source that throws `new Error("HTTP 403")` leaves the component
// with two bad options: print the string, which tells a visitor nothing they can act on, or invent
// a message, which means guessing at semantics only the source knows. Neither is acceptable for the
// case that actually happens - a bucket that refuses anonymous listing looks identical to one that
// does not exist, and both look identical to a CORS policy that did not allow this page.
//
// So the source classifies and the component renders: what crosses is a code, a sentence written
// for a reader, whether repeating the request could plausibly help, and a detail bag for a
// developer that is carried and never shown. The brand is a property, not a class identity -
// `instanceof` across two bundles of this package fails quietly and turns every precise message
// back into "unknown error", where a property check cannot.

import type { DatasetTreeSourceError, DatasetTreeSourceErrorCode } from "./types.js";

/** Which codes describe a condition that could differ on the next attempt. */
const RETRYABLE: ReadonlySet<DatasetTreeSourceErrorCode> = new Set([
  "timeout",
  "network",
  "rate-limited",
  "server",
  "invalid-response",
]);

export function datasetTreeError(
  code: DatasetTreeSourceErrorCode,
  message: string,
  detail?: Readonly<Record<string, string | number | undefined>>,
): DatasetTreeSourceError {
  const error = new Error(message) as Error & {
    datasetTreeErrorCode: DatasetTreeSourceErrorCode;
    retryable: boolean;
    detail?: Readonly<Record<string, string | number | undefined>>;
  };
  error.name = "DatasetTreeSourceError";
  error.datasetTreeErrorCode = code;
  error.retryable = RETRYABLE.has(code);
  if (detail) error.detail = detail;
  return error;
}

export function isDatasetTreeError(value: unknown): value is DatasetTreeSourceError {
  if (typeof value !== "object" || value === null) return false;
  const code = (value as { datasetTreeErrorCode?: unknown }).datasetTreeErrorCode;
  return typeof code === "string";
}

/** The classification, or `unknown` for anything that did not come from a source that classifies. */
export function errorCodeOf(value: unknown): DatasetTreeSourceErrorCode {
  return isDatasetTreeError(value) ? value.datasetTreeErrorCode : "unknown";
}

/**
 * Whether the component should offer to try again. An unclassified failure is treated as retryable:
 * the component does not know what went wrong, and a control that lets the reader find out costs
 * less than a dead end that might have been a blip.
 */
export function isRetryable(value: unknown): boolean {
  return isDatasetTreeError(value) ? value.retryable : true;
}
