// s3/xml.ts - just enough of ListObjectsV2 to draw a directory, parsed by the platform's own
// `DOMParser`: hand-rolling an XML reader for untrusted input is a bad trade at any size, and
// pulling in a parser - or the AWS SDK - to read five element names is worse. This package has no
// runtime dependencies, and a read-only listing needs no signer, credential chain or middleware.

import { S3AccessError } from "./errors.js";

export interface S3Object {
  key: string;
  size: number | null;
  lastModified: string | null;
}

export interface S3ListingPage {
  /** `CommonPrefixes` - the sub-directories, given the `/` delimiter. */
  prefixes: string[];
  objects: S3Object[];
  isTruncated: boolean;
  nextToken: string | null;
}

function textOf(parent: Element, tag: string): string | null {
  const found = parent.getElementsByTagName(tag);
  const first = found.length > 0 ? found[0] : null;
  const value = first?.textContent;
  return typeof value === "string" && value.length > 0 ? value : null;
}

// Parse one ListObjectsV2 response body. `getElementsByTagName` rather than its namespaced sibling:
// every S3-compatible gateway declares the AWS namespace, several declare a different one, and a
// listing that fails to parse because a vendor chose their own URI is unfixable from the outside.
//
// @throws {S3AccessError} of kind `invalid-response` for anything that is not a listing.
/**
 * The `<Code>` from an S3 `<Error>` document, when the body is one. Forgiving by design: an error
 * body may be an HTML page from a proxy, a JSON blob, or nothing at all, and none should throw
 * while the caller is already handling a failure. `null` means "the status is all the evidence".
 */
export function errorCodeOf(text: string): string | null {
  if (typeof DOMParser === "undefined") return null;
  if (!/<Error[\s>]/i.test(text)) return null;
  try {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    if (doc.getElementsByTagName("parsererror").length > 0) return null;
    const code = doc.getElementsByTagName("Code")[0]?.textContent?.trim();
    return code && code.length > 0 ? code : null;
  } catch {
    return null;
  }
}

export function parseListObjectsV2(
  text: string,
  detail: { bucket?: string; prefix?: string } = {},
): S3ListingPage {
  if (typeof DOMParser === "undefined") {
    throw new S3AccessError("invalid-response", detail);
  }
  // A listing has no legitimate reason to carry a doctype, and refusing one keeps entity handling
  // off the table entirely rather than relying on the parser's defaults.
  if (/<!DOCTYPE/i.test(text.slice(0, 2048))) {
    throw new S3AccessError("invalid-response", detail);
  }

  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(text, "application/xml");
  } catch (cause) {
    throw new S3AccessError("invalid-response", { ...detail, cause });
  }

  if (doc.getElementsByTagName("parsererror").length > 0) {
    throw new S3AccessError("invalid-response", detail);
  }

  const root = doc.documentElement;
  if (!root || root.localName !== "ListBucketResult") {
    // An S3 <Error> body, an HTML error page from a proxy, or a JSON API answering the wrong URL.
    const code = root ? textOf(root, "Code") : null;
    // A 200 carrying an `<Error>` document, which some gateways do. The code is kept as a
    // diagnostic rather than put in the sentence: "AccessDenied" means nothing to a visitor, and
    // classifying a 200 body by status is the kind of guess that gives a confident wrong message.
    throw new S3AccessError("invalid-response", { ...detail, ...(code ? { s3Code: code } : {}) });
  }

  const prefixes: string[] = [];
  for (const element of Array.from(root.getElementsByTagName("CommonPrefixes"))) {
    const value = textOf(element, "Prefix");
    if (value !== null) prefixes.push(value);
  }

  const objects: S3Object[] = [];
  for (const element of Array.from(root.getElementsByTagName("Contents"))) {
    const key = textOf(element, "Key");
    if (key === null) continue;
    const rawSize = textOf(element, "Size");
    const size = rawSize === null ? null : Number.parseInt(rawSize, 10);
    objects.push({
      key,
      size: size !== null && Number.isFinite(size) && size >= 0 ? size : null,
      lastModified: textOf(element, "LastModified"),
    });
  }

  const truncated = textOf(root, "IsTruncated");
  return {
    prefixes,
    objects,
    isTruncated: truncated === "true",
    nextToken: textOf(root, "NextContinuationToken"),
  };
}
