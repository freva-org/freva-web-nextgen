// The S3 adapter.
//
// Every test here injects its own `fetch`, so the suite is network-free by construction rather than
// by convention: there is no global to forget to stub. The distinctions being defended are the ones
// a user feels - an empty directory is not a permission error, and neither is a CORS failure.

import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";

import { S3AccessError, createS3Source, parseListObjectsV2 } from "../src/s3.js";
import type { DatasetTreeNode } from "../src/types.js";

const ENDPOINT = "https://objects.example.test";

/** A ListObjectsV2 body, namespaced the way a real gateway sends it. */
function listing(options: {
  prefixes?: string[];
  objects?: { key: string; size?: number; modified?: string }[];
  truncated?: boolean;
  token?: string;
}): string {
  const prefixes = (options.prefixes ?? [])
    .map((p) => `<CommonPrefixes><Prefix>${p}</Prefix></CommonPrefixes>`)
    .join("");
  const contents = (options.objects ?? [])
    .map(
      (o) =>
        `<Contents><Key>${o.key}</Key><Size>${o.size ?? 0}</Size>` +
        `<LastModified>${o.modified ?? "2026-01-02T03:04:05.000Z"}</LastModified></Contents>`,
    )
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
    `<Name>archive</Name><IsTruncated>${options.truncated ? "true" : "false"}</IsTruncated>` +
    (options.token ? `<NextContinuationToken>${options.token}</NextContinuationToken>` : "") +
    prefixes +
    contents +
    `</ListBucketResult>`
  );
}

interface Call {
  url: string;
  init: RequestInit;
}

/** A `fetch` that answers from a script and records every call. */
function fakeFetch(
  script: (call: number, url: string) => { status?: number; body?: string } | Error,
): { fetch: typeof globalThis.fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const answer = script(calls.length - 1, url);
    if (answer instanceof Error) throw answer;
    const status = answer.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => answer.body ?? "",
    } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  return { fetch: impl, calls };
}

const roots = [{ name: "Archive", bucket: "archive", prefix: "reanalysis/" }];

function context(signal?: AbortSignal): { signal: AbortSignal } {
  return { signal: signal ?? new AbortController().signal };
}

async function children(
  source: ReturnType<typeof createS3Source>,
  signal?: AbortSignal,
): Promise<readonly DatasetTreeNode[]> {
  const [root] = await source.loadRoots(context(signal));
  return source.loadChildren(root, context(signal));
}

test("the roots are the declared ones, and cost no request at all", async () => {
  const { fetch, calls } = fakeFetch(() => ({ body: listing({}) }));
  const source = createS3Source({ endpoint: ENDPOINT, roots, fetch });
  const list = await source.loadRoots(context());

  assert.deepEqual(calls, [], "listing the roots hit the network");
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "s3://archive/reanalysis/");
  assert.equal(list[0].kind, "collection");
  assert.equal(list[0].path, "s3://archive/reanalysis/");
});

test("a listing becomes directories and files, directories first, each sorted", async () => {
  const { fetch } = fakeFetch(() => ({
    body: listing({
      prefixes: ["reanalysis/surface/", "reanalysis/pressure/"],
      objects: [
        { key: "reanalysis/zeta.nc", size: 2048 },
        { key: "reanalysis/alpha.nc", size: 1024, modified: "2026-03-04T05:06:07.000Z" },
      ],
    }),
  }));
  const source = createS3Source({ endpoint: ENDPOINT, roots, fetch });
  const list = await children(source);

  assert.deepEqual(
    list.map((n) => `${n.kind}:${n.name}`),
    ["directory:pressure", "directory:surface", "file:alpha.nc", "file:zeta.nc"],
  );
  const alpha = list.find((n) => n.name === "alpha.nc");
  assert.equal(alpha?.size, 1024);
  assert.equal(alpha?.modifiedAt, "2026-03-04T05:06:07.000Z");
  assert.equal(alpha?.id, "s3://archive/reanalysis/alpha.nc");
  assert.equal(alpha?.hasChildren, false);
});

test("the request is a ListObjectsV2 against one named bucket - never ListBuckets", async () => {
  const { fetch, calls } = fakeFetch(() => ({ body: listing({}) }));
  const source = createS3Source({ endpoint: ENDPOINT, roots, fetch });
  await children(source);

  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.origin, ENDPOINT);
  assert.equal(url.pathname, "/archive", "the bucket is missing from the path");
  assert.equal(url.searchParams.get("list-type"), "2");
  assert.equal(url.searchParams.get("delimiter"), "/");
  assert.equal(url.searchParams.get("prefix"), "reanalysis/");
  assert.equal(url.searchParams.get("max-keys"), "1000");
  // A bucketless GET of the endpoint root is what bucket enumeration looks like on the wire.
  for (const call of calls) {
    assert.notEqual(new URL(call.url).pathname, "/", "the adapter enumerated buckets");
  }
});

test("no credential ever reaches the wire", async () => {
  const { fetch, calls } = fakeFetch(() => ({ body: listing({}) }));
  const source = createS3Source({ endpoint: ENDPOINT, roots, fetch });
  await children(source);

  const init = calls[0].init as RequestInit & { headers?: Record<string, string> };
  assert.equal(init.credentials, "omit");
  const headerNames = Object.keys(init.headers ?? {}).map((h) => h.toLowerCase());
  for (const forbidden of ["authorization", "x-amz-security-token", "cookie", "x-amz-date"]) {
    assert.ok(!headerNames.includes(forbidden), `the adapter sent a ${forbidden} header`);
  }
  assert.equal(calls[0].url.includes("X-Amz-Signature"), false);
});

test("virtual-host style puts the bucket in the hostname instead", async () => {
  const { fetch, calls } = fakeFetch(() => ({ body: listing({}) }));
  const source = createS3Source({ endpoint: ENDPOINT, roots, fetch, style: "virtual-host" });
  await children(source);

  const url = new URL(calls[0].url);
  assert.equal(url.hostname, "archive.objects.example.test");
  assert.equal(url.pathname, "/");
});

test("pagination follows continuation tokens and accumulates every page", async () => {
  const { fetch, calls } = fakeFetch((call) => {
    if (call === 0) {
      return {
        body: listing({ objects: [{ key: "reanalysis/a.nc" }], truncated: true, token: "T1" }),
      };
    }
    if (call === 1) {
      return {
        body: listing({ objects: [{ key: "reanalysis/b.nc" }], truncated: true, token: "T2" }),
      };
    }
    return { body: listing({ objects: [{ key: "reanalysis/c.nc" }] }) };
  });
  const source = createS3Source({ endpoint: ENDPOINT, roots, fetch });
  const list = await children(source);

  assert.deepEqual(
    list.map((n) => n.name),
    ["a.nc", "b.nc", "c.nc"],
  );
  assert.equal(calls.length, 3);
  assert.equal(new URL(calls[0].url).searchParams.get("continuation-token"), null);
  assert.equal(new URL(calls[1].url).searchParams.get("continuation-token"), "T1");
  assert.equal(new URL(calls[2].url).searchParams.get("continuation-token"), "T2");
});

test("pagination is bounded, and a truncated walk says so instead of pretending to be complete", async () => {
  const { fetch, calls } = fakeFetch((call) => ({
    body: listing({
      objects: [{ key: `reanalysis/${call}.nc` }],
      truncated: true,
      token: `T${call}`,
    }),
  }));
  const truncations: unknown[] = [];
  const source = createS3Source({
    endpoint: ENDPOINT,
    roots,
    fetch,
    maxPages: 3,
    onTruncated: (info) => truncations.push(info),
  });
  const list = await children(source);

  assert.equal(calls.length, 3, "the walk ran past its page limit");
  assert.equal(list.length, 3);
  assert.deepEqual(truncations, [{ bucket: "archive", prefix: "reanalysis/", pages: 3 }]);
});

test("an empty directory is an empty list, not a failure", async () => {
  const { fetch } = fakeFetch(() => ({ body: listing({}) }));
  const source = createS3Source({ endpoint: ENDPOINT, roots, fetch });
  assert.deepEqual(await children(source), []);
});

test("403 is a permission problem, and says what to check", async () => {
  const { fetch } = fakeFetch(() => ({
    status: 403,
    body: "<Error><Code>AccessDenied</Code></Error>",
  }));
  const source = createS3Source({ endpoint: ENDPOINT, roots, fetch });
  await assert.rejects(children(source), (error: unknown) => {
    assert.ok(error instanceof S3AccessError);
    assert.equal(error.kind, "forbidden");
    // The SENTENCE is for the reader, and the status is not in it.
    //
    // "HTTP 403 - the bucket does not allow anonymous listing from a browser (check its policy
    // and CORS rules)" is a message for whoever deployed the gateway, printed where a visitor is
    // standing. The status stays on the error for them, in `status` and in `detail`; what reaches
    // the screen is the one fact a reader can act on.
    assert.equal(
      error.message,
      "Access denied - this bucket does not permit anonymous browser listing.",
    );
    assert.equal(error.status, 403);
    assert.equal(error.datasetTreeErrorCode, "access-denied");
    // No Retry beside it: the same request will be refused again.
    assert.equal(error.retryable, false);
    return true;
  });
});

test("404 is a different problem from 403, and from an empty directory", async () => {
  const { fetch } = fakeFetch(() => ({ status: 404 }));
  const source = createS3Source({ endpoint: ENDPOINT, roots, fetch });
  await assert.rejects(children(source), (error: unknown) => {
    assert.ok(error instanceof S3AccessError);
    assert.equal(error.kind, "not-found");
    // The bucket's NAME is in the sentence, because a name that is not there is almost always a
    // typo in a configuration file and showing which one was tried is the whole fix.
    assert.equal(
      error.message,
      "Bucket not found - “archive” does not exist at the configured storage service.",
    );
    assert.equal(error.retryable, false);
    return true;
  });
});

test("a store that says NoSuchKey about a prefix is a folder that has gone, not a missing bucket", async () => {
  // The two 404s a browser can meet, and they need different sentences.
  //
  // A bucket that does not exist is somebody's configuration, and the fix is to correct it. A
  // prefix the store says is not there disappeared while this page was open - somebody deleted the
  // objects under it - and the fix is to reload the parent, which is what the message says.
  const { fetch } = fakeFetch(() => ({
    status: 404,
    body: "<Error><Code>NoSuchKey</Code></Error>",
  }));
  const source = createS3Source({ endpoint: ENDPOINT, roots, fetch });
  await assert.rejects(children(source), (error: unknown) => {
    assert.ok(error instanceof S3AccessError);
    assert.equal(error.kind, "gone");
    assert.equal(
      error.message,
      "This folder no longer exists. Reload its parent to refresh the listing.",
    );
    // Retrying the child would only prove the child is still absent; the message says what will.
    assert.equal(error.retryable, false);
    return true;
  });
});

test("a request that never completes is a network problem, and names CORS as the usual cause", async () => {
  const { fetch, calls } = fakeFetch(() => new TypeError("Failed to fetch"));
  const source = createS3Source({ endpoint: ENDPOINT, roots, fetch, retryDelayMs: 0 });
  await assert.rejects(children(source), (error: unknown) => {
    assert.ok(error instanceof S3AccessError);
    assert.equal(error.kind, "network");
    assert.match(error.message, /CORS/);
    return true;
  });
  // Retried once by default, then given up on. Never a loop.
  assert.equal(calls.length, 2);
});

test("retries are bounded and selective: 5xx is retried, 4xx is not", async () => {
  const server = fakeFetch(() => ({ status: 503 }));
  const source = createS3Source({
    endpoint: ENDPOINT,
    roots,
    fetch: server.fetch,
    retries: 2,
    retryDelayMs: 0,
  });
  await assert.rejects(children(source));
  assert.equal(server.calls.length, 3, "5xx was not retried the configured number of times");

  const client = fakeFetch(() => ({ status: 400 }));
  const source2 = createS3Source({
    endpoint: ENDPOINT,
    roots,
    fetch: client.fetch,
    retries: 2,
    retryDelayMs: 0,
  });
  await assert.rejects(children(source2));
  assert.equal(client.calls.length, 1, "a 400 was retried, which cannot help");
});

test("a retry that succeeds returns the data", async () => {
  const { fetch, calls } = fakeFetch((call) =>
    call === 0
      ? new TypeError("Failed to fetch")
      : { body: listing({ objects: [{ key: "reanalysis/a.nc" }] }) },
  );
  const source = createS3Source({ endpoint: ENDPOINT, roots, fetch, retryDelayMs: 0 });
  const list = await children(source);
  assert.deepEqual(
    list.map((n) => n.name),
    ["a.nc"],
  );
  assert.equal(calls.length, 2);
});

test("a response that is not a listing is reported as such, not parsed hopefully", async () => {
  for (const body of [
    "<html><body>502 Bad Gateway</body></html>",
    "<Error><Code>NoSuchBucket</Code></Error>",
    "not xml at all <<<",
    '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e "boom">]><ListBucketResult/>',
  ]) {
    const { fetch } = fakeFetch(() => ({ body }));
    const source = createS3Source({ endpoint: ENDPOINT, roots, fetch });
    await assert.rejects(children(source), (error: unknown) => {
      assert.ok(error instanceof S3AccessError, `not an S3AccessError for ${body.slice(0, 20)}`);
      assert.equal(error.kind, "invalid-response");
      return true;
    });
  }
});

test("an abort stops the walk and rejects rather than resolving with half a listing", async () => {
  const controller = new AbortController();
  const { fetch, calls } = fakeFetch((call) => {
    if (call === 0)
      return {
        body: listing({ objects: [{ key: "reanalysis/a.nc" }], truncated: true, token: "T" }),
      };
    controller.abort();
    return { body: listing({ objects: [{ key: "reanalysis/b.nc" }] }) };
  });
  const source = createS3Source({ endpoint: ENDPOINT, roots, fetch });
  const [root] = await source.loadRoots(context());

  const aborting = source.loadChildren(root, { signal: controller.signal });
  controller.abort();
  await assert.rejects(aborting, (error: unknown) => {
    assert.ok(error instanceof S3AccessError);
    assert.equal(error.kind, "aborted");
    return true;
  });
  assert.ok(calls.length <= 1);
});

test("aborting mid-flight cancels the request the adapter is actually waiting on", async () => {
  const controller = new AbortController();
  let seen: AbortSignal | undefined;
  // A gateway that never answers, exactly like one behind a hung connection.
  const fetchImpl = ((_input: RequestInfo | URL, init: RequestInit = {}) => {
    seen = init.signal ?? undefined;
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () =>
        reject(new DOMException("Aborted", "AbortError")),
      );
    });
  }) as unknown as typeof globalThis.fetch;

  const source = createS3Source({ endpoint: ENDPOINT, roots, fetch: fetchImpl });
  const [root] = await source.loadRoots(context());
  const pending = source.loadChildren(root, { signal: controller.signal });

  assert.ok(seen, "no signal was passed to fetch");
  assert.equal(seen?.aborted, false);
  controller.abort();
  assert.equal(seen?.aborted, true, "the adapter's signal is not linked to the caller's");
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof S3AccessError);
    assert.equal(error.kind, "aborted");
    return true;
  });
});

test("the abort bridge is torn down when a request finishes, so a long-lived signal cannot leak", async () => {
  // One `AbortSignal` outlives many expansions in a real tree. If the adapter kept adding listeners
  // to it and never removed them, a session of browsing would accumulate one per request.
  const controller = new AbortController();
  const target = controller.signal as AbortSignal & {
    addEventListener: (...args: unknown[]) => void;
    removeEventListener: (...args: unknown[]) => void;
  };
  let added = 0;
  let removed = 0;
  const originalAdd = target.addEventListener.bind(target);
  const originalRemove = target.removeEventListener.bind(target);
  target.addEventListener = (...args: unknown[]) => {
    added += 1;
    return originalAdd(...args);
  };
  target.removeEventListener = (...args: unknown[]) => {
    removed += 1;
    return originalRemove(...args);
  };

  const { fetch } = fakeFetch(() => ({ body: listing({}) }));
  const source = createS3Source({ endpoint: ENDPOINT, roots, fetch });
  const [root] = await source.loadRoots({ signal: controller.signal });
  for (let i = 0; i < 3; i += 1) {
    await source.loadChildren(root, { signal: controller.signal });
  }
  assert.ok(added > 0, "the adapter never linked the caller's signal");
  assert.equal(removed, added, `${added} listeners added, ${removed} removed`);
});

test("a directory marker is not shown as a file", async () => {
  const { fetch } = fakeFetch(() => ({
    body: listing({
      objects: [
        { key: "reanalysis/" },
        { key: "reanalysis/sub/" },
        { key: "reanalysis/real.nc", size: 12 },
      ],
    }),
  }));
  const source = createS3Source({ endpoint: ENDPOINT, roots, fetch });
  const list = await children(source);
  assert.deepEqual(
    list.map((n) => n.name),
    ["real.nc"],
  );
});

test("a configured store suffix reads as a dataset, not as a thousand files", async () => {
  const { fetch } = fakeFetch(() => ({
    body: listing({ prefixes: ["reanalysis/tas.zarr/", "reanalysis/plain/"] }),
  }));
  const source = createS3Source({ endpoint: ENDPOINT, roots, fetch });
  const list = await children(source);
  const tas = list.find((n) => n.name === "tas.zarr");
  assert.equal(tas?.kind, "dataset");
  assert.equal(tas?.hasChildren, false, "a store should not invite a listing of its chunks");
  assert.equal(list.find((n) => n.name === "plain")?.kind, "directory");
});

// THE SYMLINKED-COLLECTION CASE, in the exact shape the HEALPix hub returns it.
//
// `s3://nextgems/healpix/ngc3028/PT30M/` answers with ten `Contents` objects of 51 bytes each and
// NO `CommonPrefixes`, because each level is a symlink and S3 has no way to say so - the size is
// the byte length of the link target. Classified by which element carried the key, an entire
// archive of Zarr pyramids became a list of 51-byte files: no inspect, no recipe, nothing to open.
test("a .zarr listed as an object is a store, not a 51-byte file", async () => {
  const { fetch } = fakeFetch(() => ({
    body: listing({
      objects: [
        { key: "reanalysis/level_0.zarr", size: 51 },
        { key: "reanalysis/level_1.zarr", size: 51 },
      ],
    }),
  }));
  const source = createS3Source({ endpoint: ENDPOINT, roots, fetch });
  const list = await children(source);

  assert.deepEqual(
    list.map((n) => `${n.kind}:${n.name}`),
    ["dataset:level_0.zarr", "dataset:level_1.zarr"],
  );
  const first = list[0] as DatasetTreeNode & { inspect?: string; size?: number };
  assert.equal(first.inspect, "https://objects.example.test/archive/reanalysis/level_0.zarr");
  assert.equal(first.path, "s3://archive/reanalysis/level_0.zarr");
  assert.equal(first.hasChildren, false);
  // The link's own length is not the store's size, and a store that reported 51 B would be a lie.
  assert.equal(first.size, undefined, "the symlink's byte length was reported as the store's size");
});

test("an extension-less object is a directory, because listing it is the only way to know", async () => {
  const { fetch, calls } = fakeFetch((call) => ({
    body:
      call === 0
        ? listing({ objects: [{ key: "reanalysis/ngc4008", size: 37 }] })
        : listing({ prefixes: ["reanalysis/ngc4008/P1D/"] }),
  }));
  const source = createS3Source({ endpoint: ENDPOINT, roots, fetch });
  const list = await children(source);
  assert.deepEqual(
    list.map((n) => `${n.kind}:${n.name}`),
    ["directory:ngc4008"],
  );
  // The separator is added, or the listing would match every sibling whose name starts the same.
  assert.equal(list[0].path, "s3://archive/reanalysis/ngc4008/");
  assert.equal(list[0].hasChildren, true);

  const inside = await source.loadChildren(list[0], context());
  assert.deepEqual(
    inside.map((n) => `${n.kind}:${n.name}`),
    ["directory:P1D"],
  );
  assert.match(calls[1].url, /prefix=reanalysis%2Fngc4008%2F/);
});

test("a name with a real extension is still a file", async () => {
  const { fetch } = fakeFetch(() => ({
    body: listing({ objects: [{ key: "reanalysis/notes.md", size: 12 }] }),
  }));
  const source = createS3Source({ endpoint: ENDPOINT, roots, fetch });
  const list = await children(source);
  assert.deepEqual(
    list.map((n) => `${n.kind}:${n.name}`),
    ["file:notes.md"],
  );
  assert.equal((list[0] as DatasetTreeNode & { size?: number }).size, 12);
});

// A BRANCH SAYS WHERE IT IS, which is what gives it an info control.
//
// A directory's name is one segment of a path whose other segments are the rows above it, so a
// reader who wants to list this level from a shell has to reassemble the bucket and the key from
// the shape of the tree. The adapter knows both and publishes both; the component's existing rule
// (a branch gets an info control when its source published something the row does not show) turns
// that into a panel with no change to the view at all.
test("a directory publishes its bucket and prefix; a store does not repeat them", async () => {
  const { fetch } = fakeFetch(() => ({
    body: listing({ prefixes: ["reanalysis/P1D/", "reanalysis/tas.zarr/"] }),
  }));
  const source = createS3Source({ endpoint: ENDPOINT, roots, fetch });
  const list = await children(source);

  const dir = list.find((n) => n.name === "P1D") as DatasetTreeNode & {
    details?: { label: string; values: { text: string }[] }[];
  };
  assert.deepEqual(
    dir.details?.map((f) => [f.label, f.values[0]?.text]),
    [
      ["Bucket", "archive"],
      ["Prefix", "reanalysis/P1D/"],
    ],
  );
  const store = list.find((n) => n.name === "tas.zarr") as DatasetTreeNode & { details?: unknown };
  assert.equal(store.details, undefined, "a store repeated the address its panel already shows");
});

test("the two field labels this adapter publishes can be translated", async () => {
  const { fetch } = fakeFetch(() => ({ body: listing({ prefixes: ["reanalysis/P1D/"] }) }));
  const source = createS3Source({
    endpoint: ENDPOINT,
    roots,
    fetch,
    fieldLabels: { bucket: "Eimer", prefix: "Pr\u00e4fix" },
  });
  const list = await children(source);
  const dir = list[0] as DatasetTreeNode & { details?: { label: string }[] };
  assert.deepEqual(
    dir.details?.map((f) => f.label),
    ["Eimer", "Pr\u00e4fix"],
  );
});

test("a store carries the URL an inspector opens; a directory carries none", async () => {
  const { fetch } = fakeFetch(() => ({
    body: listing({ prefixes: ["reanalysis/a b+c.zarr/", "reanalysis/plain/"] }),
  }));
  const source = createS3Source({ endpoint: ENDPOINT, roots, fetch });
  const list = await children(source);
  // Path style, no query, and every segment escaped without escaping the separators.
  assert.equal(
    list.find((n) => n.name === "a b+c.zarr")?.inspect,
    "https://objects.example.test/archive/reanalysis/a%20b%2Bc.zarr/",
  );
  assert.equal(
    list.find((n) => n.name === "plain")?.inspect,
    undefined,
    "an ordinary directory offered an inspect target",
  );
});

test("virtual-host addressing puts the bucket in the inspector's hostname too", async () => {
  const { fetch } = fakeFetch(() => ({
    body: listing({ prefixes: ["reanalysis/tas.zarr/"] }),
  }));
  const source = createS3Source({ endpoint: ENDPOINT, roots, style: "virtual-host", fetch });
  const list = await children(source);
  assert.equal(
    list.find((n) => n.name === "tas.zarr")?.inspect,
    "https://archive.objects.example.test/reanalysis/tas.zarr/",
  );
});

test("identifiers are `s3://bucket/key`, and the same on every run", async () => {
  const make = () => {
    const { fetch } = fakeFetch(() => ({
      body: listing({
        prefixes: ["reanalysis/b/", "reanalysis/a/"],
        objects: [{ key: "reanalysis/z.nc" }],
      }),
    }));
    return createS3Source({ endpoint: ENDPOINT, roots, fetch });
  };
  const first = (await children(make())).map((n) => n.id);
  const second = (await children(make())).map((n) => n.id);
  assert.deepEqual(first, second);
  assert.deepEqual(first, [
    "s3://archive/reanalysis/a/",
    "s3://archive/reanalysis/b/",
    "s3://archive/reanalysis/z.nc",
  ]);
});

test("a nested directory can be listed from its own node", async () => {
  const { fetch, calls } = fakeFetch((call) =>
    call === 0
      ? { body: listing({ prefixes: ["reanalysis/surface/"] }) }
      : { body: listing({ objects: [{ key: "reanalysis/surface/tas.nc" }] }) },
  );
  const source = createS3Source({ endpoint: ENDPOINT, roots, fetch });
  const [surface] = await children(source);
  const deeper = await source.loadChildren(surface, context());

  assert.deepEqual(
    deeper.map((n) => n.name),
    ["tas.nc"],
  );
  assert.equal(new URL(calls[1].url).searchParams.get("prefix"), "reanalysis/surface/");
});

test("bad configuration fails at wiring time, not on the first click", () => {
  const bad: [string, () => unknown][] = [
    ["an ftp endpoint", () => createS3Source({ endpoint: "ftp://x.test", roots })],
    ["a relative endpoint", () => createS3Source({ endpoint: "/objects", roots })],
    [
      "credentials in the endpoint",
      () => createS3Source({ endpoint: "https://key:secret@x.test", roots }),
    ],
    ["a query in the endpoint", () => createS3Source({ endpoint: "https://x.test/?a=1", roots })],
    ["no roots", () => createS3Source({ endpoint: ENDPOINT, roots: [] })],
    [
      "an upper-case bucket",
      () => createS3Source({ endpoint: ENDPOINT, roots: [{ name: "x", bucket: "Archive" }] }),
    ],
    [
      "a bucket that is an IP address",
      () => createS3Source({ endpoint: ENDPOINT, roots: [{ name: "x", bucket: "10.0.0.1" }] }),
    ],
    [
      "a dotted bucket in virtual-host style",
      () =>
        createS3Source({
          endpoint: ENDPOINT,
          style: "virtual-host",
          roots: [{ name: "x", bucket: "my.archive" }],
        }),
    ],
    [
      "a traversing prefix",
      () =>
        createS3Source({
          endpoint: ENDPOINT,
          roots: [{ name: "x", bucket: "archive", prefix: "a/../../b/" }],
        }),
    ],
    [
      "an absolute prefix",
      () =>
        createS3Source({
          endpoint: ENDPOINT,
          roots: [{ name: "x", bucket: "archive", prefix: "/a/" }],
        }),
    ],
  ];
  for (const [what, thunk] of bad) {
    assert.throws(thunk, TypeError, `accepted ${what}`);
  }
});

test("a prefix without a trailing slash is normalised rather than silently listing a sibling", async () => {
  const { fetch, calls } = fakeFetch(() => ({ body: listing({}) }));
  const source = createS3Source({
    endpoint: ENDPOINT,
    roots: [{ name: "x", bucket: "archive", prefix: "reanalysis" }],
    fetch,
  });
  await children(source);
  assert.equal(new URL(calls[0].url).searchParams.get("prefix"), "reanalysis/");
});

test("parseListObjectsV2 reads the fields it needs and ignores the rest", () => {
  const page = parseListObjectsV2(
    listing({
      prefixes: ["a/"],
      objects: [{ key: "a.nc", size: 7, modified: "2026-01-01T00:00:00Z" }],
      truncated: true,
      token: "next",
    }),
  );
  assert.deepEqual(page.prefixes, ["a/"]);
  assert.deepEqual(page.objects, [{ key: "a.nc", size: 7, lastModified: "2026-01-01T00:00:00Z" }]);
  assert.equal(page.isTruncated, true);
  assert.equal(page.nextToken, "next");
});

test("a non-numeric or negative Size becomes no size at all, not NaN", () => {
  const body =
    `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
    `<IsTruncated>false</IsTruncated>` +
    `<Contents><Key>a.nc</Key><Size>huge</Size></Contents>` +
    `<Contents><Key>b.nc</Key><Size>-4</Size></Contents>` +
    `</ListBucketResult>`;
  const page = parseListObjectsV2(body);
  assert.equal(page.objects[0].size, null);
  assert.equal(page.objects[1].size, null);
});

// the rest of the error table

test("every listing failure a browser can meet gets its own sentence", async () => {
  // ONE TABLE, checked as a table.
  //
  // These are the conditions a public S3 gateway actually produces, and the reason each needs its
  // own wording is that the reader's next move differs: check a policy, fix a bucket name, wait,
  // retry, or tell whoever runs the endpoint. "Could not list" answers none of them.
  //
  // The `<Error>` bodies are the real documents S3 emits. A gateway's status and the store's own
  // code can disagree, and the body is the half that came from the store - so it wins.
  const cases: Array<{
    label: string;
    reply: { status?: number; body?: string } | Error;
    kind: string;
    message: string;
    retryable: boolean;
  }> = [
    {
      label: "429 with a SlowDown document",
      reply: { status: 429, body: "<Error><Code>SlowDown</Code></Error>" },
      kind: "rate-limited",
      message: "The storage service is rate-limiting requests. Wait briefly and retry.",
      retryable: true,
    },
    {
      label: "503 from a gateway that is down",
      reply: { status: 503, body: "<Error><Code>ServiceUnavailable</Code></Error>" },
      kind: "server",
      message: "The storage service is temporarily unavailable (HTTP 503).",
      retryable: true,
    },
    {
      label: "an HTML error page with a 200",
      reply: { body: "<html><body>nope</body></html>" },
      kind: "invalid-response",
      message: "The endpoint returned an invalid S3 listing.",
      retryable: true,
    },
    {
      label: "well-formed XML that is not a listing",
      reply: { body: "<Error><Code>AccessDenied</Code><Message>no</Message></Error>" },
      kind: "invalid-response",
      message: "The endpoint returned an invalid S3 listing.",
      retryable: true,
    },
    {
      label: "a body that is not XML at all",
      reply: { body: '{"error": "nope"}' },
      kind: "invalid-response",
      message: "The endpoint returned an invalid S3 listing.",
      retryable: true,
    },
    {
      label: "a 403 whose body says the bucket is missing",
      // The gateway's status and the store's code disagree; the store is the one that knows.
      reply: { status: 403, body: "<Error><Code>NoSuchBucket</Code></Error>" },
      kind: "not-found",
      message: "Bucket not found - “archive” does not exist at the configured storage service.",
      retryable: false,
    },
  ];

  for (const testCase of cases) {
    const { fetch } = fakeFetch(() =>
      testCase.reply instanceof Error ? testCase.reply : testCase.reply,
    );
    const source = createS3Source({
      endpoint: ENDPOINT,
      roots,
      fetch,
      retries: 0,
      retryDelayMs: 0,
    });
    await assert.rejects(children(source), (error: unknown) => {
      assert.ok(error instanceof S3AccessError, `${testCase.label}: not an S3AccessError`);
      assert.equal(error.kind, testCase.kind, testCase.label);
      assert.equal(error.message, testCase.message, testCase.label);
      assert.equal(error.retryable, testCase.retryable, `${testCase.label}: retryable`);
      // Diagnostics are carried for a developer and never appear in the sentence.
      assert.equal(error.detail.bucket, "archive");
      assert.equal(error.detail.prefix, "reanalysis/");
      assert.doesNotMatch(error.message, /archive\/reanalysis|http:\/\/|https:\/\//);
      return true;
    });
  }
});

test("the adapter's own deadline is a timeout; the caller's abort is not", async () => {
  // They arrive identically - one aborted fetch, one indistinguishable `AbortError` - and they mean
  // opposite things. A reader who collapsed a branch is owed silence; an endpoint that never
  // answered is owed a sentence and a Retry. Conflating them either accuses the endpoint of a fault
  // the reader caused, or hides a real timeout behind nothing at all.
  // A fetch that never answers but DOES honour its signal, like the real one.
  //
  // A stub that ignores the signal would leave both cases hanging forever and prove nothing about
  // either: the whole distinction under test is which abort fired first, and that only becomes
  // observable when the request actually rejects because of it.
  const hangingFetch = ((_url: string, init?: RequestInit) =>
    new Promise<never>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      if (signal.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
        once: true,
      });
    })) as unknown as typeof globalThis.fetch;

  const timedOut = createS3Source({
    endpoint: ENDPOINT,
    roots,
    fetch: hangingFetch,
    requestTimeoutMs: 20,
    retries: 0,
  });
  await assert.rejects(children(timedOut), (error: unknown) => {
    assert.ok(error instanceof S3AccessError);
    assert.equal(error.kind, "timeout");
    assert.equal(error.message, "Listing timed out. Check the connection and try again.");
    assert.equal(error.datasetTreeErrorCode, "timeout");
    assert.equal(error.retryable, true);
    return true;
  });

  const controller = new AbortController();
  const cancelled = createS3Source({
    endpoint: ENDPOINT,
    roots,
    fetch: hangingFetch,
    requestTimeoutMs: 5_000,
    retries: 0,
  });
  const pending = children(cancelled, controller.signal);
  controller.abort();
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof S3AccessError);
    assert.equal(error.kind, "aborted");
    // The component drops this before it can reach a message, which is the whole point of the code.
    assert.equal(error.datasetTreeErrorCode, "cancelled");
    return true;
  });
});

test("a body that stalls after the headers is a timeout, and is retried", async () => {
  // The deadline can fire AFTER the headers have arrived. A 200 whose body never finishes aborts
  // inside `response.text()`, not inside `fetch`, so an `AbortError` raised there leaves the
  // adapter unclassified: not an `S3AccessError`, therefore not retryable, therefore one attempt
  // and a developer's sentence where a reader should get "Listing timed out" and a Retry.
  let attempts = 0;
  const stalledBody = ((_url: string, init?: RequestInit) => {
    attempts += 1;
    const signal = init?.signal;
    const body = new Promise<string>((_resolve, reject) => {
      if (!signal) return;
      if (signal.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
        once: true,
      });
    });
    return Promise.resolve({ ok: true, status: 200, text: () => body } as unknown as Response);
  }) as unknown as typeof globalThis.fetch;

  const source = createS3Source({
    endpoint: ENDPOINT,
    roots,
    fetch: stalledBody,
    requestTimeoutMs: 20,
    retries: 1,
    retryDelayMs: 0,
  });
  await assert.rejects(children(source), (error: unknown) => {
    assert.ok(error instanceof S3AccessError, "a stalled body escaped unclassified");
    assert.equal(error.kind, "timeout");
    assert.equal(error.message, "Listing timed out. Check the connection and try again.");
    assert.equal(error.retryable, true);
    return true;
  });
  assert.equal(attempts, 2, "a deadline that fired while reading the body was not retried");

  // And the same abort, when it is the caller's, is still the caller's - cancelled at the moment
  // the body is read, so the request is really in flight rather than refused before it starts.
  attempts = 0;
  const controller = new AbortController();
  const cancelledMidBody = ((_url: string, init?: RequestInit) => {
    attempts += 1;
    const signal = init?.signal;
    const body = new Promise<string>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
        once: true,
      });
    });
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => {
        controller.abort();
        return body;
      },
    } as unknown as Response);
  }) as unknown as typeof globalThis.fetch;

  const cancelled = createS3Source({
    endpoint: ENDPOINT,
    roots,
    fetch: cancelledMidBody,
    requestTimeoutMs: 5_000,
    retries: 1,
    retryDelayMs: 0,
  });
  await assert.rejects(children(cancelled, controller.signal), (error: unknown) => {
    assert.ok(error instanceof S3AccessError);
    assert.equal(error.kind, "aborted");
    assert.equal(error.datasetTreeErrorCode, "cancelled");
    return true;
  });
  assert.equal(attempts, 1, "a caller's abort while reading the body was retried");
});

// the availability probe

test("the probe answers empty only for a listing that arrived, parsed and held nothing", async () => {
  const probeOf = async (
    reply: { status?: number; body?: string } | Error,
  ): Promise<string | undefined> => {
    const { fetch, calls } = fakeFetch(() => reply);
    const source = createS3Source({
      endpoint: ENDPOINT,
      roots,
      fetch,
      retries: 0,
      retryDelayMs: 0,
    });
    const [root] = await source.loadRoots(context());
    const answer = await source.probeAvailability!(root!, context());
    // One key, one request, and never a continuation token: the probe is a yes/no question.
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.url, /max-keys=1/);
    assert.doesNotMatch(calls[0]!.url, /continuation-token/);
    return answer;
  };

  // A bucket with objects directly under the prefix.
  assert.equal(
    await probeOf({ body: listing({ objects: [{ key: "reanalysis/a.nc" }] }) }),
    "available",
  );
  // A bucket whose contents are all one level down, which is the case `KeyCount` gets wrong.
  //
  // With a delimiter the gateway reports zero direct OBJECTS and returns the sub-prefixes instead.
  // A probe that trusted the count would label a full archive empty - and this is the exact shape
  // of a HEALPix bucket, where nothing sits at the top level at all.
  assert.equal(
    await probeOf({ body: listing({ prefixes: ["reanalysis/surface/"] }) }),
    "available",
  );
  // Nothing at all: the one case that may say so.
  assert.equal(await probeOf({ body: listing({}) }), "empty");

  // Every failure is "cannot tell". None of them may claim the bucket is empty.
  for (const reply of [
    { status: 403, body: "<Error><Code>AccessDenied</Code></Error>" },
    { status: 404 },
    { status: 500 },
    { body: "<html>nope</html>" },
    new TypeError("Failed to fetch"),
  ]) {
    assert.equal(
      await probeOf(reply),
      undefined,
      `a failure claimed an answer: ${JSON.stringify(reply)}`,
    );
  }
});

test("a planned root is never probed, never expandable, and costs no request", async () => {
  const { fetch, calls } = fakeFetch(() => ({ body: listing({}) }));
  const source = createS3Source({
    endpoint: ENDPOINT,
    roots: [
      { name: "Archive", bucket: "archive", prefix: "reanalysis/" },
      { name: "Future", bucket: "future", planned: "coming soon" },
    ],
    fetch,
  });
  const loaded = await source.loadRoots(context());
  const planned = loaded[1]!;

  assert.equal(planned.availability, "planned");
  assert.equal(planned.availabilityNote, "coming soon");
  // Declared unexpandable in the MODEL, so there is no window in which it looks openable while a
  // probe is deciding - the probe never runs for it either.
  assert.equal(planned.hasChildren, false);
  assert.equal(await source.probeAvailability!(planned, context()), undefined);
  assert.deepEqual(calls, [], "a planned root cost a request");
});

test("a root's project link is carried through, and is a link rather than an invented URL", async () => {
  const { fetch } = fakeFetch(() => ({ body: listing({}) }));
  const source = createS3Source({
    endpoint: ENDPOINT,
    roots: [
      {
        name: "Archive",
        bucket: "archive",
        link: { href: "https://example.org/project", label: "Project page" },
      },
    ],
    fetch,
  });
  const [root] = await source.loadRoots(context());
  assert.deepEqual(root!.link, { href: "https://example.org/project", label: "Project page" });
});
