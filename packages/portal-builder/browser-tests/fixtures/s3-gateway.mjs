// A local S3-compatible gateway, speaking ListObjectsV2 over the real wire format.
//
// The reported archive is reachable from a browser and NOT from this sandbox: the egress proxy
// refuses the CONNECT. So the live path is exercised against a gateway that serves the same
// protocol (`list-type=2`, `delimiter=/`, `max-keys`, `continuation-token`, `CommonPrefixes`,
// `Contents`, `IsTruncated`, `NextContinuationToken`) over the same key layout, including the
// exact path the report verified:
//
//     cmip6/healpix/cmip6/historical-r10i1p1f2/cnrm-cm6-1/P1M/level_0.zarr
//
// That proves everything between the block's configuration and the parsed nodes: URL
// construction, XML parsing, pagination, cancellation, retries, and the tree's lazy expansion. It
// cannot prove that DKRZ's own CORS headers are right, and the report says so. ListBuckets is
// refused with the 403 a real S3 root gives, so a build that tries to discover buckets fails here
// loudly instead of silently working against a permissive fake.

import { createServer } from "node:http";
import { createServer as createTlsServer } from "node:https";

/** The archive's keys, laid out as the reported one is. */
function keys() {
  const out = [];
  const push = (k, size) => out.push({ key: k, size });
  const members = ["historical-r10i1p1f2", "historical-r1i1p1f2", "ssp585-r1i1p1f2"];
  const models = ["cnrm-cm6-1", "icon-esm-lr"];
  for (const member of members) {
    for (const model of models) {
      for (const freq of ["P1M", "P1D"]) {
        for (const level of [0, 1, 2]) {
          const store = `healpix/cmip6/${member}/${model}/${freq}/level_${level}.zarr`;
          // A `.zarr` store's own contents. The tree must STOP at the store and never list these.
          push(`${store}/.zmetadata`, 4096);
          push(`${store}/zarr.json`, 512);
          for (let chunk = 0; chunk < 40; chunk += 1) {
            push(`${store}/tas/c/0/${chunk}`, 1048576);
          }
        }
      }
    }
  }
  push("healpix/cmip6/README.md", 2048);
  return out;
}

/**
 * The archive's buckets, and the three states a browser has to be able to tell apart.
 *
 * `cordex` is EMPTY - it exists, it lists, and it holds nothing. That is the one state that may
 * show "no data yet", and it is deliberately a real empty listing rather than a 404: the
 * difference between "announced but not filled" and "not there" is exactly what the probe is for.
 * `icdc` and `palmod` are not here at all, and the server answers them differently on purpose: one
 * refuses anonymous listing, the other does not exist.
 */
const BUCKETS = new Map([
  ["cmip6", keys()],
  ["cordex", []],
  ["dyamond", [{ key: "healpix/dyamond/winter/level_0.zarr/zarr.json", size: 512 }]],
  ["eerie", [{ key: "eerie-hist-1950-v20240618_P1M_mean_0.zarr/zarr.json", size: 512 }]],
  ["icon-dream", [{ key: "reanalysis/level_0.zarr/zarr.json", size: 512 }]],
  // SYMLINKS, a shape a real gateway serves. Every entry here is a plain OBJECT whose key ends in
  // `.zarr` or has no extension at all, and whose size is the byte length of a link target rather
  // than of any data. That is what a symlinked collection looks like over S3: no CommonPrefix, no
  // way to say "symlink", and a browser that classifies by which element carried the key sees an
  // archive of 51-byte files. `TARGETS` below is the other half - what listing through one of
  // these answers.
  [
    "nextgems",
    [
      { key: "cycle3/level_0.zarr/zarr.json", size: 512 },
      { key: "healpix/ngc3028/PT30M/level_0.zarr", size: 51 },
      { key: "healpix/ngc3028/PT30M/level_1.zarr", size: 51 },
      { key: "healpix/ngc3028/PT30M/level_2.zarr", size: 51 },
      // A symlinked DIRECTORY: no extension, and listing it resolves through the link.
      { key: "healpix/ngc4008", size: 37 },
    ],
  ],
  ["obs", [{ key: "satellite/level_0.zarr/zarr.json", size: 512 }]],
  ["reanalysis", [{ key: "era5/level_0.zarr/zarr.json", size: 512 }]],
  // `xspies` is absent AND locked in the catalogue: nothing must ever ask for it, and the request
  // log is what proves it.
]);

/**
 * What a listing THROUGH a symlink answers, keyed by `bucket/link`.
 *
 * The target is not in the bucket's own key list because it is not visible there: a reader listing
 * `healpix/` sees the link object and nothing else, exactly as the real gateway shows it. A prefix
 * that walks INTO the link is resolved and answered with the target's keys rewritten back under
 * the path that was asked for, which is why the tree can list a symlinked collection at all, and
 * why the adapter is right to let listing be the source of truth.
 */
const TARGETS = new Map([
  [
    "nextgems/healpix/ngc4008",
    [
      { key: "P1D/level_0.zarr", size: 51 },
      { key: "P1D/level_1.zarr", size: 51 },
      { key: "PT15M/level_0.zarr", size: 51 },
    ],
  ],
]);

/** Buckets that exist but refuse anonymous listing, with the document a real gateway returns. */
const FORBIDDEN = new Set(["icdc"]);

function xmlEscape(value) {
  return String(value).replace(
    /[<>&'"]/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c],
  );
}

/**
 * One ListObjectsV2 page. Faithful to the parts the adapter reads, including the one that matters
 * most: with a `/` delimiter, a key deeper than the prefix collapses into a `CommonPrefixes`
 * entry, which is what makes a `.zarr` store one row instead of forty-two.
 */
function listPage(bucket, { prefix, delimiter, maxKeys, token }) {
  const all = BUCKETS.get(bucket) ?? [];
  // A prefix that walks into a link is answered from the link's TARGET, under the path that was
  // asked for - which is what makes the link invisible over the protocol: the client asked for
  // `healpix/ngc4008/` and gets that directory's contents, with no way to tell they are stored
  // somewhere else.
  let matching = all.filter((entry) => entry.key.startsWith(prefix));
  for (const [id, entries] of TARGETS) {
    const link = id.startsWith(`${bucket}/`) ? id.slice(bucket.length + 1) : null;
    if (!link || !prefix.startsWith(`${link}/`)) continue;
    const inside = prefix.slice(link.length + 1);
    matching = entries
      .filter((entry) => entry.key.startsWith(inside))
      .map((entry) => ({ ...entry, key: `${link}/${entry.key}` }));
    break;
  }
  const prefixes = new Set();
  const contents = [];
  for (const entry of matching) {
    const rest = entry.key.slice(prefix.length);
    const slash = delimiter ? rest.indexOf(delimiter) : -1;
    if (slash === -1) contents.push(entry);
    else prefixes.add(`${prefix}${rest.slice(0, slash + 1)}`);
  }
  // One flat, ordered stream, so a continuation token is an index into something stable.
  const stream = [
    ...[...prefixes].sort().map((p) => ({ kind: "prefix", value: p })),
    ...contents
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((c) => ({ kind: "object", value: c })),
  ];
  const start = token ? Number(token) : 0;
  const page = stream.slice(start, start + maxKeys);
  const next = start + maxKeys;
  const truncated = next < stream.length;

  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
    `<Name>${xmlEscape(bucket)}</Name><Prefix>${xmlEscape(prefix)}</Prefix>` +
    `<KeyCount>${page.length}</KeyCount><MaxKeys>${maxKeys}</MaxKeys>` +
    `<Delimiter>${xmlEscape(delimiter ?? "")}</Delimiter>` +
    `<IsTruncated>${truncated}</IsTruncated>` +
    (truncated ? `<NextContinuationToken>${next}</NextContinuationToken>` : "") +
    page
      .map((item) =>
        item.kind === "prefix"
          ? `<CommonPrefixes><Prefix>${xmlEscape(item.value)}</Prefix></CommonPrefixes>`
          : `<Contents><Key>${xmlEscape(item.value.key)}</Key>` +
            `<Size>${item.value.size}</Size>` +
            `<LastModified>2026-06-18T09:00:00.000Z</LastModified></Contents>`,
      )
      .join("") +
    `</ListBucketResult>`;
  return body;
}

/**
 * Start the gateway. `requests` collects every path it was asked for, so a test can prove what the
 * page did and did not fetch - which is the whole point of "children only when a row is expanded".
 */
export async function startS3Gateway({
  corsOrigin = "*",
  failFirst = 0,
  delayMs = 0,
  objects = new Map(),
  tls = null,
  host = "127.0.0.1",
} = {}) {
  // The knobs are MUTABLE, and one gateway serves the whole suite. A server per scenario would
  // cost a portal build per scenario: the gateway's origin is baked into the artifact's recorded
  // `connect-src` at build time, so a second origin means a second build. One origin, one build,
  // and the failure and latency behaviour moved per check instead.
  let mode = { failFirst, delayMs };
  const requests = [];
  // Connections the CLIENT hung up on, the only place cancellation is observable. A tree that
  // collapses a branch mid-flight must abort the listing rather than let it land in a node nobody
  // is looking at any more. From outside the page that is exactly one thing: a socket closed
  // before the response was written. `delayMs` makes the window wide enough to close.
  const aborted = [];
  let failures = 0;
  // HTTPS when a caller supplies a certificate, because a real portal is https. Suites that only
  // watch traffic are happy on `http://127.0.0.1`; the one that runs a recipe in a real
  // interpreter is not, because the portal is served over TLS and a browser refuses the
  // mixed-content fetch before any policy is consulted. Same handler - what changes is the socket.
  const handler = (request, response) => {
    const url = new URL(request.url ?? "/", "http://gateway");
    requests.push(url.pathname + url.search);
    const cors = {
      "access-control-allow-origin": corsOrigin,
      "access-control-expose-headers": "*",
    };
    if (request.method === "OPTIONS") {
      response.writeHead(204, { ...cors, "access-control-allow-headers": "*" });
      response.end();
      return;
    }
    const segments = url.pathname.split("/").filter(Boolean);
    // THE ROOT IS 403, exactly as a real S3 endpoint answers it. Nothing may ever ask.
    if (segments.length === 0) {
      response.writeHead(403, { ...cors, "content-type": "application/xml" });
      response.end(
        `<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code>` +
          `<Message>Access Denied</Message></Error>`,
      );
      return;
    }
    const bucket = segments[0];
    if (FORBIDDEN.has(bucket)) {
      response.writeHead(403, { ...cors, "content-type": "application/xml" });
      response.end(
        `<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code>` +
          `<Message>Access Denied</Message></Error>`,
      );
      return;
    }
    if (!BUCKETS.has(bucket)) {
      response.writeHead(404, { ...cors, "content-type": "application/xml" });
      response.end(
        `<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchBucket</Code></Error>`,
      );
      return;
    }
    // A GET OF AN OBJECT, which is what reading a store actually is. A request with no `list-type`
    // names one key. The tree never makes one - it lists, and it stops at a store - but the Python
    // recipe the tree DISPLAYS opens that store, and an acceptance run that puts that program in a
    // real interpreter needs the bytes to be there. `objects` is keyed `bucket/key`, and a miss is
    // `NoSuchKey`, which a store reader has to be able to tell from a network failure.
    if (!url.searchParams.has("list-type") && segments.length > 1) {
      const key = segments.slice(1).map(decodeURIComponent).join("/");
      const body = objects.get(`${bucket}/${key}`);
      if (!body) {
        response.writeHead(404, { ...cors, "content-type": "application/xml" });
        response.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code></Error>`);
        return;
      }
      const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? "");
      if (range) {
        const start = range[1] === "" ? body.length - Number(range[2]) : Number(range[1]);
        const end = range[2] === "" || range[1] === "" ? body.length - 1 : Number(range[2]);
        const slice = body.subarray(start, end + 1);
        response.writeHead(206, {
          ...cors,
          "content-type": "application/octet-stream",
          "content-length": String(slice.length),
          "content-range": `bytes ${start}-${end}/${body.length}`,
          "accept-ranges": "bytes",
        });
        response.end(request.method === "HEAD" ? undefined : slice);
        return;
      }
      response.writeHead(200, {
        ...cors,
        "content-type": "application/octet-stream",
        "content-length": String(body.length),
        "accept-ranges": "bytes",
      });
      response.end(request.method === "HEAD" ? undefined : body);
      return;
    }

    // A bounded number of 5xx answers, so the adapter's retry can be watched rather than assumed.
    if (failures < mode.failFirst) {
      failures += 1;
      response.writeHead(503, { ...cors, "content-type": "application/xml" });
      response.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>SlowDown</Code></Error>`);
      return;
    }
    const body = listPage(bucket, {
      prefix: url.searchParams.get("prefix") ?? "",
      delimiter: url.searchParams.get("delimiter") ?? "",
      maxKeys: Number(url.searchParams.get("max-keys") ?? 1000),
      token: url.searchParams.get("continuation-token"),
    });
    let closed = false;
    request.on("aborted", () => {
      closed = true;
      aborted.push(url.pathname + url.search);
    });
    const send = () => {
      if (closed || response.writableEnded) return;
      response.writeHead(200, { ...cors, "content-type": "application/xml" });
      response.end(body);
    };
    if (mode.delayMs > 0) setTimeout(send, mode.delayMs).unref();
    else send();
  };
  const server = tls ? createTlsServer(tls, handler) : createServer(handler);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  const origin = `${tls ? "https" : "http"}://${host}:${port}`;
  return {
    server,
    requests,
    aborted,
    origin,
    endpoint: origin,
    /** Change how the gateway behaves for the next check, and forget what the last one did. */
    set: (next = {}) => {
      mode = { failFirst: next.failFirst ?? 0, delayMs: next.delayMs ?? 0 };
      requests.length = 0;
      aborted.length = 0;
      failures = 0;
    },
    reset: () => {
      requests.length = 0;
      aborted.length = 0;
      failures = 0;
    },
    close: () => new Promise((done) => server.close(done)),
  };
}
