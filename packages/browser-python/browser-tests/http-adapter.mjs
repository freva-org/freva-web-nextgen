/**
 * The browser HTTP filesystem, tested in Python against a fake fetcher. These run in a real
 * interpreter but need NO wheels and NO network: `browser_http`'s range arithmetic and status
 * handling import nothing but the standard library, precisely so the hardest part - off-by-one
 * ranges, a server that ignores Range, a 416 - is covered by a fast test rather than only by an
 * end-to-end Zarr read. The fsspec subclass is covered by the Zarr fixtures.
 */
import { fixturePage, inBrowser, report, requireDist, serve } from "./harness.mjs";
import { jsonFromPythonRepr, pythonJsonExpression } from "./py-json.mjs";

requireDist();

/**
 * A fake `pyfetch`. Records what it was asked for, so a test can assert on the REQUEST as well as
 * the response - "did it send the right Range header" is half of what is under test here.
 */
const FAKE = `
import sys
sys.path.insert(0, "/freva")
import browser_http as bh

class FakeChunk:
    def __init__(self, done, value):
        self.done = done
        self.value = value

class FakeStream:
    """The parts of a JS ReadableStream the adapter uses, and a record of what it did."""
    def __init__(self, chunks, owner):
        self.chunks = list(chunks)
        self.owner = owner
        self.delivered = 0
        self.cancelled = False
        self.locked = False
        self.released = 0
    def getReader(self):
        self.locked = True
        return self
    async def read(self):
        self.owner.reads += 1
        if not self.chunks:
            return FakeChunk(True, None)
        piece = self.chunks.pop(0)
        self.delivered += len(piece)
        return FakeChunk(False, piece)
    async def cancel(self):
        self.cancelled = True
    def releaseLock(self):
        self.locked = False
        self.released += 1

class _JS:
    def __init__(self, body):
        self.body = body

class FakeResponse:
    """A response whose body is ONLY available as a stream, which is what pyfetch gives.

    The chunks argument splits the body across reads; the default is one chunk. reads counts reads
    of the body through any route, so a test can prove a body was never touched, not assume it.
    """
    def __init__(self, status, body=b"", headers=None, chunks=None):
        self.status = status
        self._body = body
        self.headers = headers or {}
        self.reads = 0
        # Reads through the WHOLE-BODY route specifically, which a memory-bounded path must not use.
        self.whole_reads = 0
        self.stream = FakeStream(chunks if chunks is not None else ([body] if body else []), self)
        self.js_response = _JS(self.stream)
    async def bytes(self):
        self.reads += 1
        self.whole_reads += 1
        return self._body

class UnstreamableResponse(FakeResponse):
    """A response with no streaming reader at all - bytes() or nothing."""
    def __init__(self, status, body=b"", headers=None):
        FakeResponse.__init__(self, status, body, headers)
        self.js_response = None

class FakeFetcher:
    """Records calls and replays a queued script of responses."""
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []
    async def __call__(self, url, **options):
        self.calls.append({"url": url, "options": options})
        return self.responses.pop(0)

def header_of(fetcher, index=0):
    return fetcher.calls[index]["options"].get("headers", {}).get("Range")
`;

const result = await inBrowser(async (page) => {
  const server = await serve(fixturePage({ profile: "minimal" }));
  const checks = [];

  /** Run Python that ends in an expression, and return its repr. */
  const py = async (source) => {
    const r = await page.evaluate((code) => window.__py.run(code), source);
    if (r.error) throw new Error(r.error);
    return r;
  };
  /** Evaluate one expression through the console and return the repr. */
  const value = async (expression) => {
    const r = await page.evaluate((e) => window.__py.push(e), expression);
    if (r.error) throw new Error(r.error);
    // `repr()` around every expression, because a console correctly echoes NOTHING for None, so a
    // bare `None` would arrive as `undefined` and read as "the check did not run".
    return r.result;
  };
  const check = (name, actual, expected, extra) =>
    checks.push({
      name,
      pass: actual === expected,
      detail: extra ?? `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`,
    });

  try {
    await page.goto(server.url);
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });
    await page.evaluate(() => window.__py.start());
    await py(FAKE);

    // range construction
    check(
      "no range at all -> no Range header",
      await value("repr(bh.range_header(None, None))"),
      "'None'",
    );
    check("open-ended range", await value("bh.range_header(10, None)"), "'bytes=10-'");
    check(
      "a start with no explicit start",
      await value("bh.range_header(None, 100)"),
      "'bytes=0-99'",
    );

    // THE off-by-one. fsspec's end is exclusive; HTTP's is inclusive. Getting this wrong fetches
    // one byte too many, which for a Zarr chunk is a silently wrong array rather than an error.
    check(
      "fsspec's EXCLUSIVE end becomes an inclusive last byte",
      await value("bh.range_header(0, 100)"),
      "'bytes=0-99'",
    );
    check("a one-byte read", await value("bh.range_header(5, 6)"), "'bytes=5-5'");
    // A suffix request: the last N bytes, used to find a footer without knowing the length.
    check(
      "a negative start is a suffix range",
      await value("bh.range_header(-8, None)"),
      "'bytes=-8'",
    );
    await py(
      "try:\n    bh.range_header(-8, 100)\n    _negpair = 'no raise'\n" +
        "except bh.RangeUnsatisfiable as exc:\n    _negpair = str(exc)\n",
    );
    check(
      "…and an end alongside it is REFUSED, because that is not an HTTP range at all",
      // HTTP's only end-relative form is "the last N bytes", so `[-8:100]` cannot be expressed
      // as a range header; anything else has to be resolved against the object's size first, which
      // `fetch_bytes` does.
      String(/resolve it against the object size/.test(await value("_negpair"))),
      "true",
    );
    await py(
      "try:\n    bh.range_header(10, 10)\n    _empty = 'no raise'\nexcept bh.RangeUnsatisfiable:\n    _empty = 'raised'\n",
    );
    check(
      "an empty range (end == start) is refused, not requested",
      await value("_empty"),
      "'raised'",
    );

    // A 200 TO A RANGED REQUEST IS REFUSED: a server that ignores `Range` and answers 200 is
    // answering with THE WHOLE OBJECT. Slicing locally behind a `Content-Length` check is not a
    // memory bound - the header is absent on a chunked or compressed response, and absent means
    // "read it anyway", so a four-kilobyte chunk request answered by a two-gigabyte chunked 200
    // allocates two gigabytes and the tab dies over memory. `pyfetch` hands the body over whole,
    // so there is no reader to cap: refuse before reading.
    await py(`
r200 = FakeResponse(200, b"0123456789", {"content-length": "10"})
f200 = FakeFetcher([r200])
try:
    await bh.fetch_bytes("https://x/whole", 2, 5, fetcher=f200)
    _ignored = "no raise"
except OSError as exc:
    _ignored = str(exc)
`);
    check(
      "a 200 answering a Range request is refused, however small it claims to be",
      String(/ignored the Range header/.test(await value("_ignored"))),
      "true",
    );
    check(
      "…and the body was never read: the refusal is the memory bound",
      await value("r200.reads"),
      "0",
    );

    await py(`
f200nolen = FakeFetcher([FakeResponse(200, b"0123456789", {})])
try:
    await bh.fetch_bytes("https://x/whole", 2, 5, fetcher=f200nolen)
    _nolen = "no raise"
except OSError as exc:
    _nolen = str(exc)
`);
    check(
      "…including one with no Content-Length, which is where the old bound had a hole",
      String(/ignored the Range header/.test(await value("_nolen"))),
      "true",
    );

    await py(`
f200whole = FakeFetcher([FakeResponse(200, b"0123456789", {"content-length": "10"})])
_whole = await bh.fetch_bytes("https://x/whole", None, None, fetcher=f200whole)
`);
    check(
      "a request that asked for NO range still gets the whole object",
      await value("_whole"),
      "b'0123456789'",
    );

    // A 206 THAT STOPS SHORT OF WHAT WAS ASKED. `bytes=0-9` answered with `206 Content-Range:
    // bytes 0-4/100` and five bytes passes every individual check - header parses, start matches,
    // span no wider than requested, body length matches the span - and is still half a Zarr chunk,
    // decoded into an array that is quietly wrong. Short is only legitimate at the END, where the
    // total proves there was nothing more to send.
    await py(`
fshort = FakeFetcher([FakeResponse(206, b"01234", {"content-range": "bytes 0-4/100"})])
try:
    await bh.fetch_bytes("https://x/short", 0, 10, fetcher=fshort)
    _short = "no raise"
except OSError as exc:
    _short = str(exc)
`);
    check(
      "a 206 that stops short before the end of the object is refused",
      String(/short|incomplete/i.test(await value("_short"))),
      "true",
    );

    await py(`
ffinal = FakeFetcher([FakeResponse(206, b"01234", {"content-range": "bytes 95-99/100"})])
_final = await bh.fetch_bytes("https://x/final", 95, 105, fetcher=ffinal)
`);
    check(
      "…but a short LAST range is fine, because the total proves the object ends there",
      await value("_final"),
      "b'01234'",
    );

    // AN OPEN-ENDED RANGE THAT STOPS SHORT OF THE END. `bytes=10-` means "to the END OF THE
    // OBJECT", and a 206 answering with `Content-Range: bytes 10-19/100` is ninety bytes short -
    // yet every check written for BOUNDED ranges passes it, there being no requested last byte to
    // compare against. Zarr asks for open-ended ranges when a chunk's length is unknown, so the
    // proof required is the same: the reported total, and a last byte that reaches it.
    await py(`
fopen_short = FakeFetcher([FakeResponse(206, b"0123456789", {"content-range": "bytes 10-19/100"})])
try:
    await bh.fetch_bytes("https://x/open", 10, None, fetcher=fopen_short)
    _open_short = "no raise"
except OSError as exc:
    _open_short = str(exc)
`);
    check(
      "an open-ended range answered with only part of the rest of the object is refused",
      String(/does not reach the end|incomplete/i.test(await value("_open_short"))),
      "true",
    );

    await py(`
fopen_ok = FakeFetcher([FakeResponse(206, b"0123456789", {"content-range": "bytes 90-99/100"})])
_open_ok = await bh.fetch_bytes("https://x/open", 90, None, fetcher=fopen_ok)
`);
    check("…while one that does reach the end passes", await value("_open_ok"), "b'0123456789'");

    await py(`
fopen_nototal = FakeFetcher([FakeResponse(206, b"0123456789", {"content-range": "bytes 10-19/*"})])
try:
    await bh.fetch_bytes("https://x/open", 10, None, fetcher=fopen_nototal)
    _open_nototal = "no raise"
except OSError as exc:
    _open_nototal = str(exc)
`);
    check(
      "…and one whose total is unknown cannot be proven complete, so it is refused",
      String(/total|unknown|prove/i.test(await value("_open_nototal"))),
      "true",
    );

    // a SUFFIX range with nothing to prove it is the end
    await py(`
fsuffix_nototal = FakeFetcher([FakeResponse(206, b"abcdefgh", {"content-range": "bytes 92-99/*"})])
try:
    await bh.fetch_bytes("https://x/suffix", -8, None, fetcher=fsuffix_nototal)
    _suffix_nototal = "no raise"
except OSError as exc:
    _suffix_nototal = str(exc)
`);
    check(
      "a suffix range whose response will not say the total is refused, not assumed",
      String(/total|unknown|prove/i.test(await value("_suffix_nototal"))),
      "true",
    );

    await py(`
fsuffix_ok = FakeFetcher([FakeResponse(206, b"abcdefgh", {"content-range": "bytes 92-99/100"})])
_suffix_full = await bh.fetch_bytes("https://x/suffix", -8, None, fetcher=fsuffix_ok)
`);
    check(
      "…and one that names the total, and ends at it, passes",
      await value("_suffix_full"),
      "b'abcdefgh'",
    );

    // status mapping
    check("2xx is not a problem", await value("bh.describe_status('u', 206) is None"), "True");
    check(
      "404 is FileNotFoundError, because Zarr PROBES for optional keys",
      await value("type(bh.describe_status('u', 404)).__name__"),
      "'FileNotFoundError'",
    );
    check(
      "416 is its own thing, not a hard error",
      await value("type(bh.describe_status('u', 416)).__name__"),
      "'RangeUnsatisfiable'",
    );
    check(
      "anything else is a useful OSError",
      await value("type(bh.describe_status('u', 503)).__name__"),
      "'OSError'",
    );
    check(
      "…and it names the status and the URL",
      await value("str(bh.describe_status('https://x/y', 503))"),
      "'HTTP 503 for https://x/y'",
    );

    // the fetch path, against the fake
    await py(`
import asyncio
f206 = FakeFetcher([FakeResponse(206, b"chunk", {"content-range": "bytes 0-4/100"})])
_r206 = await bh.fetch_bytes("https://x/a", 0, 5, fetcher=f206)
`);
    check("a 206 body is returned as-is", await value("_r206"), "b'chunk'");
    check("…having sent the converted range", await value("header_of(f206)"), "'bytes=0-4'");

    // A 206 THAT ANSWERS A DIFFERENT RANGE than the one asked for; trusting the status code
    // alone is the asymmetry this closes. A caching proxy that coalesces or widens ranges, a
    // gateway that clamps a suffix range, or an intermediary serving a neighbouring slice from
    // cache all produce bytes of the right length and the wrong contents.
    await py(`
async def _refuses(url, start, end, status, body, headers):
    f = FakeFetcher([FakeResponse(status, body, headers)])
    try:
        await bh.fetch_bytes(url, start, end, fetcher=f)
    except OSError as exc:
        return str(exc)
    return None

_wrong_start = await _refuses("https://x/a", 0, 5, 206, b"chunk", {"content-range": "bytes 8-12/100"})
_too_wide = await _refuses("https://x/a", 0, 5, 206, b"0123456789", {"content-range": "bytes 0-9/100"})
_short = await _refuses("https://x/a", 0, 5, 206, b"abc", {"content-range": "bytes 0-4/100"})
_suffix_wrong = await _refuses("https://x/a", -8, None, 206, b"abcdefgh", {"content-range": "bytes 10-17/100"})

f_ok = FakeFetcher([FakeResponse(206, b"chunk", {"content-range": "bytes 0-4/100"})])
_matching = await bh.fetch_bytes("https://x/a", 0, 5, fetcher=f_ok)
f_suffix = FakeFetcher([FakeResponse(206, b"abcdefgh", {"content-range": "bytes 92-99/100"})])
_suffix_ok = await bh.fetch_bytes("https://x/a", -8, None, fetcher=f_suffix)
_bare = await _refuses("https://x/a", 0, 5, 206, b"chunk", None)

# --- negative slicing, which is Python's semantics and was not implemented ------------------
def _sized(body, ranged):
    """A fetcher that reports a size on HEAD and applies whatever Range it is given."""
    class _F:
        def __init__(self):
            self.headers = []
        async def __call__(self, url, **kw):
            header = (kw.get("headers") or {}).get("Range")
            self.headers.append(header)
            if header is None:
                return FakeResponse(200, body, {"content-length": str(len(body))})
            span = header.split("=", 1)[1]
            if span.startswith("-"):
                first, last = len(body) + int(span), len(body) - 1
            else:
                a, _, b = span.partition("-")
                first = int(a)
                last = len(body) - 1 if b == "" else int(b)
            chunk = body[first : last + 1]
            return FakeResponse(
                206,
                chunk,
                {"content-range": "bytes %d-%d/%d" % (first, last, len(body))},
            )
    return _F()

_body = b"0123456789"
_f1 = _sized(_body, True)
_neg_both = await bh.fetch_bytes("https://x/a", -5, -2, fetcher=_f1)
_f2 = _sized(_body, True)
_neg_end = await bh.fetch_bytes("https://x/a", None, -2, fetcher=_f2)
_f3 = _sized(_body, True)
_suffix = await bh.fetch_bytes("https://x/a", -3, None, fetcher=_f3)
_suffix_headers = _f3.headers

# --- a server that ignores Range and answers with something enormous ------------------------
_huge = FakeFetcher([FakeResponse(200, b"x" * 16, {"content-length": str(200 * 1024 * 1024)})])
try:
    await bh.fetch_bytes("https://x/big", 0, 4096, fetcher=_huge)
    _ignored = None
except OSError as exc:
    _ignored = str(exc)

# --- and the credentials every public request must carry -----------------------------------
class _Creds:
    def __init__(self):
        self.seen = None
    async def __call__(self, url, **kw):
        self.seen = kw.get("credentials")
        return FakeResponse(200, b"body")
_creds = _Creds()
await bh.fetch_bytes("https://x/a", None, None, fetcher=_creds)
_credentials = _creds.seen

# --- and on every probe as well, not just the byte GET --------------------------------------
class _CredsAll:
    """Records the credentials of every call, and forces the HEAD fallback by refusing HEAD."""
    def __init__(self):
        self.seen = []
    async def __call__(self, url, **kw):
        self.seen.append((kw.get("method", "GET"), kw.get("credentials")))
        if kw.get("method") == "HEAD":
            return FakeResponse(405)
        return FakeResponse(206, b"x", {"content-range": "bytes 0-0/99"})
_creds_all = _CredsAll()
await bh.head("https://x/a", fetcher=_creds_all)
_head_credentials = _creds_all.seen
`);
    check(
      "a 206 from a different offset is refused, not decoded",
      String(/different part of the object/.test(await value("_wrong_start"))),
      "true",
    );
    check(
      "a 206 wider than the request is refused",
      String(/wider than the requested/.test(await value("_too_wide"))),
      "true",
    );
    check(
      "a 206 whose body is shorter than its own Content-Range is refused",
      String(/but sent 3 bytes/.test(await value("_short"))),
      "true",
    );
    check(
      "a suffix range answered from the middle of the object is refused",
      String(/not the end of the object/.test(await value("_suffix_wrong"))),
      "true",
    );
    check("…while a matching 206 passes through", await value("_matching"), "b'chunk'");
    check("…and a correct suffix range passes through", await value("_suffix_ok"), "b'abcdefgh'");
    check(
      "a 206 with NO Content-Range is refused: there is no evidence of what it contains",
      // The header is required on a 206 by RFC 9110, and accepting a response without it means
      // accepting an arbitrary body as though it were the requested slice - which was the one way
      // past every other check.
      String(/without a usable Content-Range/.test(await value("_bare"))),
      "true",
    );

    // negative slicing is Python's slicing
    check(
      "start=-5, end=-2 returns the THREE bytes Python would",
      await value("_neg_both"),
      "b'567'",
    );
    check(
      "start=None, end=-2 returns everything but the last two",
      await value("_neg_end"),
      "b'01234567'",
    );
    check("a pure suffix stays a suffix range", await value("_suffix"), "b'789'");
    check(
      "…and is sent as one, without a size lookup first",
      await value("_suffix_headers"),
      "['bytes=-3']",
    );

    // a server that ignores Range, answering large
    check(
      "a huge 200 answering a range request is refused rather than materialised",
      String(/ignored the Range header/.test(await value("_ignored"))),
      "true",
    );
    check("public requests carry no credentials", await value("_credentials"), "'omit'");
    check(
      // A probe is a request like any other. The public adapter must never offer a portal's
      // cookies to a URL a visitor typed at the prompt - on the byte GET, the HEAD, or the ranged
      // GET the HEAD falls back to.
      "…and neither does a HEAD, nor the ranged GET it falls back to",
      await value("_head_credentials"),
      "[('HEAD', 'omit'), ('GET', 'omit')]",
    );

    await py(`
f416 = FakeFetcher([FakeResponse(416)])
_r416 = await bh.fetch_bytes("https://x/a", 1000, 2000, fetcher=f416)
`);
    check("416 reads as empty, not as a failure", await value("_r416"), "b''");

    await py(`
f404 = FakeFetcher([FakeResponse(404)])
try:
    await bh.fetch_bytes("https://x/missing", None, None, fetcher=f404)
    _r404 = "no raise"
except FileNotFoundError:
    _r404 = "FileNotFoundError"
`);
    check("404 raises FileNotFoundError", await value("_r404"), "'FileNotFoundError'");

    await py(`
f500 = FakeFetcher([FakeResponse(500)])
try:
    await bh.fetch_bytes("https://x/a", None, None, fetcher=f500)
    _r500 = "no raise"
except OSError as exc:
    _r500 = str(exc)
`);
    check("5xx raises a useful OSError", await value("_r500"), "'HTTP 500 for https://x/a'");

    await py(`
fnone = FakeFetcher([FakeResponse(200, b"whole")])
_rnone = await bh.fetch_bytes("https://x/a", None, None, fetcher=fnone)
_hnone = header_of(fnone)
`);
    check(
      "a whole-object read sends no Range header at all",
      await value("repr(_hnone)"),
      "'None'",
    );
    check("…and returns the whole body", await value("_rnone"), "b'whole'");

    // HEAD
    await py(`
fhead = FakeFetcher([FakeResponse(200, b"", {"content-length": "1234"})])
_head = await bh.head("https://x/a", fetcher=fhead)
_hm = fhead.calls[0]["options"].get("method")
`);
    check("HEAD reports existence and size", await value("_head"), "(True, 1234)");
    check("…using the HEAD method", await value("_hm"), "'HEAD'");

    await py(`
fnolen = FakeFetcher([FakeResponse(200, b"", {})])
_nolen = await bh.head("https://x/a", fetcher=fnolen)
`);
    check(
      "a missing Content-Length is None, not an error - it is normal for chunked responses",
      await value("_nolen"),
      "(True, None)",
    );

    await py(`
f404h = FakeFetcher([FakeResponse(404)])
_h404 = await bh.head("https://x/gone", fetcher=f404h)
`);
    check("HEAD on a missing object reports absence", await value("_h404"), "(False, None)");

    // The probe has to tell "not there" apart from "cannot be reached". Reporting everything
    // that is not a clean 2xx as (False, None) makes a CORS rejection, a 403, a 500 and an object
    // store that answers 405 to HEAD all read as "this key does not exist" - sending anyone
    // debugging it to check their URL when the problem is credentials, CORS setup, or the server.
    await py(`
f405 = FakeFetcher([FakeResponse(405), FakeResponse(206, b"x", {"content-range": "bytes 0-0/9876"})])
_h405 = await bh.head("https://x/a", fetcher=f405)
_m405 = [c["options"].get("method") for c in f405.calls]
_r405 = f405.calls[1]["options"].get("headers", {}).get("Range")
`);
    check(
      "a server that refuses HEAD falls back to a ranged GET instead of reporting absence",
      await value("_h405"),
      "(True, 9876)",
    );
    check("…which is a real GET", await value("_m405"), "['HEAD', 'GET']");
    check("…asking for exactly one byte", await value("_r405"), "'bytes=0-0'");

    await py(`
f206len = FakeFetcher([FakeResponse(405), FakeResponse(206, b"x", {"content-length": "1"})])
_h206len = await bh.head("https://x/a", fetcher=f206len)
`);
    check(
      "the size of a one-byte slice is not mistaken for the size of the object",
      await value("_h206len"),
      "(True, None)",
    );

    await py(`
class Boom:
    def __init__(self): self.calls = []
    async def __call__(self, url, **options):
        self.calls.append(options)
        raise RuntimeError("Failed to fetch")
fboom = Boom()
try:
    await bh.head("https://x/a", fetcher=fboom)
    _boom = "no error raised"
except OSError as e:
    _boom = "raised" if "not a missing object" in str(e) else "wrong message: " + str(e)
`);
    check(
      "a network or CORS failure is raised as an error, not reported as a missing object",
      await value("_boom"),
      "'raised'",
    );

    await py(`
f403 = FakeFetcher([FakeResponse(403), FakeResponse(403)])
try:
    await bh.head("https://x/a", fetcher=f403)
    _403 = "no error raised"
except OSError as e:
    _403 = "raised"
`);
    check("a 403 is an error, not an absence", await value("_403"), "'raised'");

    await py(`
f404b = FakeFetcher([FakeResponse(405), FakeResponse(404)])
_h404b = await bh.head("https://x/gone", fetcher=f404b)
`);
    check(
      "a genuine 404 is still an absence, even by the ranged-GET route",
      await value("_h404b"),
      "(False, None)",
    );

    check(
      "a garbage Content-Length is None rather than a crash",
      await value("repr(bh.content_length({'content-length': 'banana'}))"),
      "'None'",
    );

    // TWO HOLES ON THE SAME PATH, both ending with Zarr decoding the wrong bytes. Gating every
    // 206 check on `header is not None` lets a request that asked for NO range and got a 206 back
    // skip all of them, so `206 Content-Range: bytes 0-4/100` is accepted as the entire file; a
    // 206 to a request with no `Range` is a protocol violation whose only harmless form covers the
    // object end to end. And validation after `await response.bytes()` is not a memory bound, so
    // headers are judged first and the body read through a reader capped at the declared size.
    await py(`
def StreamingResponse(status, chunks, headers=None):
    """A response delivered across several reads. Every FakeResponse streams; this names chunks."""
    return FakeResponse(status, b"".join(chunks), headers, chunks=chunks)

r_unsolicited = FakeResponse(206, b"01234", {"content-range": "bytes 0-4/100"})
try:
    await bh.fetch_bytes("https://x/whole", None, None, fetcher=FakeFetcher([r_unsolicited]))
    _unsolicited = "no raise"
except OSError as exc:
    _unsolicited = str(exc)

r_full206 = FakeResponse(206, b"0123456789", {"content-range": "bytes 0-9/10"})
_full206 = await bh.fetch_bytes("https://x/whole", None, None, fetcher=FakeFetcher([r_full206]))

r_early = FakeResponse(206, b"chunk", {"content-range": "bytes 8-12/100"})
try:
    await bh.fetch_bytes("https://x/a", 0, 5, fetcher=FakeFetcher([r_early]))
    _early = "no raise"
except OSError as exc:
    _early = str(exc)

r_over = StreamingResponse(206, [b"0000", b"1111", b"2222"], {"content-range": "bytes 0-4/100"})
try:
    await bh.fetch_bytes("https://x/over", 0, 5, fetcher=FakeFetcher([r_over]))
    _over = "no raise"
except OSError as exc:
    _over = str(exc)

r_stream = StreamingResponse(206, [b"012", b"34"], {"content-range": "bytes 0-4/100"})
_streamed = await bh.fetch_bytes("https://x/ok", 0, 5, fetcher=FakeFetcher([r_stream]))
`);
    check(
      "a 206 answering a request that carried NO Range is refused when it is only part of the object",
      String(/partial|Content-Range/i.test(await value("_unsolicited"))),
      "true",
    );
    check(
      "…before the body is read, so an enormous unsolicited partial is never materialised",
      await value("r_unsolicited.reads"),
      "0",
    );
    check(
      "…while a 206 whose Content-Range covers the whole object is still the whole object",
      await value("_full206"),
      "b'0123456789'",
    );
    check(
      "a 206 whose Content-Range does not match the request is judged BEFORE the body is read",
      String(/different part of the object/.test(await value("_early"))),
      "true",
    );
    check("…and that body was never read either", await value("r_early.reads"), "0");
    check(
      "a body that runs past the bound this read is held to is refused",
      String(/bounded to|cancelled rather than accumulated/i.test(await value("_over"))),
      "true",
    );
    check(
      "…the stream is cancelled rather than drained",
      await value("r_over.stream.cancelled"),
      "True",
    );
    check(
      "…and it stopped at the first chunk past the cap, not at the end of the body",
      await value("r_over.stream.delivered"),
      "8",
    );
    check(
      "a well-behaved streamed body is read chunk by chunk and returned whole",
      await value("_streamed"),
      "b'01234'",
    );
    check("…without falling back to the whole-body read", await value("r_stream.whole_reads"), "0");
    check(
      "the docstring no longer contradicts the code about a missing Content-Range",
      String(/is not treated as a failure/.test(await value("bh.verify_content_range.__doc__"))),
      "false",
    );

    // `Content-Length` IS NOT A DECODED-BODY LIMIT, and using it as one is wrong in both
    // directions. Fetch hands Python the DECODED body while `Content-Length` describes the wire,
    // and it is CORS-safelisted so it is visible cross-origin, while `Content-Encoding` - the only
    // thing that says the two differ - is not. So the header a cross-origin reader can always see
    // is the one it must not trust, and capping on it refuses ordinary gzip responses, the normal
    // case for JSON metadata in a Zarr store. So: the wire length is ignored, a range response is
    // bounded by its VALIDATED `Content-Range` span, and a whole-object one by a decoded ceiling.
    await py(`
_ceiling = getattr(bh, "MAX_DECODED_BODY_BYTES", None)

# 1. A whole-object request answered 206 with a span it did not fill.
r_shortfull = FakeResponse(206, b"01234", {"content-range": "bytes 0-9/10"})
try:
    await bh.fetch_bytes("https://x/whole", None, None, fetcher=FakeFetcher([r_shortfull]))
    _shortfull = "no raise"
except OSError as exc:
    _shortfull = str(exc)

# 2. A perfectly ordinary gzip 200: wire length visible, encoding hidden, 1 KiB decoded.
r_gzip = FakeResponse(200, b"d" * 1024, {"content-length": "29"})
try:
    _gzip = len(await bh.fetch_bytes("https://x/meta.json", None, None, fetcher=FakeFetcher([r_gzip])))
except OSError as exc:
    _gzip = "raised: " + str(exc)

# 3. A RANGE answered with a visible non-identity encoding: byte offsets do not survive decoding.
r_encrange = FakeResponse(
    206, b"01234", {"content-range": "bytes 0-4/100", "content-encoding": "gzip"}
)
try:
    await bh.fetch_bytes("https://x/enc", 0, 5, fetcher=FakeFetcher([r_encrange]))
    _encrange = "no raise"
except OSError as exc:
    _encrange = str(exc)

# 4. The same, with the encoding hidden: the decoded stream simply overruns the validated span.
r_encover = StreamingResponse(
    206, [b"0000", b"1111", b"2222", b"3333"], {"content-range": "bytes 0-4/100"}
)
try:
    await bh.fetch_bytes("https://x/enc", 0, 5, fetcher=FakeFetcher([r_encover]))
    _encover = "no raise"
except OSError as exc:
    _encover = str(exc)

# 5. A whole-object response that just keeps sending, past the decoded ceiling.
_huge_chunk = b"x" * (1024 * 1024)
r_flood = StreamingResponse(200, [_huge_chunk] * 128, {})
try:
    await bh.fetch_bytes("https://x/flood", None, None, fetcher=FakeFetcher([r_flood]))
    _flood = "no raise"
except OSError as exc:
    _flood = str(exc)

# 6. Both sides of the validated span: one byte short, and one byte long.
r_short1 = FakeResponse(206, b"0123", {"content-range": "bytes 0-4/100"})
try:
    await bh.fetch_bytes("https://x/s", 0, 5, fetcher=FakeFetcher([r_short1]))
    _short1 = "no raise"
except OSError as exc:
    _short1 = str(exc)
r_long1 = FakeResponse(206, b"012345", {"content-range": "bytes 0-4/100"})
try:
    await bh.fetch_bytes("https://x/l", 0, 5, fetcher=FakeFetcher([r_long1]))
    _long1 = "no raise"
except OSError as exc:
    _long1 = str(exc)

# 7. The reader lock, on every exit: success, refusal and cancellation.
r_lockok = FakeResponse(206, b"01234", {"content-range": "bytes 0-4/100"})
await bh.fetch_bytes("https://x/lock", 0, 5, fetcher=FakeFetcher([r_lockok]))
_lock_ok = {"locked": r_lockok.stream.locked, "released": r_lockok.stream.released}
_lock_cancelled = {
    "locked": r_encover.stream.locked,
    "released": r_encover.stream.released,
    "cancelled": r_encover.stream.cancelled,
}

# And the path that must never silently fall back to a whole-body read.
r_nostream = UnstreamableResponse(206, b"01234", {"content-range": "bytes 0-4/100"})
try:
    await bh.fetch_bytes("https://x/nostream", 0, 5, fetcher=FakeFetcher([r_nostream]))
    _nostream = "no raise"
except OSError as exc:
    _nostream = str(exc)
_nostream_reads = r_nostream.whole_reads
`);
    check(
      "a whole-object request answered 206 with an unfilled span is refused, not returned short",
      String(/no raise/.test(await value("_shortfull")) === false),
      "true",
    );
    check(
      "an ordinary gzip 200 succeeds: Content-Length is the WIRE length and is not a decoded cap",
      await value("_gzip"),
      "1024",
    );
    check(
      "a RANGE answered with a visible non-identity Content-Encoding is refused before reading",
      String(/encod/i.test(await value("_encrange"))),
      "true",
    );
    check("…and the body of that refusal was never read", await value("r_encrange.reads"), "0");
    check(
      "a decoded stream that overruns the validated range span is cancelled",
      String(/span|declared|more bytes|cancel/i.test(await value("_encover"))),
      "true",
    );
    check(
      "…at the first chunk past the span, not at the end of the body",
      await value("r_encover.stream.delivered"),
      "8",
    );
    check(
      "a whole-object response past the decoded ceiling is cancelled, not accumulated",
      String(/ceiling|cap|too large|cancel/i.test(await value("_flood"))),
      "true",
    );
    check(
      "…having read only as far as the ceiling, not the whole 128 MiB",
      String((await value("r_flood.stream.delivered")) <= String(65 * 1024 * 1024)),
      "true",
    );
    check(
      "a body one byte SHORT of its validated Content-Range is refused",
      String(/no raise/.test(await value("_short1")) === false),
      "true",
    );
    check(
      "…and one byte LONG is refused too",
      String(/no raise/.test(await value("_long1")) === false),
      "true",
    );
    check(
      "the reader lock is released after a successful read",
      await value("_lock_ok"),
      "{'locked': False, 'released': 1}",
    );
    check(
      "…and after a cancellation",
      await value("_lock_cancelled"),
      "{'locked': False, 'released': 1, 'cancelled': True}",
    );
    check(
      "a memory-bounded read with no streaming reader REFUSES rather than reading the whole body",
      String(/stream|bounded|reader/i.test(await value("_nostream"))),
      "true",
    );
    check("…and really did not read it", await value("_nostream_reads"), "0");
    check(
      "the decoded ceiling is a documented constant, not a header-derived guess",
      String((await value("_ceiling")) === "67108864"),
      "true",
    );

    // THE HEAD FALLBACK MUST NOT BELIEVE WHAT IT IS TOLD. When HEAD fails, `head()` asks for
    // `bytes=0-0` - the smallest request that proves the object is readable - and must check the
    // range it got is the range it asked for before reading a TOTAL out of `Content-Range`, since
    // `206 Content-Range: bytes 5-5/100 -> (True, 100)` is a server whose ranges do not mean what
    // this adapter assumes. The other exit is a range-ignoring 200: accepting it and leaving its
    // BODY unread holds a live network transfer, and on this path that body is the whole object.
    await py(`
# 1. A fallback 206 that answers a byte nobody asked for.
class _NoHead:
    """Refuses HEAD, then replies with the scripted GET response."""
    def __init__(self, response):
        self.response = response
        self.calls = []
    async def __call__(self, url, **kw):
        self.calls.append((kw.get("method", "GET"), (kw.get("headers") or {}).get("Range")))
        if kw.get("method") == "HEAD":
            return FakeResponse(405)
        return self.response

f_wrongbyte = _NoHead(FakeResponse(206, b"x", {"content-range": "bytes 5-5/100"}))
try:
    _wrongbyte = repr(await bh.head("https://x/a", fetcher=f_wrongbyte))
except OSError as exc:
    _wrongbyte = "raised: " + str(exc)[:120]

f_rightbyte = _NoHead(FakeResponse(206, b"x", {"content-range": "bytes 0-0/100"}))
_rightbyte = repr(await bh.head("https://x/a", fetcher=f_rightbyte))

# 2. A range-ignoring 200 on the fallback path: the whole object, unasked for.
r_ignored = FakeResponse(200, b"0123456789", {"content-length": "10"})
f_ignored = _NoHead(r_ignored)
_ignored_head = repr(await bh.head("https://x/whole", fetcher=f_ignored))
_ignored_reads = r_ignored.whole_reads
_ignored_stream = {
    "locked": r_ignored.stream.locked,
    "released": r_ignored.stream.released,
    "cancelled": r_ignored.stream.cancelled,
    "delivered": r_ignored.stream.delivered,
}

# 3. Every header-only exit must let the body go, not leave a transfer live.
r_ok206 = FakeResponse(206, b"x", {"content-range": "bytes 0-0/100"})
await bh.head("https://x/a", fetcher=_NoHead(r_ok206))
_body206 = {"cancelled": r_ok206.stream.cancelled, "released": r_ok206.stream.released,
            "reads": r_ok206.whole_reads}

r_404 = FakeResponse(404, b"not found")
await bh.head("https://x/gone", fetcher=_NoHead(r_404))
_body404 = {"cancelled": r_404.stream.cancelled, "released": r_404.stream.released}

r_headok = FakeResponse(200, b"", {"content-length": "1234"})
class _HeadOk:
    def __init__(self, response):
        self.response = response
    async def __call__(self, url, **kw):
        return self.response
await bh.head("https://x/a", fetcher=_HeadOk(r_headok))
_bodyhead = {"cancelled": r_headok.stream.cancelled, "released": r_headok.stream.released}
`);
    check(
      "a fallback 206 that answers a byte nobody asked for does not become a size",
      String(/raised|None/.test(await value("_wrongbyte"))),
      "true",
    );
    check(
      "…while `bytes 0-0/100` - the range that WAS asked for - still reports the size",
      await value("_rightbyte"),
      "'(True, 100)'",
    );
    check(
      "a range-ignoring 200 on the probe path reports existence WITHOUT inventing a size",
      await value("_ignored_head"),
      "'(True, None)'",
    );
    check("…and its body was never read into memory", await value("_ignored_reads"), "0");
    check(
      "…and the transfer was cancelled and the reader released rather than left live",
      await value("_ignored_stream"),
      "{'locked': False, 'released': 1, 'cancelled': True, 'delivered': 0}",
    );
    check(
      "a successful ranged probe releases its body too",
      await value("_body206"),
      "{'cancelled': True, 'released': 1, 'reads': 0}",
    );
    check(
      "…so does a 404 on the probe path",
      await value("_body404"),
      "{'cancelled': True, 'released': 1}",
    );
    check(
      "…and so does a HEAD that succeeded",
      await value("_bodyhead"),
      "{'cancelled': True, 'released': 1}",
    );

    // A REFUSED RESPONSE IS A BODY SOMEBODY HAS TO LET GO. `fetch_bytes` refuses several
    // responses on their headers alone - a range-ignoring 200, a 206 that is not the slice asked
    // for, an encoded ranged response, a span above the decoded ceiling, a 404, a 416 - and an
    // undrained response goes on consuming the network for as long as the server keeps sending.
    // Every case below asserts four things: no chunk delivered, the body cancelled exactly once,
    // the reader lock released, and the DIAGNOSTIC unchanged.
    await py(`
async def _refused(url, start, end, response, **kw):
    """Run one refusal and report both the error and what happened to the body."""
    try:
        got = await bh.fetch_bytes(url, start, end, fetcher=FakeFetcher([response]), **kw)
        outcome = "returned " + repr(got)
    except OSError as exc:
        outcome = str(exc)
    import json as _json
    return _json.dumps({
        "outcome": outcome[:140],
        "delivered": response.stream.delivered,
        "cancelled": response.stream.cancelled,
        "locked": response.stream.locked,
        "released": response.stream.released,
        "whole_reads": response.whole_reads,
    })

_ignored200 = await _refused(
    "https://x/whole", 2, 5, FakeResponse(200, b"0123456789", {"content-length": "10"})
)
_wrong206 = await _refused(
    "https://x/a", 0, 5, FakeResponse(206, b"chunk", {"content-range": "bytes 8-12/100"})
)
_bare206 = await _refused("https://x/a", 0, 5, FakeResponse(206, b"chunk", None))
_encoded = await _refused(
    "https://x/enc",
    0,
    5,
    FakeResponse(206, b"01234", {"content-range": "bytes 0-4/100", "content-encoding": "gzip"}),
)
_toobig = await _refused(
    "https://x/big",
    0,
    None,
    FakeResponse(206, b"x", {"content-range": "bytes 0-4095/4096"}),
    max_bytes=16,
)
_not_found = await _refused("https://x/gone", 0, 5, FakeResponse(404, b"<html>gone</html>"))
_unsatisfiable = await _refused(
    "https://x/past", 0, 5, FakeResponse(416, b"<html>range</html>")
)
_server_error = await _refused("https://x/boom", 0, 5, FakeResponse(503, b"<html>busy</html>"))
_unsolicited = await _refused(
    "https://x/whole", None, None, FakeResponse(206, b"01234", {"content-range": "bytes 0-4/100"})
)
`);
    const refusal = async (name, expression, pattern) => {
      // JSON from Python, so an error message full of quotes and apostrophes cannot break the
      // parsing of the state around it.
      let parsed = null;
      let raw = "";
      try {
        raw = await value(expression);
        parsed = jsonFromPythonRepr(
          await value(pythonJsonExpression(`__import__("json").loads(${expression})`)),
        );
      } catch {
        parsed = null;
      }
      checks.push({
        name,
        pass: Boolean(
          parsed &&
          pattern.test(parsed.outcome) &&
          parsed.delivered === 0 &&
          parsed.cancelled === true &&
          parsed.locked === false &&
          parsed.released === 1 &&
          parsed.whole_reads === 0,
        ),
        detail: JSON.stringify(parsed ?? raw).slice(0, 190),
      });
    };
    await refusal(
      "a range-ignoring 200 is refused AND its body let go",
      "_ignored200",
      /ignored the Range header/,
    );
    await refusal(
      "a 206 for the wrong slice is refused AND its body let go",
      "_wrong206",
      /different part of the object/,
    );
    await refusal(
      "a 206 with no Content-Range is refused AND its body let go",
      "_bare206",
      /usable Content-Range/,
    );
    await refusal(
      "an encoded ranged response is refused AND its body let go",
      "_encoded",
      /Content-Encoding/,
    );
    await refusal(
      "a span above the ceiling is refused AND its body let go",
      "_toobig",
      /limit for a single response/,
    );
    await refusal(
      "a 404 is a FileNotFoundError AND its body is let go",
      "_not_found",
      /https:\/\/x\/gone/,
    );
    await refusal("a 416 returns nothing AND lets its body go", "_unsatisfiable", /^returned b/);
    await refusal("a 503 is an error AND its body is let go", "_server_error", /HTTP 503/);
    await refusal(
      "an unsolicited partial 206 is refused AND its body let go",
      "_unsolicited",
      /partial response nobody asked for/,
    );

    // AND A CONTENT-RANGE THAT CANNOT DESCRIBE AN OBJECT. `bytes 0-0/-1` parses, satisfies "the
    // byte I asked for", and becomes `(True, -1)` - a negative object size handed to fsspec, which
    // a reader then builds a chunk plan against. Nothing about a total is checked by the grammar:
    // it has to be checked by meaning.
    await py(`
class _NoHead:
    def __init__(self, response):
        self.response = response
    async def __call__(self, url, **kw):
        if kw.get("method") == "HEAD":
            return FakeResponse(405)
        return self.response

_neg = repr(await bh.head("https://x/a", fetcher=_NoHead(
    FakeResponse(206, b"x", {"content-range": "bytes 0-0/-1"}))))
_zero = repr(await bh.head("https://x/a", fetcher=_NoHead(
    FakeResponse(206, b"x", {"content-range": "bytes 0-0/0"}))))
_past = repr(await bh.head("https://x/a", fetcher=_NoHead(
    FakeResponse(206, b"x", {"content-range": "bytes 0-0/*"}))))
_sane = repr(await bh.head("https://x/a", fetcher=_NoHead(
    FakeResponse(206, b"x", {"content-range": "bytes 0-0/12345"}))))
_parse_neg = bh.parse_content_range({"content-range": "bytes 0-0/-1"})
_parse_inverted = bh.parse_content_range({"content-range": "bytes 9-2/100"})
_parse_past = bh.parse_content_range({"content-range": "bytes 0-500/100"})
_parse_negfirst = bh.parse_content_range({"content-range": "bytes -5-9/100"})
`);
    check("a negative total never becomes an object size", await value("_neg"), "'(True, None)'");
    check(
      "…nor does a total of zero that cannot contain the byte it just served",
      await value("_zero"),
      "'(True, None)'",
    );
    check("…while `*` is still an honest refusal to say", await value("_past"), "'(True, None)'");
    check("…and a sane total is still reported", await value("_sane"), "'(True, 12345)'");
    check("a negative total does not parse at all", await value("repr(_parse_neg)"), "'None'");
    check("nor does an inverted span", await value("repr(_parse_inverted)"), "'None'");
    check("nor does a span that runs past the total", await value("repr(_parse_past)"), "'None'");
    check("nor does a negative first byte", await value("repr(_parse_negfirst)"), "'None'");

    // The identity of a URL. Not strictly a pure helper, but the single most important line in
    // the adapter: fsspec's default `_strip_protocol` would leave `//host/key`, which cannot be
    // fetched.
    check(
      "_strip_protocol keeps the WHOLE url",
      await value("getattr(bh, '_probe_strip', None) or 'n/a'"),
      "'n/a'",
      "covered by the Zarr suite, where fsspec is present",
    );
    checks.pop(); // the placeholder above proves nothing; the Zarr suite owns this one.

    return checks;
  } finally {
    await server.close();
  }
});

process.exit(report("browser HTTP filesystem (pure helpers, faked fetch)", result));
