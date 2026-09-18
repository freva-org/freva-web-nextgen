// s3/errors.ts - one error type, with the distinctions the UI actually needs. "Could not list" is
// useless to someone standing in front of an empty directory: an empty bucket, one that refuses
// anonymous listing, one that does not exist, a blocked browser request, a rate-limiting gateway, a
// gateway that is down and an HTML error page are seven problems with seven fixes, and only the
// first is not a fault. Every message below says the ONE thing the reader can do where there is
// one; none carries a stack trace, a URL or a token, and the bucket and prefix stay on the error
// for a developer's console rather than being rendered.

import type { DatasetTreeSourceError, DatasetTreeSourceErrorCode } from "../types.js";

/** What went wrong, finely enough to say something true and act on it. */
export type S3FailureKind =
  // The CALLER abandoned the request - a collapsed branch, a destroyed tree. Separate from
  // `timeout`: both arrive as an aborted fetch and mean opposite things, a reader changing their
  // mind, which deserves no message at all, and an endpoint not answering, which deserves one and a
  // Retry.
  | "aborted"
  // The adapter's own deadline elapsed with no response.
  | "timeout"
  // 403. Anonymous listing is off, or the policy does not permit it. Usually a bucket policy.
  | "forbidden"
  // 404 / NoSuchBucket. The bucket or the endpoint is wrong.
  | "not-found"
  // A valid, complete listing for a prefix that contained nothing. S3 has no directories: a prefix
  // exists only while some key shares it, so a valid empty listing for a prefix somebody is looking
  // at is not "an empty folder" but a folder that stopped existing since the parent was listed.
  | "gone"
  // The request never produced a response: DNS, TLS, offline, or - often - CORS.
  | "network"
  // 429.
  | "rate-limited"
  // 5xx.
  | "server"
  // A response arrived and was not a ListObjectsV2 result.
  | "invalid-response"
  // Any other non-2xx status.
  | "http";

/**
 * One error object that satisfies both contracts: the adapter's own consumers catch `S3AccessError`
 * and read `kind`, `status`, `bucket` and `prefix`, the component reads `datasetTreeErrorCode`,
 * `retryable` and `message`, and converting between them on the way out would mean what reaches a
 * consumer's `catch` is not an `S3AccessError`. `message` IS the sentence a reader gets; there is
 * no separate "internal" message, because a second one would eventually reach the screen.
 */
export class S3AccessError extends Error implements DatasetTreeSourceError {
  readonly kind: S3FailureKind;
  readonly status?: number;
  readonly bucket?: string;
  readonly prefix?: string;
  /** The `<Code>` from an S3 `<Error>` document, when the body carried one. */
  readonly s3Code?: string;
  readonly datasetTreeErrorCode: DatasetTreeSourceErrorCode;
  readonly retryable: boolean;
  readonly detail: Readonly<Record<string, string | number | undefined>>;

  constructor(
    kind: S3FailureKind,
    detail: {
      status?: number;
      bucket?: string;
      prefix?: string;
      s3Code?: string;
      cause?: unknown;
    } = {},
  ) {
    super("");
    this.name = "S3AccessError";
    // Assigned rather than passed to `super`: the package targets ES2020, whose `Error` has no
    // options argument, and a `cause` is worth keeping for a consumer's logger either way.
    if (detail.cause !== undefined) (this as { cause?: unknown }).cause = detail.cause;
    this.kind = kind;
    if (detail.status !== undefined) this.status = detail.status;
    if (detail.bucket !== undefined) this.bucket = detail.bucket;
    if (detail.prefix !== undefined) this.prefix = detail.prefix;
    if (detail.s3Code !== undefined) this.s3Code = detail.s3Code;
    this.message = describeFailure(this);
    this.datasetTreeErrorCode = CODES[kind];
    this.retryable = RETRYABLE_KINDS.has(kind);
    this.detail = {
      bucket: detail.bucket,
      prefix: detail.prefix,
      status: detail.status,
      s3Code: detail.s3Code,
    };
  }
}

/**
 * Which kinds describe something a second attempt could get past. Not a 403 or a 404: the same
 * request will be refused or missing again, and a Retry beside them promises what it cannot do. Not
 * `gone` either - the fix there is to reload the PARENT, which the message says.
 */
const RETRYABLE_KINDS: ReadonlySet<S3FailureKind> = new Set([
  "timeout",
  "network",
  "rate-limited",
  "server",
  "invalid-response",
]);

/** How each kind maps onto the component's own vocabulary. */
const CODES: Record<S3FailureKind, DatasetTreeSourceErrorCode> = {
  aborted: "cancelled",
  timeout: "timeout",
  forbidden: "access-denied",
  "not-found": "not-found",
  gone: "gone",
  network: "network",
  "rate-limited": "rate-limited",
  server: "server",
  "invalid-response": "invalid-response",
  http: "unknown",
};

/**
 * The sentence a reader gets. The bucket name is quoted in the one case where it is the thing that
 * is wrong: a name missing at the configured endpoint is almost always a typo in a configuration
 * file, and showing which name was tried turns a support ticket into a one-line fix. The network
 * message says "may" because a browser reports a blocked cross-origin request and an unreachable
 * host as the same opaque failure, so it names both rather than presenting a guess at CORS.
 */
export function describeFailure(error: S3AccessError): string {
  switch (error.kind) {
    case "forbidden":
      return "Access denied - this bucket does not permit anonymous browser listing.";
    case "not-found":
      return `Bucket not found - “${error.bucket ?? "unknown"}” does not exist at the configured storage service.`;
    case "gone":
      return "This folder no longer exists. Reload its parent to refresh the listing.";
    case "timeout":
      return "Listing timed out. Check the connection and try again.";
    case "network":
      return "The browser could not reach this storage endpoint. It may be unavailable, or its CORS policy may not allow this portal.";
    case "rate-limited":
      return "The storage service is rate-limiting requests. Wait briefly and retry.";
    case "server":
      return `The storage service is temporarily unavailable (HTTP ${error.status ?? 500}).`;
    case "invalid-response":
      return "The endpoint returned an invalid S3 listing.";
    case "aborted":
      // Never rendered: the component drops `cancelled` before it reaches a message.
      return "The listing was cancelled.";
    default:
      return error.status
        ? `The storage service could not list this location (HTTP ${error.status}).`
        : "The storage service could not list this location.";
  }
}

/**
 * Classify a non-2xx response, preferring what the body says over what the status says. A gateway
 * in front of S3 can answer `404` for a bucket that exists and `403` for one that does not, while
 * the `<Error><Code>` came from the store itself - `NoSuchBucket` behind a 403 is still missing.
 */
export function classifyStatus(
  status: number,
  s3Code: string | null,
  /**
   * Whether the request was for a prefix INSIDE a bucket rather than for the bucket itself. It
   * separates "this bucket does not exist" - a configuration error somebody has to fix - from "this
   * folder no longer exists", an ordinary consequence of somebody else deleting objects while this
   * page was open, whose fix is to reload the parent. It never infers "gone" from an EMPTY listing:
   * S3 answers an empty prefix with a valid 200 and no entries exactly as it answers one that never
   * held anything, so only the store saying the location is not there is evidence that it is not.
   */
  inPrefix = false,
): S3FailureKind {
  // `gone` needs the store to say so; a bare 404 is not enough. Against real S3 a missing prefix
  // answers 200 with an empty listing, so a 404 for a prefix request is overwhelmingly a bucket
  // that does not exist, a configuration error that needs the bucket's name in the message. Only
  // `NoSuchKey`, emitted by the store about the location, is evidence that this particular location
  // has stopped existing.
  if (s3Code === "NoSuchKey") return inPrefix ? "gone" : "not-found";
  if (s3Code === "NoSuchBucket") return "not-found";
  if (s3Code === "AccessDenied" || s3Code === "AllAccessDisabled") return "forbidden";
  if (s3Code === "SlowDown" || s3Code === "TooManyRequests") return "rate-limited";
  if (status === 403) return "forbidden";
  if (status === 404) return "not-found";
  if (status === 429) return "rate-limited";
  if (status >= 500) return "server";
  return "http";
}
