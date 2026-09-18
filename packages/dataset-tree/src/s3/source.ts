// s3/source.ts - a read-only, unauthenticated ListObjectsV2 adapter: it lists public buckets from a
// browser, signs nothing and stores nothing. There is deliberately no credential, header or
// middleware option, because the moment one exists a secret goes through it. A deployment needing
// authenticated listing puts a service in front of the bucket and writes a source against the same
// interface.

import type {
  DatasetTreeDetailField,
  DatasetTreeLoadContext,
  DatasetTreeNode,
  DatasetTreeSource,
} from "../types.js";
import { S3AccessError, classifyStatus } from "./errors.js";
import { errorCodeOf, parseListObjectsV2 } from "./xml.js";

/** One browsable starting point. Roots are declared, never discovered. */
export interface S3Root {
  // Node id. Defaults to `s3://bucket/prefix`, which is already stable and unique.
  id?: string;
  /** Row label. */
  name: string;
  bucket: string;
  // Key prefix to start at. Must end with `/` when non-empty.
  prefix?: string;
  title?: string;
  description?: string;
  // A project or documentation page for this collection, rendered as a small external-link control
  // beside the title. Carrying it here rather than inventing one from the bucket name keeps a click
  // on a collection from ever navigating to a raw storage URL.
  link?: { href: string; label?: string };
  // Announced but not yet browsable. Makes the root a `planned` node: a badge with this text, no
  // chevron, no `aria-expanded`, and no listing request on expansion or on the availability probe.
  // A deployment that knows a bucket is not filled yet says so here instead of paying a request.
  planned?: string;
}

export interface S3SourceOptions {
  /** Absolute `https:` (or `http:`) URL of the S3-compatible gateway. No credentials, no query. */
  endpoint: string;
  /** The buckets this tree may browse. Required: there is no discovery step. */
  roots: readonly S3Root[];
  // `path` puts the bucket in the path; `virtual-host` puts it in the hostname. Default `path`,
  // because it is what self-hosted gateways serve and it does not need a wildcard certificate.
  style?: "path" | "virtual-host";
  // Injected `fetch`. Defaults to the global one. Never a polyfill: this package ships none.
  fetch?: typeof globalThis.fetch;
  // Keys per request. Default 1000, the protocol maximum.
  maxKeys?: number;
  // Continuation pages per expansion. Default 25 - twenty-five thousand entries, past which a tree
  // is the wrong tool. Reaching it stops the walk and calls {@link S3SourceOptions.onTruncated}.
  maxPages?: number;
  // Per-request timeout. Default 20000 ms.
  requestTimeoutMs?: number;
  // Retries for network errors and 5xx only. Default 1 (so two attempts total). Never unbounded.
  retries?: number;
  // Delay before a retry. Default 250 ms.
  retryDelayMs?: number;
  // Object name suffixes that mark a chunked store rather than a plain file - a `.zarr` directory
  // is one dataset, not a thousand files. Matched case-insensitively against the last path segment.
  datasetSuffixes?: readonly string[];
  // Called when `maxPages` cut a listing short.
  onTruncated?: (info: { bucket: string; prefix: string; pages: number }) => void;
  // The two field labels this adapter publishes on a directory, for a deployment that is not in
  // English. Everything else the tree prints comes from the component's own `labels`; these are
  // here because they label DATA this adapter produces, and hardcoding two English words would be a
  // translation hole nobody could reach from outside.
  fieldLabels?: { bucket?: string; prefix?: string };
}

const DEFAULTS = {
  style: "path" as const,
  maxKeys: 1000,
  maxPages: 25,
  requestTimeoutMs: 20_000,
  retries: 1,
  retryDelayMs: 250,
  datasetSuffixes: [".zarr"] as readonly string[],
  fieldLabels: { bucket: "Bucket", prefix: "Prefix" },
};

/**
 * Bucket naming, per the S3 rules that matter here: 3-63 characters, lowercase alphanumerics with
 * dots and hyphens, starting and ending alphanumeric.
 */
const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

function assertEndpoint(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError(`createS3Source: \`endpoint\` is not a URL: ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError(`createS3Source: \`endpoint\` must be http(s), got ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new TypeError("createS3Source: `endpoint` must not carry credentials");
  }
  if (url.search || url.hash) {
    throw new TypeError("createS3Source: `endpoint` must not carry a query string or fragment");
  }
  return url;
}

function assertBucket(bucket: unknown, style: "path" | "virtual-host"): string {
  if (typeof bucket !== "string" || !BUCKET_RE.test(bucket)) {
    throw new TypeError(`createS3Source: invalid bucket name ${JSON.stringify(bucket)}`);
  }
  if (bucket.includes("..")) {
    throw new TypeError(`createS3Source: invalid bucket name ${JSON.stringify(bucket)}`);
  }
  if (IPV4_RE.test(bucket)) {
    throw new TypeError("createS3Source: a bucket name must not look like an IPv4 address");
  }
  if (style === "virtual-host" && bucket.includes(".")) {
    // A dotted bucket under virtual-host style needs a multi-level wildcard certificate, which is
    // not a thing; the request would fail TLS validation in a way that reads as "network error".
    throw new TypeError(
      `createS3Source: bucket ${JSON.stringify(bucket)} contains a dot and cannot be used with virtual-host style`,
    );
  }
  return bucket;
}

function normalizePrefix(prefix: unknown, where: string): string {
  if (prefix === undefined || prefix === null || prefix === "") return "";
  if (typeof prefix !== "string") throw new TypeError(`createS3Source: ${where} must be a string`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(prefix)) {
    throw new TypeError(`createS3Source: ${where} contains control characters`);
  }
  if (prefix.startsWith("/")) throw new TypeError(`createS3Source: ${where} must not start with /`);
  if (prefix.split("/").some((segment) => segment === "..")) {
    throw new TypeError(`createS3Source: ${where} must not contain a .. segment`);
  }
  return prefix.endsWith("/") ? prefix : `${prefix}/`;
}

/** The last non-empty path segment of a key or prefix. */
function lastSegment(value: string): string {
  const parts = value.split("/").filter((part) => part.length > 0);
  return parts.length > 0 ? parts[parts.length - 1] : value;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A {@link DatasetTreeSource} backed by anonymous ListObjectsV2 requests. Requires the bucket to
 * permit anonymous `s3:ListBucket` **and** to answer browser preflight with CORS headers allowing
 * the portal's origin; neither is on by default in any implementation, and a missing CORS rule
 * surfaces as a `network` failure because that is all a browser is told.
 */
export function createS3Source(options: S3SourceOptions): DatasetTreeSource {
  if (!options || typeof options !== "object") {
    throw new TypeError("createS3Source: options are required");
  }
  const style = options.style ?? DEFAULTS.style;
  const endpoint = assertEndpoint(options.endpoint);
  if (!Array.isArray(options.roots) || options.roots.length === 0) {
    throw new TypeError("createS3Source: `roots` must list at least one bucket");
  }

  const doFetch = options.fetch ?? globalThis.fetch;
  if (typeof doFetch !== "function") {
    throw new TypeError("createS3Source: no fetch implementation available; pass `options.fetch`");
  }

  const maxKeys = Math.min(Math.max(1, Math.trunc(options.maxKeys ?? DEFAULTS.maxKeys)), 1000);
  const maxPages = Math.max(1, Math.trunc(options.maxPages ?? DEFAULTS.maxPages));
  const timeoutMs = Math.max(1, Math.trunc(options.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs));
  const retries = Math.max(0, Math.min(5, Math.trunc(options.retries ?? DEFAULTS.retries)));
  const retryDelayMs = Math.max(0, Math.trunc(options.retryDelayMs ?? DEFAULTS.retryDelayMs));
  const datasetSuffixes = (options.datasetSuffixes ?? DEFAULTS.datasetSuffixes).map((suffix) =>
    suffix.toLowerCase(),
  );
  const fieldLabels = {
    bucket: options.fieldLabels?.bucket ?? DEFAULTS.fieldLabels.bucket,
    prefix: options.fieldLabels?.prefix ?? DEFAULTS.fieldLabels.prefix,
  };

  /** Validated once at construction: a bad root should fail at wiring time, not on first click. */
  const roots = options.roots.map((root, i) => {
    if (!root || typeof root.name !== "string" || root.name.length === 0) {
      throw new TypeError(`createS3Source: roots[${i}].name is required`);
    }
    const bucket = assertBucket(root.bucket, style);
    const prefix = normalizePrefix(root.prefix, `roots[${i}].prefix`);
    return { ...root, bucket, prefix };
  });

  /** `s3://bucket/key` - unique by construction, and the same string on every build. */
  const idFor = (bucket: string, key: string): string => `s3://${bucket}/${key}`;

  const locationOf = new Map<string, { bucket: string; prefix: string }>();
  for (const root of roots) {
    locationOf.set(root.id ?? idFor(root.bucket, root.prefix), {
      bucket: root.bucket,
      prefix: root.prefix,
    });
  }

  function listingUrl(bucket: string, prefix: string, token: string | null): string {
    const url = new URL(endpoint.toString());
    if (style === "virtual-host") {
      url.hostname = `${bucket}.${url.hostname}`;
    } else {
      const base = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
      url.pathname = `${base}/${bucket}`;
    }
    // No request shape in this adapter omits a bucket, so ListBuckets cannot be issued by accident.
    url.searchParams.set("list-type", "2");
    url.searchParams.set("delimiter", "/");
    url.searchParams.set("max-keys", String(maxKeys));
    if (prefix) url.searchParams.set("prefix", prefix);
    if (token) url.searchParams.set("continuation-token", token);
    return url.toString();
  }

  /**
   * The plain HTTPS URL of one key or store prefix, for an inspector to open: the same host, style
   * and bucket placement the listing uses, with no query, because a store is read by fetching
   * `.zarr/.zmetadata` and chunks under this URL, not by listing it. Built here because this
   * adapter alone knows the endpoint and the addressing style. Segments are encoded one at a time:
   * `/` stays a separator, everything else that needs escaping is escaped.
   */
  function objectUrl(bucket: string, key: string): string {
    const url = new URL(endpoint.toString());
    const base = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
    const path = key.split("/").map(encodeURIComponent).join("/");
    if (style === "virtual-host") {
      url.hostname = `${bucket}.${url.hostname}`;
      url.pathname = `${base}/${path}`;
    } else {
      url.pathname = `${base}/${bucket}/${path}`;
    }
    return url.toString();
  }

  /**
   * The availability probe's URL: the same bucket, one key, and nothing else. A separate builder
   * because the two requests ask different questions and because this one must never grow a
   * continuation token - it is one request, forever.
   */
  function probeUrl(bucket: string, prefix: string): string {
    const url = new URL(listingUrl(bucket, prefix, null));
    url.searchParams.set("max-keys", "1");
    return url.toString();
  }

  /** One request, with a timeout of its own that is also cancelled by the caller's signal. */
  async function request(
    url: string,
    bucket: string,
    prefix: string,
    outer: AbortSignal,
  ): Promise<string> {
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    if (outer.aborted) controller.abort();
    else outer.addEventListener("abort", onAbort, { once: true });
    // Whose abort it was, recorded before either can happen. A caller collapsing a branch and this
    // adapter's own deadline both surface as one indistinguishable `AbortError`, and they mean
    // opposite things: the first deserves no message at all, the second one with a Retry beside it.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    // Which of the three a failed request was, wherever in the request it failed. The caller's
    // signal wins when both fired: they asked first, and they asked deliberately.
    const classify = (cause: unknown): S3AccessError => {
      if (outer.aborted) return new S3AccessError("aborted", { bucket, prefix, cause });
      if (timedOut) return new S3AccessError("timeout", { bucket, prefix, cause });
      return new S3AccessError("network", { bucket, prefix, cause });
    };

    try {
      let response: Response;
      try {
        response = await doFetch(url, {
          method: "GET",
          signal: controller.signal,
          credentials: "omit",
          redirect: "follow",
          headers: { Accept: "application/xml,text/xml;q=0.9,*/*;q=0.1" },
        });
      } catch (cause) {
        throw classify(cause);
      }

      if (!response.ok) {
        // The body is read before the status is trusted: a gateway can answer 403 for a bucket that
        // does not exist and 404 for one that refuses listing, while the `<Error><Code>` in the
        // body came from the store itself. Read defensively - an HTML error page has no code, and a
        // body that cannot be read leaves the status as the only evidence.
        let s3Code: string | null = null;
        try {
          s3Code = errorCodeOf(await response.text());
        } catch {
          // an unreadable error body is still an error with a status
        }
        const kind = classifyStatus(response.status, s3Code, prefix.length > 0);
        throw new S3AccessError(kind, {
          status: response.status,
          bucket,
          prefix,
          ...(s3Code ? { s3Code } : {}),
        });
      }
      // The deadline outlives the headers: a 200 whose body never finishes aborts here, not in the
      // fetch above, and an `AbortError` leaving unclassified is neither retried nor explained,
      // because `requestWithRetry` only retries an `S3AccessError`.
      try {
        return await response.text();
      } catch (cause) {
        throw classify(cause);
      }
    } finally {
      clearTimeout(timer);
      outer.removeEventListener("abort", onAbort);
    }
  }

  /** Retry only what retrying can fix, and only a fixed number of times. */
  async function requestWithRetry(
    url: string,
    bucket: string,
    prefix: string,
    signal: AbortSignal,
  ): Promise<string> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await request(url, bucket, prefix, signal);
      } catch (error) {
        lastError = error;
        // Retried here: only what a second attempt a quarter-second later can fix. Not a 403 or a
        // 404 - those are configuration, and hammering them turns one clear message into four
        // identical ones - and not a caller abort. A rate limit IS retried: a gateway that said
        // "slow down" often means exactly that.
        const retryable =
          error instanceof S3AccessError &&
          (error.kind === "network" ||
            error.kind === "timeout" ||
            error.kind === "server" ||
            error.kind === "rate-limited");
        if (!retryable || attempt === retries || signal.aborted) break;
        await sleep(retryDelayMs);
        if (signal.aborted) break;
      }
    }
    throw lastError;
  }

  /**
   * What a listed name IS, decided by the name rather than by which half of the listing it came in.
   * A gateway that serves symlinked directories - and some do, for whole collections - returns the
   * link as a `Contents` OBJECT with `Size` set to the link target's byte length, not as a
   * `CommonPrefix`, so classifying by the element that carried the key would turn a whole archive
   * of Zarr stores into 51-byte files. S3 cannot say "symlink", so the name is the only evidence: a
   * name ending in a dataset suffix is a STORE wherever it was listed, since a store is opened by
   * fetching `.zmetadata` and chunks under its URL rather than by listing; a name with no extension
   * at all is a DIRECTORY, whose listing is the source of truth because the gateway resolves the
   * link and answers with the target's contents or answers empty; a name with a real file extension
   * stays a FILE. The middle rule costs an extension-less ordinary file - a `LICENSE`, a `README` -
   * drawn as a directory that opens to nothing, which is recoverable where an unbrowsable archive
   * is not.
   */
  function classify(name: string, isPrefix: boolean): "dataset" | "directory" | "file" {
    const lowered = name.toLowerCase();
    if (datasetSuffixes.some((suffix) => lowered.endsWith(suffix))) return "dataset";
    if (isPrefix) return "directory";
    return /\.[^./]+$/.test(name) ? "file" : "directory";
  }

  function toNode(
    bucket: string,
    key: string,
    isPrefix: boolean,
    object?: { size: number | null; lastModified: string | null },
  ): DatasetTreeNode | null {
    const name = lastSegment(key);
    if (name.length === 0) return null;
    const kind = classify(name, isPrefix);

    if (kind !== "file") {
      // A directory's own prefix always ends in `/`; an object key that turned out to be one does
      // not, and listing it without the separator would match every sibling sharing its name.
      const prefix = kind === "directory" && !key.endsWith("/") ? `${key}/` : key;
      const node: DatasetTreeNode = {
        id: idFor(bucket, prefix),
        kind: kind === "dataset" ? "dataset" : "directory",
        name,
        path: `s3://${bucket}/${prefix}`,
        hasChildren: kind === "directory",
      };
      // A store, and only a store, is inspectable. Setting it here rather than leaving consumers to
      // derive a URL from the `s3://` path makes the inspect control appear for every real store in
      // every catalogue, not only where a consumer reimplemented the endpoint's addressing rules.
      // The key goes in exactly as it was listed - with the trailing slash a prefix carries, and
      // without one for a symlinked store listed as an object - because an inspector strips a
      // trailing slash before joining `.zmetadata` onto it and both forms address the same store.
      // A directory instead publishes where it actually is as fields, saving a reader from
      // reassembling the bucket and key out of the shape of the tree; the component's rule that a
      // branch gets an info control when its source published something the row does not already
      // show turns them into a panel.
      // A store needs none: its panel already carries the address, the recipe and the inspect
      // control.
      if (kind === "directory") {
        (node as { details?: DatasetTreeDetailField[] }).details = [
          { label: fieldLabels.bucket, values: [{ text: bucket }] },
          { label: fieldLabels.prefix, values: [{ text: prefix }] },
        ];
      }
      if (kind === "dataset") {
        (node as { inspect?: string }).inspect = objectUrl(bucket, key);
        // A symlinked store carries the link's own byte length as its `Size`, and 51 bytes is not
        // the size of a pyramid level. Nothing here reports a size it cannot stand behind.
      }
      return node;
    }

    const node: DatasetTreeNode = {
      id: idFor(bucket, key),
      kind: "file",
      name,
      path: `s3://${bucket}/${key}`,
      hasChildren: false,
    };
    if (object?.size !== null && object?.size !== undefined) {
      (node as { size?: number }).size = object.size;
    }
    if (object?.lastModified) (node as { modifiedAt?: string }).modifiedAt = object.lastModified;
    return node;
  }

  async function list(
    bucket: string,
    prefix: string,
    context: DatasetTreeLoadContext,
  ): Promise<readonly DatasetTreeNode[]> {
    const signal = context.signal;
    const directories: DatasetTreeNode[] = [];
    const files: DatasetTreeNode[] = [];
    let token: string | null = null;
    let pages = 0;

    do {
      if (signal.aborted) throw new S3AccessError("aborted", { bucket, prefix });
      const body = await requestWithRetry(
        listingUrl(bucket, prefix, token),
        bucket,
        prefix,
        signal,
      );
      const page = parseListObjectsV2(body, { bucket, prefix });
      pages += 1;

      for (const commonPrefix of page.prefixes) {
        const node = toNode(bucket, commonPrefix, true);
        if (node) directories.push(node);
      }
      for (const object of page.objects) {
        // The zero-byte marker some tools write for a "directory" is not a file the user can open.
        if (object.key === prefix || object.key.endsWith("/")) continue;
        const node = toNode(bucket, object.key, false, object);
        if (node) files.push(node);
      }

      token = page.isTruncated ? page.nextToken : null;
      if (token && pages >= maxPages) {
        options.onTruncated?.({ bucket, prefix, pages });
        break;
      }
    } while (token);

    // Directories first, then files, each by name: the same order on every listing, whatever order
    // the gateway happened to paginate them in.
    const byName = (a: DatasetTreeNode, b: DatasetTreeNode): number => a.name.localeCompare(b.name);
    directories.sort(byName);
    files.sort(byName);
    return [...directories, ...files];
  }

  return {
    /** No request at all: the roots are what the deployment declared. */
    loadRoots(context) {
      if (context?.signal?.aborted) {
        return Promise.reject(new S3AccessError("aborted"));
      }
      return Promise.resolve(
        roots.map((root) => {
          const planned = typeof root.planned === "string" && root.planned.length > 0;
          const node: DatasetTreeNode = {
            id: root.id ?? idFor(root.bucket, root.prefix),
            kind: "collection",
            name: root.name,
            path: `s3://${root.bucket}/${root.prefix}`,
            // A planned collection is not expandable, and says so in the model rather than being
            // made unexpandable by a later probe - there is no window in which it looks openable.
            hasChildren: !planned,
          };
          // A root says where it is too: its bucket is the collection's name as the storage knows
          // it, rarely the name the deployment displays, and the same rule gives the same control.
          (node as { details?: DatasetTreeDetailField[] }).details = [
            { label: fieldLabels.bucket, values: [{ text: root.bucket }] },
            ...(root.prefix
              ? [{ label: fieldLabels.prefix, values: [{ text: root.prefix }] }]
              : []),
          ];
          if (root.title) (node as { title?: string }).title = root.title;
          if (root.description) (node as { description?: string }).description = root.description;
          if (root.link?.href)
            (node as { link?: { href: string; label?: string } }).link = root.link;
          if (planned) {
            (node as { availability?: "planned" }).availability = "planned";
            (node as { availabilityNote?: string }).availabilityNote = root.planned;
          }
          return node;
        }),
      );
    },

    async loadChildren(node, context) {
      const declared = locationOf.get(node.id);
      const location = declared ?? parseS3Id(node.id);
      if (!location) {
        throw new S3AccessError("invalid-response", { bucket: node.id });
      }
      // Nothing is caught here, which is the point of the error carrying both contracts: converting
      // it into a plain branded error would stop a consumer's own `catch (e) { if (e instanceof
      // S3AccessError) }` matching. One object satisfies both - `kind`, `status`, `bucket` and
      // `prefix` for whoever catches it, `datasetTreeErrorCode`, `retryable` and a reader-facing
      // `message` for the component.
      return await list(location.bucket, location.prefix, context);
    },

    /**
     * One request, one key, no pagination: has anything been published here yet? `max-keys=1` and
     * `no-store`, because the answer is a fact about right now and a cached one is worse than none.
     * It asks for the ROOT's own prefix, so a declared prefix with nothing under it reads as empty
     * even when the bucket around it is full. Every failure - a refusal, a timeout, a CORS block, a
     * malformed response - resolves `undefined`; only a listing that arrived, parsed and held
     * neither an object nor a common prefix answers `empty`.
     */
    async probeAvailability(node, context) {
      // A planned collection is never asked. Its bucket may not exist yet, and the catalogue has
      // already said what the row should show.
      if (node.availability === "planned") return undefined;
      const location = locationOf.get(node.id) ?? parseS3Id(node.id);
      if (!location) return undefined;
      try {
        const body = await request(
          probeUrl(location.bucket, location.prefix),
          location.bucket,
          location.prefix,
          context.signal,
        );
        const page = parseListObjectsV2(body, location);
        // `KeyCount` alone is not enough: with a delimiter, a gateway reports the number of direct
        // OBJECTS, which is legally zero for a bucket whose entire contents live one level down.
        // The presence of either objects or common prefixes is the question.
        const populated = page.objects.length > 0 || page.prefixes.length > 0;
        return populated ? "available" : "empty";
      } catch {
        return undefined;
      }
    },
  };
}

/** `s3://bucket/some/prefix/` back into its parts. */
function parseS3Id(id: string): { bucket: string; prefix: string } | null {
  if (typeof id !== "string" || !id.startsWith("s3://")) return null;
  const rest = id.slice("s3://".length);
  const slash = rest.indexOf("/");
  const bucket = slash === -1 ? rest : rest.slice(0, slash);
  if (!BUCKET_RE.test(bucket)) return null;
  const prefix = slash === -1 ? "" : rest.slice(slash + 1);
  if (prefix.length > 0 && !prefix.endsWith("/")) return { bucket, prefix: `${prefix}/` };
  return { bucket, prefix };
}
