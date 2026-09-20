/**
 * The fsspec subclass itself, against a real HTTP server. `http-adapter.mjs` covers the pure
 * range/status helpers with a faked fetch; this covers the class fsspec actually instantiates,
 * against the committed Zarr fixtures, and needs only the `fsspec` wheel rather than a suite that
 * needs numpy.
 */
import { Buffer } from "node:buffer";
import { gzipSync } from "node:zlib";
import {
  fixturePage,
  inBrowser,
  report,
  requireDist,
  requireRuntimeFor,
  serve,
} from "./harness.mjs";

requireDist();

requireRuntimeFor("fsspec adapter (real fetch)", "fsspec-adapter.mjs");

/**
 * A CROSS-ORIGIN GZIP SERVICE, where `Content-Encoding` really is hidden - by the browser, not by
 * filtering a header dictionary: it is not CORS-safelisted and this service does not expose it.
 * `Content-Length` IS safelisted, so it stays visible and describes the COMPRESSED bytes while the
 * body Python receives is decompressed. `/gzip-exposed.json` exposes the coding, so a range request
 * against it can be refused for the right reason.
 */
const gzipService = (body, seen) => {
  const packed = gzipSync(Buffer.from(body));
  return (req, res, url) => {
    if (url.pathname === "/gzip.json" || url.pathname === "/gzip-exposed.json") {
      seen.push({ method: req.method, path: url.pathname, range: req.headers.range ?? null });
    }
    if (url.pathname !== "/gzip.json" && url.pathname !== "/gzip-exposed.json") return false;
    const exposed = url.pathname === "/gzip-exposed.json";
    if (req.method === "OPTIONS") {
      // A `Range` header makes a cross-origin GET non-simple, so the browser preflights it. Without
      // this the ranged checks below would fail as "Failed to fetch" and prove nothing.
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "range",
        "access-control-allow-methods": "GET, HEAD, OPTIONS",
        "access-control-max-age": "60",
      });
      res.end();
      return true;
    }
    const headers = {
      "content-type": "application/json",
      "content-encoding": "gzip",
      "content-length": String(packed.length),
      "access-control-allow-origin": "*",
      "accept-ranges": "bytes",
      ...(exposed
        ? { "access-control-expose-headers": "Content-Encoding, Content-Range, Content-Length" }
        : { "access-control-expose-headers": "Content-Range" }),
    };
    if (req.headers.range) {
      // A 206 whose `Content-Range` names a sub-range of the ENCODED representation, with the
      // coding still applied. The body is the COMPLETE gzip stream rather than a slice, because a
      // slice of one is not a gzip stream and the browser would fail to decode it - testing its
      // decompressor rather than this adapter.
      const span = /bytes=(\d+)-(\d+)/.exec(req.headers.range);
      const first = span ? Number(span[1]) : 0;
      const last = span ? Number(span[2]) : packed.length - 1;
      // No `Content-Length`: it would have to agree with either the span or the body, and it
      // cannot do both. Chunked is what a server applying a coding on the fly sends anyway.
      const ranged = { ...headers, "content-range": `bytes ${first}-${last}/${packed.length}` };
      delete ranged["content-length"];
      res.writeHead(206, ranged);
      res.end(packed);
      return true;
    }
    res.writeHead(200, headers);
    res.end(packed);
    return true;
  };
};

/** 4 KiB of highly compressible JSON: a metadata document, as a Zarr store really serves one. */
const GZIP_BODY = JSON.stringify({ zarr_format: 2, filler: "a".repeat(4000) });

const result = await inBrowser(async (page) => {
  const gzipSeen = [];
  const gzip = await serve("", { handle: gzipService(GZIP_BODY, gzipSeen) });
  const gzipOrigin = gzip.url.replace(/\/$/, "");
  const server = await serve(fixturePage({ profile: "minimal", packages: ["fsspec"] }));
  const checks = [];
  const value = async (expression) => {
    const r = await page.evaluate((e) => window.__py.push(e), expression);
    if (r.error) throw new Error(r.error);
    return r.result;
  };
  const run = async (code) => {
    const r = await page.evaluate((c) => window.__py.run(c), code);
    if (r.error) throw new Error(r.error);
    return r;
  };
  const check = (name, actual, expected, detail) =>
    checks.push({ name, pass: actual === expected, detail: detail ?? `${actual}` });

  try {
    await page.goto(server.url);
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
    await page.evaluate(() => window.__py.start());

    await run("import _freva_bridge\n_freva_bridge.install_browser_http()\nimport fsspec\n");
    check(
      "registered for https",
      await value("fsspec.get_filesystem_class('https').__name__"),
      "'BrowserHTTPFileSystem'",
    );
    check(
      "…and for http, because a store's own metadata may name either",
      await value("fsspec.get_filesystem_class('http').__name__"),
      "'BrowserHTTPFileSystem'",
    );

    // The single most consequential line in the adapter. fsspec's default would leave `//host/key`.
    check(
      "_strip_protocol keeps the whole URL, scheme included",
      await value("fsspec.get_filesystem_class('https')._strip_protocol('https://h/a/b')"),
      "'https://h/a/b'",
    );
    check(
      "…and maps over a list unchanged",
      await value("fsspec.get_filesystem_class('https')._strip_protocol(['https://h/a'])"),
      "['https://h/a']",
    );

    // Storage options people paste from an s3fs or gcsfs example. Meaningless for public HTTP, but
    // rejecting them would fail a familiar snippet for a reason unrelated to the data.
    await run("fs = fsspec.filesystem('https', anon=True, token=None)\n");
    check(
      "`anon` and `token` are accepted and ignored",
      await value("type(fs).__name__"),
      "'BrowserHTTPFileSystem'",
    );

    // Real reads, against the committed fixture, through the browser's own Fetch.
    await page.evaluate(async () => {
      const url = new URL("/fixtures/zarr-v2/.zgroup", location.href).href;
      await window.__py.run(
        `meta_url = ${JSON.stringify(url)}\n_whole = await fs._cat_file(meta_url)\n`,
      );
    });
    check(
      "_cat_file fetches a real object",
      await value("_whole.decode().startswith('{')"),
      "True",
      await value("_whole.decode()[:20]"),
    );
    check("…the whole of it", await value("len(_whole) > 20"), "True", await value("len(_whole)"));

    await run("_ranged = await fs._cat_file(meta_url, start=0, end=5)\n");
    check(
      "…and honours an exclusive end: 5 bytes for [0, 5), not 6",
      await value("_ranged == _whole[:5]"),
      "True",
      await value("_ranged"),
    );
    check("…which is exactly five bytes", await value("len(_ranged)"), "5");

    await run("_tail = await fs._cat_file(meta_url, start=-3, end=None)\n");
    check(
      "…and a suffix range returns the LAST bytes",
      await value("_tail == _whole[-3:]"),
      "True",
      await value("_tail"),
    );

    await run("_info = await fs._info(meta_url)\n");
    check("_info reports a file", await value("_info['type']"), "'file'");
    check(
      "…with the size the server advertised",
      await value("_info['size'] == len(_whole)"),
      "True",
    );
    check("_exists is True for a real key", await value("await fs._exists(meta_url)"), "True");

    await page.evaluate(async () => {
      const url = new URL("/fixtures/zarr-v2/not-a-key", location.href).href;
      await window.__py.run(
        `missing_url = ${JSON.stringify(url)}\n` +
          `_missing_exists = await fs._exists(missing_url)\n` +
          `try:\n    await fs._cat_file(missing_url)\n    _missing = "returned"\n` +
          `except FileNotFoundError:\n    _missing = "FileNotFoundError"\n`,
      );
    });
    check("_exists is False for a missing key", await value("_missing_exists"), "False");
    check(
      "a missing key raises FileNotFoundError, which is what Zarr's probes expect",
      await value("_missing"),
      "'FileNotFoundError'",
    );

    // Refused, not faked. An empty list would read as "this prefix is empty" and silently produce
    // an empty dataset.
    await run(
      "try:\n    await fs._ls(meta_url)\n    _ls = 'returned'\n" +
        "except NotImplementedError as exc:\n    _ls = 'refused: ' + str(exc)[:40]\n",
    );
    check(
      "_ls refuses rather than returning an empty list",
      (await value("_ls")).startsWith("'refused"),
      true,
      await value("_ls"),
    );
    await run(
      "try:\n    await fs._find(meta_url)\n    _find = 'returned'\n" +
        "except NotImplementedError:\n    _find = 'refused'\n",
    );
    check("_find likewise", await value("_find"), "'refused'");

    // Read-only means read-only, and says so.
    await run(
      "try:\n    await fs._pipe_file(meta_url, b'x')\n    _write = 'allowed'\n" +
        "except PermissionError:\n    _write = 'PermissionError'\n",
    );
    check("writes are refused with PermissionError", await value("_write"), "'PermissionError'");

    // The recording: which request/response pairs were ACCEPTED, as the server saw them. The rules
    // are about the RELATIONSHIP between a request and its response, and asserting them in
    // isolation cannot show that a real server answering real reads satisfies them.
    const ranged = server.exchanges.filter((e) => e.range !== null);
    check(
      "every accepted ranged read was answered 206 with a Content-Range naming a total",
      String(
        ranged.length > 0 &&
          ranged.every(
            (e) => e.status === 206 && /^bytes \d+-\d+\/\d+$/.test(e.contentRange ?? ""),
          ),
      ),
      "true",
      JSON.stringify(ranged.map((e) => `${e.range} -> ${e.status} ${e.contentRange}`)),
    );
    check(
      "…and a suffix read really was answered from the end of the object",
      String(
        ranged.some((e) => {
          if (!e.range?.startsWith("bytes=-")) return false;
          const [, last, total] = /bytes \d+-(\d+)\/(\d+)/.exec(e.contentRange ?? "") ?? [];
          return Number(last) === Number(total) - 1;
        }),
      ),
      "true",
      JSON.stringify(ranged.filter((e) => e.range?.startsWith("bytes=-"))),
    );

    // A genuinely hidden Content-Encoding, from a real browser. The gzip service is a SECOND
    // ORIGIN, so the browser applies CORS response-header filtering itself: nothing here edits a
    // header dictionary, and what Python can see is what the browser decided it may see.
    await run(`
import json, browser_http as bh
seen = {}
whole = await bh.fetch_bytes("${gzipOrigin}/gzip.json", None, None)
seen["decoded"] = len(whole)
seen["wire"] = int((await bh.head("${gzipOrigin}/gzip.json"))[1] or 0)
seen["parsed"] = json.loads(whole.decode())["zarr_format"]
try:
    await bh.fetch_bytes("${gzipOrigin}/gzip-exposed.json", 0, 16)
    seen["ranged_exposed"] = "no raise"
except OSError as exc:
    seen["ranged_exposed"] = str(exc)[:120]
try:
    await bh.fetch_bytes("${gzipOrigin}/gzip.json", 0, 16)
    seen["ranged_hidden"] = "no raise"
except OSError as exc:
    seen["ranged_hidden"] = str(exc)[:120]
_gz = json.dumps(seen)
`);
    // `value()` hands back a Python repr; for a str of JSON that is the JSON in single quotes.
    const repr = await value("_gz");
    const gzResult = JSON.parse(repr.slice(1, -1));
    checks.push({
      name: "a cross-origin gzip response decodes to its full length, not to Content-Length",
      pass: gzResult.decoded === GZIP_BODY.length && gzResult.parsed === 2,
      detail: JSON.stringify({
        decoded: gzResult.decoded,
        expected: GZIP_BODY.length,
        wire: gzip.exchanges.find((e) => e.path === "/gzip.json")?.status,
      }),
    });
    checks.push({
      name: "…proving Content-Length was the WIRE length all along",
      pass: gzResult.decoded > (gzResult.wire ?? Infinity),
      detail: JSON.stringify({ wire: gzResult.wire, decoded: gzResult.decoded }),
    });
    // AND A BROWSER BEHAVIOUR WORTH RECORDING, because it decides how much of the encoded-range
    // problem can reach this code. Chromium refuses a cross-origin 206 carrying a content coding
    // outright, exposed or not, so the adapter's own refusal is a second line rather than the only
    // one.
    checks.push({
      name: "a cross-origin 206 carrying a content coding never reaches Python: the browser refuses it",
      pass:
        /no raise/.test(gzResult.ranged_hidden) === false &&
        /no raise/.test(gzResult.ranged_exposed) === false,
      detail: JSON.stringify({
        hidden: gzResult.ranged_hidden,
        exposed: gzResult.ranged_exposed,
        requests: gzipSeen.filter((e) => e.range).map((e) => `${e.path} ${e.range}`),
      }),
    });

    // The HEAD fallback, against a real server that refuses HEAD. The unit-level version can
    // present any header combination but cannot show that a browser actually refuses HEAD the way
    // an object store does, or that the fallback GET really carries `Range: bytes=0-0`.
    const probeSeen = [];
    const probe = await serve("", {
      handle: (req, res, url) => {
        if (!url.pathname.startsWith("/probe/")) return false;
        probeSeen.push({
          method: req.method,
          path: url.pathname,
          range: req.headers.range ?? null,
        });
        const cors = {
          "access-control-allow-origin": "*",
          "access-control-expose-headers": "Content-Range, Content-Length",
          "accept-ranges": "bytes",
        };
        if (req.method === "HEAD") {
          res.writeHead(405, cors);
          res.end();
          return true;
        }
        if (url.pathname === "/probe/honest") {
          res.writeHead(206, {
            ...cors,
            "content-range": "bytes 0-0/1000",
            "content-type": "application/octet-stream",
          });
          res.end(Buffer.from([0x41]));
          return true;
        }
        if (url.pathname === "/probe/wrong-byte") {
          // The defect, served for real: a different single byte, with a total attached.
          res.writeHead(206, { ...cors, "content-range": "bytes 5-5/1000" });
          res.end(Buffer.from([0x42]));
          return true;
        }
        if (url.pathname === "/probe/ignores-range") {
          // Ignores `Range` entirely and sends the whole object, all 64 KiB of it.
          const body = Buffer.alloc(64 * 1024, 0x43);
          res.writeHead(200, { ...cors, "content-length": String(body.length) });
          res.end(body);
          return true;
        }
        res.writeHead(404, cors);
        res.end();
        return true;
      },
    });
    const probeOrigin = probe.url.replace(/\/$/, "");
    try {
      await run(`
import json, browser_http as bh
out = {}
out["honest"] = list(await bh.head("${probeOrigin}/probe/honest"))
out["wrong_byte"] = list(await bh.head("${probeOrigin}/probe/wrong-byte"))
out["ignores_range"] = list(await bh.head("${probeOrigin}/probe/ignores-range"))
out["missing"] = list(await bh.head("${probeOrigin}/probe/nothing-here"))
_probe = json.dumps(out)
`);
      const probed = JSON.parse((await value("_probe")).slice(1, -1));
      checks.push({
        name: "a real server that refuses HEAD is probed with Range: bytes=0-0",
        pass:
          probeSeen.some((e) => e.method === "HEAD") &&
          probeSeen.some((e) => e.range === "bytes=0-0"),
        detail: JSON.stringify(probeSeen.slice(0, 4)),
      });
      checks.push({
        name: "…an honest `bytes 0-0/1000` gives existence AND the size",
        pass: probed.honest?.[0] === true && probed.honest?.[1] === 1000,
        detail: JSON.stringify(probed.honest),
      });
      checks.push({
        name: "…a real `bytes 5-5/1000` gives existence but NOT a size taken from it",
        pass: probed.wrong_byte?.[0] === true && probed.wrong_byte?.[1] === null,
        detail: JSON.stringify(probed.wrong_byte),
      });
      checks.push({
        name: "…a server that ignores Range gives existence and no invented size either",
        pass: probed.ignores_range?.[0] === true && probed.ignores_range?.[1] === null,
        detail: JSON.stringify(probed.ignores_range),
      });
      checks.push({
        name: "…and a genuinely missing object is still an absence",
        pass: probed.missing?.[0] === false,
        detail: JSON.stringify(probed.missing),
      });
    } finally {
      await probe.close();
    }

    // Refusals against a REAL server, with real bodies to leave behind. Each route below returns a
    // body large enough that draining it would be visible, and the check is that the reader never
    // reads any of it and the refusal keeps its reason.
    const refuseSeen = [];
    const refuser = await serve("", {
      handle: (req, res, url) => {
        if (!url.pathname.startsWith("/refuse/")) return false;
        refuseSeen.push({ path: url.pathname, range: req.headers.range ?? null });
        const cors = {
          "access-control-allow-origin": "*",
          "access-control-expose-headers": "Content-Range, Content-Length",
          "accept-ranges": "bytes",
        };
        const big = Buffer.alloc(256 * 1024, 0x5a);
        if (url.pathname === "/refuse/ignores-range") {
          res.writeHead(200, { ...cors, "content-length": String(big.length) });
          res.end(big);
          return true;
        }
        if (url.pathname === "/refuse/wrong-slice") {
          res.writeHead(206, { ...cors, "content-range": "bytes 900-999/100000" });
          res.end(Buffer.alloc(100, 0x5a));
          return true;
        }
        if (url.pathname === "/refuse/negative-total") {
          res.writeHead(206, { ...cors, "content-range": "bytes 0-0/-1" });
          res.end(Buffer.from([0x5a]));
          return true;
        }
        if (url.pathname === "/refuse/gone") {
          res.writeHead(404, { ...cors });
          res.end(big);
          return true;
        }
        res.writeHead(503, { ...cors });
        res.end(big);
        return true;
      },
    });
    const refuseOrigin = refuser.url.replace(/\/$/, "");
    try {
      await run(`
import json, browser_http as bh
out = {}
async def _try(path, start, end):
    try:
        got = await bh.fetch_bytes("${refuseOrigin}" + path, start, end)
        return "returned " + str(len(got)) + " bytes"
    except OSError as exc:
        return str(exc)[:90]
out["ignores_range"] = await _try("/refuse/ignores-range", 0, 16)
out["wrong_slice"] = await _try("/refuse/wrong-slice", 0, 16)
out["gone"] = await _try("/refuse/gone", 0, 16)
out["busy"] = await _try("/refuse/busy", 0, 16)
out["negative_total_head"] = list(await bh.head("${refuseOrigin}/refuse/negative-total"))
_refuse = json.dumps(out)
`);
      const refused = JSON.parse((await value("_refuse")).slice(1, -1));
      checks.push({
        name: "a real range-ignoring 200 is refused rather than downloaded",
        pass: /ignored the Range header/.test(refused.ignores_range ?? ""),
        detail: refused.ignores_range,
      });
      checks.push({
        name: "…a real 206 for the wrong slice is refused, with its reason intact",
        pass: /answered 206 starting at byte 900/.test(refused.wrong_slice ?? ""),
        detail: refused.wrong_slice,
      });
      checks.push({
        name: "…a real 404 carrying a body is still FileNotFoundError",
        pass: /refuse\/gone/.test(refused.gone ?? ""),
        detail: refused.gone,
      });
      checks.push({
        name: "…and a real 503 carrying a body is still an HTTP error",
        pass: /HTTP 503/.test(refused.busy ?? ""),
        detail: refused.busy,
      });
      checks.push({
        name: "a real `Content-Range: bytes 0-0/-1` never becomes a negative object size",
        pass:
          refused.negative_total_head?.[0] === true && refused.negative_total_head?.[1] === null,
        detail: JSON.stringify(refused.negative_total_head),
      });
    } finally {
      await refuser.close();
    }

    return checks;
  } finally {
    await gzip.close();
    await server.close();
  }
});

process.exit(report("fsspec adapter (real fetch)", result));
