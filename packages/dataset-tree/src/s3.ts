// s3.ts - the public `@freva-org/dataset-tree/s3` entry. Opt-in, and separate for two reasons: a
// portal serving a build-time catalog must not ship an object-store client it never calls, and a
// portal that does select live mode is making a decision with consequences beyond the bundle - an
// outbound origin in its CSP, a CORS rule on the bucket, and a page whose contents now depend on a
// third party being up. Its own import keeps that decision visible in the code that made it.

export { createS3Source, type S3Root, type S3SourceOptions } from "./s3/source.js";
export { S3AccessError, describeFailure, type S3FailureKind } from "./s3/errors.js";
export { parseListObjectsV2, type S3ListingPage, type S3Object } from "./s3/xml.js";
