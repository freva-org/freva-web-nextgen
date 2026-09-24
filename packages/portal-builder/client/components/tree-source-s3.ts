/**
 * The LIVE loader: one prefix of an S3-compatible gateway, listed when a row is expanded.
 *
 * DYNAMIC, so the client arrives on the first expansion rather than on page load, and NAMED ONLY
 * HERE, so a portal whose blocks are all snapshots does not contain this module and therefore
 * cannot contain the client.
 *
 * NO ListBuckets, ever. `createS3Source` answers `loadRoots` from the declared roots without a
 * request - not an optimisation: an S3 root legitimately returns 403, and a deployment's bucket
 * list is not something a browser gets to enumerate.
 *
 * Pagination, cancellation, bounded retries and per-row retryable errors are the adapter's and are
 * passed through: `maxPages` bounds a listing and reports when it cut one short, `context.signal`
 * cancels a listing whose row was collapsed, and a network or 5xx failure is retried a bounded
 * number of times and then surfaced on the row that asked for it.
 */

import type { S3Loader } from "./tree-sources.js";

export const loadS3Source: S3Loader = async (config, onTruncated) => {
  const { createS3Source } = await import("@freva-org/dataset-tree/s3");
  return createS3Source({
    endpoint: config.endpoint,
    roots: config.roots,
    style: config.style,
    ...(config.maxKeys !== undefined ? { maxKeys: config.maxKeys } : {}),
    ...(config.maxPages !== undefined ? { maxPages: config.maxPages } : {}),
    ...(config.requestTimeoutMs !== undefined ? { requestTimeoutMs: config.requestTimeoutMs } : {}),
    ...(config.retries !== undefined ? { retries: config.retries } : {}),
    ...(config.datasetSuffixes ? { datasetSuffixes: config.datasetSuffixes } : {}),
    onTruncated,
  });
};
