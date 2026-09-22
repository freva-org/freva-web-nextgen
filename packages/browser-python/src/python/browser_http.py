"""A read-only fsspec filesystem backed by the browser's own Fetch, for remote Zarr.

Why this exists
---------------
``xr.open_zarr("https://...")`` works by asking fsspec for an ``https`` filesystem. fsspec's own
HTTP implementation is built on aiohttp, which does not exist in Emscripten, so without this the
familiar one-line xarray call simply fails in a browser. Registering a Fetch-backed implementation
under the same two protocol names is what keeps the API people already know: nobody has to import
Zarr-Python internals, and nobody has to learn a JavaScript Zarr library.

Shape of this module
--------------------
The pure functions come FIRST and import nothing but the standard library. Everything about what an
HTTP range means, how an exclusive end becomes an inclusive one, and what a 200/404/416 implies is
in them - so that behaviour is testable in an interpreter with no fsspec, no aiohttp and no network,
which is exactly what the browser suite does. The fsspec subclass is built inside ``install()`` and
is only the adapter between those functions and the interface fsspec wants.

Scope, stated plainly: public HTTPS, CORS-enabled, read-only, no credentials. See the README.
"""

from __future__ import annotations

# --------------------------------------------------------------------------- pure helpers


class RangeUnsatisfiable(Exception):
    """The requested range cannot contain bytes. Callers return b"" rather than erroring."""


def needs_size(start, end):
    """True when the requested slice cannot be expressed as an HTTP range without the size.

    A negative bound counts from the END of the object, and HTTP has exactly one form for that: a
    suffix range, which means "the last N bytes" and nothing else. So ``[-5:]`` maps faithfully and
    ``[-5:-2]`` and ``[:-2]`` do not - they need the object's length before they can be turned into
    an absolute range, which is why `fetch_bytes` looks it up rather than approximating.
    """
    if start is not None and start < 0:
        return end is not None
    return end is not None and end < 0


def normalise_slice(start, end, size):
    """Resolve a Python-style ``[start:end]`` against a known ``size`` into absolute bounds.

    Exactly `slice(start, end).indices(size)` semantics, which is what fsspec callers mean by
    ``_cat_file(path, start, end)`` - and what the previous implementation did not do: a negative
    ``end`` was compared against a non-negative ``start`` and rejected as unsatisfiable, so
    ``[:-2]`` returned nothing at all, and ``[-5:-2]`` fetched the last five bytes instead of the
    three that were asked for.
    """
    begin, stop, _ = slice(start, end).indices(int(size))
    return begin, max(begin, stop)


def range_header(start, end):
    """Build a ``Range`` header value for an fsspec-style ``[start, end)`` request.

    Two conversions live here and both are off-by-one traps:

    * fsspec's ``end`` is EXCLUSIVE; the HTTP ``Range`` unit is INCLUSIVE. Requesting
      ``bytes=0-100`` for ``end=100`` fetches 101 bytes, and for a Zarr chunk that is a silently
      corrupt array rather than an error.
    * a NEGATIVE ``start`` with no ``end`` is a suffix request - the last N bytes. Zarr v2 readers
      use it to find a footer without knowing the object's length first, and it is the ONE negative
      form HTTP can express faithfully.

    Anything else with a negative bound must be resolved against the object's size first; callers
    use `needs_size` and `normalise_slice` for that. Returns ``None`` when the whole object is
    wanted, and raises ``RangeUnsatisfiable`` for a range that cannot contain a byte.
    """
    if start is None and end is None:
        return None
    if start is not None and start < 0:
        if end is not None:
            raise RangeUnsatisfiable(
                "a negative start with an end (%r, %r) is not an HTTP range; resolve it against "
                "the object size first" % (start, end)
            )
        return "bytes=%d" % start
    if end is not None and end < 0:
        raise RangeUnsatisfiable(
            "a negative end (%r) is not an HTTP range; resolve it against the object size first"
            % (end,)
        )
    begin = 0 if start is None else int(start)
    if end is None:
        return "bytes=%d-" % begin
    last = int(end) - 1  # exclusive -> inclusive
    if last < begin:
        raise RangeUnsatisfiable("end (%r) is not after start (%r)" % (end, start))
    return "bytes=%d-%d" % (begin, last)


#: The most DECODED bytes `fetch_bytes` will accumulate for a single response.
#:
#: THREE DIFFERENT QUANTITIES, and this is the third of them.
#:
#: * the WIRE length is what `Content-Length` describes: bytes as transmitted, possibly compressed;
#: * the RANGE length is what an accepted `Content-Range` span describes, in the coordinates of the
#:   selected representation;
#: * the DECODED length is what Python actually receives, because Fetch decodes the body before
#:   anyone here sees it.
#:
#: Only the third is a memory bound, and no header states it. `Content-Length` cannot stand in for
#: it: it is a CORS-SAFELISTED response header, so a cross-origin reader can always see it, while
#: `Content-Encoding` - the only header that says the two differ - is NOT safelisted and is
#: invisible unless the server opts in with `Access-Control-Expose-Headers`. The header always
#: available is the one that must not be trusted; the one needed is the one usually absent. Capping
#: the decoded body at `Content-Length` therefore refused ordinary gzip responses, which is the
#: normal case for the JSON metadata in a Zarr store.
#:
#: So a whole-object read is bounded HERE, by a number this module chose and documents, rather than
#: by anything the server said. 64 MiB is far beyond any metadata document or chunk a reader asks
#: for, and small enough that one arriving by accident does not end the tab.
#:
#: HONESTLY: one accepted response is materialised in Python. Memory on this path is bounded by
#: this cap - or by an accepted range's own span, which is smaller - and is NOT constant at one
#: network chunk. `streamArtifact` is the constant-memory path; this is the bounded one.
MAX_DECODED_BODY_BYTES = 64 * 1024 * 1024

#: How large an ignored-Range 200 may be before it is refused rather than read into memory.
#:
#: 64 MiB is far beyond any chunk a Zarr reader asks for and small enough that materialising one by
#: accident does not end the tab. A server that ignores Range cannot back a chunked store at all,
#: so this is a diagnosis rather than a limit anyone should be tuning.
MAX_IGNORED_RANGE_BYTES = 64 * 1024 * 1024


def content_length(headers):
    """``Content-Length`` as an int, or ``None`` when the server does not say.

    Absent is normal and not an error: a chunked or compressed response legitimately has no length,
    and fsspec accepts ``None`` for an unknown size.
    """
    if not headers:
        return None
    for key in ("content-length", "Content-Length"):
        raw = headers.get(key) if hasattr(headers, "get") else None
        if raw is None:
            continue
        try:
            return int(raw)
        except (TypeError, ValueError):
            return None
    return None


def describe_status(url, status):
    """Map a non-2xx status to the exception fsspec and Zarr expect, or ``None`` if it is fine.

    404 must be ``FileNotFoundError`` specifically: Zarr PROBES for optional keys - a v3 store asks
    for ``zarr.json``, a consolidated reader asks for ``.zmetadata`` - and treats "missing" as a
    normal answer. Raising a generic ``OSError`` there turns an ordinary absent key into a failed
    open, which is how a store that would otherwise work reports itself as broken.
    """
    if 200 <= status < 300:
        return None
    if status == 404:
        return FileNotFoundError(url)
    if status == 416:
        return RangeUnsatisfiable(url)
    return OSError("HTTP %d for %s" % (status, url))


# --------------------------------------------------------------------------- the fetch path


async def fetch_bytes(url, start=None, end=None, fetcher=None, max_bytes=None):
    """GET ``url``, honouring an fsspec-style ``[start, end)`` range.

    ``fetcher`` is injectable so this whole path can be exercised against a fake in a test with no
    network. In the browser it defaults to ``pyodide.http.pyfetch``.

    ``max_bytes`` is the DECODED ceiling for a whole-object read, defaulting to
    `MAX_DECODED_BODY_BYTES`. An accepted range response is bounded by its own validated span
    instead, which is always the smaller of the two.
    """
    if fetcher is None:
        from pyodide.http import pyfetch  # imported lazily: the pure helpers must work without it

        fetcher = pyfetch

    if needs_size(start, end):
        """
        A negative bound with another bound cannot be an HTTP range.

        `[-5:-2]` and `[:-2]` mean "counted from the end", and HTTP's only end-relative form is a
        suffix range - "the last N bytes" - which is a different request. So the size is looked up
        and the slice resolved to absolute bounds. The previous code turned `[-5:-2]` into
        `bytes=-5` and returned five bytes where three were asked for, and rejected `[:-2]`
        outright as unsatisfiable, returning nothing.
        """
        exists, size = await head(url, fetcher=fetcher)
        if not exists or size is None:
            raise OSError(
                "cannot resolve the range %r:%r for %s: the server did not report a size"
                % (start, end, url)
            )
        start, end = normalise_slice(start, end, size)

    try:
        header = range_header(start, end)
    except RangeUnsatisfiable:
        return b""  # a caller asked for zero bytes; that is not a failure

    options = {}
    if header is not None:
        options["headers"] = {"Range": header}
    """
    No cookies, ever, on this adapter.

    It exists for PUBLIC, CORS-enabled data. Sending credentials would make every store a visitor
    types into the prompt a place their session cookies are offered to, and would make the request
    fail outright against the many CORS configurations that allow `*` but not credentials.
    Authenticated Freva requests go through their own transport, which is tested separately.
    """
    options["credentials"] = "omit"

    response = await fetcher(url, **options)
    status = int(response.status)

    """
    EVERY HEADER-LEVEL EXIT LETS THE BODY GO.

    This function refuses a good many responses on their headers alone - a range-ignoring 200, a
    206 that is not the slice that was asked for, an encoded ranged response, a span above the
    ceiling, a 404, a 416, a 503 - and each of those refusals was correct and each left the BODY
    live. Reading nothing and closing nothing is not neutral: an undrained response goes on
    consuming the network for as long as the server keeps sending, and on the range-ignoring 200
    that body is the WHOLE object, which is exactly what refusing it was meant to avoid
    downloading.

    The `try` below is the whole of it: anything that leaves the header phase - by raising or by
    returning - cancels the body and releases the reader first, without consuming a byte, and the
    diagnostic travels on unchanged. A refusal that lost its reason in the tidy-up would be a worse
    bug than the leak it fixed.
    """
    try:
        return await _read_within_bounds(url, response, status, header, max_bytes)
    except BaseException:
        await discard_body(response)
        raise


async def _read_within_bounds(url, response, status, header, max_bytes):
    """The header phase and the bounded read. See `fetch_bytes` for why this is a separate frame."""
    problem = describe_status(url, status)
    if isinstance(problem, RangeUnsatisfiable):
        # The server says the range is past the end of the object. An empty read, not an error -
        # a reader probing beyond a truncated object should see "nothing there". The body still
        # goes: an error page is a body like any other.
        await discard_body(response)
        return b""
    if problem is not None:
        raise problem

    if header is not None and status != 206:
        """
        The server ignored the range, so this is THE WHOLE OBJECT. Refuse it unread.

        The previous version read it and sliced locally, guarded by a ``Content-Length`` check -
        which is not a memory bound. ``Content-Length`` is absent on a chunked or compressed
        response, and absent meant "read it anyway": a four-kilobyte Zarr chunk request answered by
        a two-gigabyte chunked 200 allocated two gigabytes before any slice was applied, and the tab
        died with a message about memory rather than about a server that does not implement ranges.

        Reading a bounded prefix would be better than either and is not available here: ``pyfetch``
        exposes the body as a whole, and reading a JavaScript stream from Python needs machinery
        this adapter deliberately does not carry. So the refusal is the fix, and it is also the
        more useful answer - a store served through a range-ignoring server cannot be read chunk by
        chunk at all, and saying so beats dying while trying.

        A request that asked for NO range is unaffected: that caller wants the whole object.
        """
        declared = content_length(getattr(response, "headers", None))
        size_text = "%d bytes" % declared if declared is not None else "an undeclared size"
        raise OSError(
            "%s ignored the Range header (%s) and answered 200 with the whole object (%s). It was "
            "not read: this server does not support byte ranges, so a store served through it "
            "cannot be read chunk by chunk." % (url, header, size_text)
        )

    response_headers = getattr(response, "headers", None)
    ceiling = MAX_DECODED_BODY_BYTES if max_bytes is None else int(max_bytes)

    """
    EVERY HEADER IS JUDGED BEFORE THE BODY IS TOUCHED, AND THE BOUND COMES FROM THE REQUEST.

    Round 4 refused a range-ignoring 200 unread, on the grounds that validating a response after it
    is in memory is not a memory bound. The 206 path kept doing exactly that. Round 6 fixed the
    order and then bounded the read with `Content-Length`, which is the wrong quantity in both
    directions - see `MAX_DECODED_BODY_BYTES`.

    So: headers first, then a bound that does not come from the wire. An accepted range response is
    held to the span that has just been validated against the request; a whole-object response is
    held to this module's own decoded ceiling.
    """
    span = None
    if header is None:
        # A 206 nobody asked for must cover the whole object; anything else is refused unread.
        span = verify_unsolicited_partial(url, response_headers, status)
    else:
        """
        A RANGE OF AN ENCODED REPRESENTATION IS NOT A RANGE OF THE BYTES PYTHON GETS.

        `Content-Range` counts in the coordinates of the SELECTED REPRESENTATION - the compressed
        one, when a content coding is applied - and Fetch hands over the decoded bytes. So byte
        offsets do not survive the decoding, and there is no arithmetic that recovers them: the
        five bytes asked for are not the five bytes that arrive, and the length check would be
        comparing a decoded length against an encoded span. Refused, before anything is read.

        This is only reachable when the server EXPOSED `Content-Encoding`. When it did not, the
        span still bounds the read and the exact-length check below still refuses the mismatch -
        the diagnosis is worse, but nothing incorrect is returned.
        """
        if encoded(response_headers):
            raise OSError(
                "%s answered the range %s with Content-Encoding %r. A byte range names positions "
                "in the encoded representation, and the browser delivers the decoded body, so the "
                "bytes that arrive are not the bytes that were asked for. The response was "
                "refused rather than misread."
                % (url, header, content_encoding(response_headers))
            )
        # `length=None`: everything that can be judged from the headers alone, judged now.
        verify_content_range(url, header, response_headers, None)
        span = range_span(response_headers)

    limit = ceiling if span is None else min(span, ceiling)
    if span is not None and span > ceiling:
        raise OSError(
            "%s would deliver %d bytes, above this reader's %d-byte limit for a single response. "
            "Read it in smaller ranges, or stream it." % (url, span, ceiling)
        )

    body = await read_body(url, response, limit)

    """
    THE EXACT LENGTH, for every response whose length was declared in a way worth checking.

    A 206's span is a statement about what is being sent, and a body that does not match it is
    either truncated or something else entirely. Both matter: short is half a Zarr chunk, which
    decodes into an array that is quietly wrong, and long is a response that is not the one the
    `Content-Range` describes. The over-long case is normally caught by the cap above; this is the
    check that makes it true rather than probable, and it covers the unsolicited 206 too, which
    previously had its headers checked and its body never counted.
    """
    if header is not None:
        verify_content_range(url, header, response_headers, len(body))
    elif span is not None and len(body) != span:
        raise OSError(
            "%s answered 206 covering %d bytes and sent %d. The response does not match the "
            "Content-Range it declared, so it was refused." % (url, span, len(body))
        )
    return bytes(body)


def content_encoding(headers):
    """The ``Content-Encoding`` the server exposed, or ``None``."""
    if not headers:
        return None
    for key in ("content-encoding", "Content-Encoding"):
        raw = headers.get(key) if hasattr(headers, "get") else None
        if raw:
            return str(raw).strip()
    return None


def range_span(headers):
    """How many bytes an accepted ``Content-Range`` says are being sent, or ``None``.

    Used as the accumulation ceiling for a range response, and ONLY after `verify_content_range`
    has agreed that the span is the one that was asked for. An unvalidated span is a number the
    server chose, which is not a bound on anything.
    """
    parsed = parse_content_range(headers)
    if parsed is None:
        return None
    first, last, _total = parsed
    return last - first + 1 if last >= first else None


def encoded(headers):
    """True when the body on the wire is not the body the caller will see.

    ``Content-Encoding: gzip`` makes every declared length a length of the COMPRESSED bytes, so it
    is not a cap on what `read_body` accumulates and not something to compare a decoded length
    against. Absent, empty and ``identity`` all mean "what you see is what was sent".
    """
    if not headers:
        return False
    for key in ("content-encoding", "Content-Encoding"):
        raw = headers.get(key) if hasattr(headers, "get") else None
        if raw:
            text = str(raw).strip().lower()
            if text and text != "identity":
                return True
    return False


def verify_unsolicited_partial(url, headers, status):
    """A 206 answering a request that carried no ``Range`` must cover the WHOLE object.

    Every 206 check in this module used to be gated on "a range was requested", so a request for
    the whole object that got a partial answer skipped all of them: ``206 Content-Range: bytes
    0-4/100`` was returned to the caller as the entire file, and Zarr decoded five bytes of a
    hundred-byte chunk into an array that is quietly wrong.

    A 206 to a request with no ``Range`` is a protocol violation - RFC 9110 makes a partial
    response an answer to a range request - and the only harmless form of it is one whose
    ``Content-Range`` runs from the first byte to the last. Anything else is refused unread, for
    the same reason the range-ignoring 200 is.

    Returns the validated span for an accepted 206, or ``None`` when the response is not a 206.
    """
    if status != 206:
        return None
    parsed = parse_content_range(headers)
    if parsed is None:
        raise OSError(
            "%s answered 206 to a request that asked for no range, with no usable Content-Range "
            "header, so there is no evidence this is the whole object." % (url,)
        )
    first, last, total = parsed
    if first != 0 or total is None or last != total - 1:
        raise OSError(
            "%s answered 206 with Content-Range %d-%s to a request that asked for the whole "
            "object: a partial response nobody asked for. It was refused rather than returned as "
            "the complete object." % (url, first, "%d/%s" % (last, "*" if total is None else total))
        )
    # The span it just proved covers the object: the caller uses it as the read ceiling AND checks
    # the delivered length against it, so a 206 that declares the whole object and sends five bytes
    # is refused rather than returned as the file.
    return last - first + 1


async def read_body(url, response, limit=None):
    """Read the response body, refusing to accumulate more than ``limit`` bytes.

    ``pyfetch`` hands the decoded body over whole through ``bytes()``, which is why the earlier
    rounds could only refuse a response rather than bound one. The underlying ``Response`` is right
    there as ``js_response`` though, and its ``body`` is an ordinary readable stream - so the body
    can be taken a chunk at a time and abandoned the moment it passes the length the server itself
    declared. A response that lies about its length now costs one chunk, not its whole size.

    ``limit`` of ``None`` means the server declared nothing to hold it to - a chunked or compressed
    response - and the body is read as before.
    """
    try:
        setattr(response, _BODY_DONE, True)
    except Exception:
        pass  # see `discard_body`
    reader = _body_reader(response)
    if reader is None:
        """
        NO READER, NO READ.

        `response.bytes()` materialises whatever arrives, in full, before anything can object -
        which is precisely the property this function exists to remove. Falling back to it "just
        this once" would mean the bound advertised on this path is real only when the browser
        happens to expose a stream, and silently absent when it does not. So the fallback is gone
        and the refusal names what is missing.
        """
        raise OSError(
            "%s: this response exposes no readable body stream, so it cannot be read within a "
            "memory bound. It was refused rather than read whole." % (url,)
        )

    chunks = []
    total = 0
    overflow = False
    drained = False
    try:
        while True:
            item = await reader.read()
            if getattr(item, "done", False):
                drained = True
                break
            value = getattr(item, "value", None)
            if value is None:
                continue
            piece = _to_bytes(value)
            total += len(piece)
            if limit is not None and total > limit:
                # BEFORE keeping it: the chunk that crosses the bound is dropped, not appended and
                # then regretted, so the peak is one chunk over the limit rather than unbounded.
                overflow = True
                break
            chunks.append(piece)
    finally:
        """
        Cancel what is still running, and ALWAYS give the lock back.

        `getReader()` locks the stream for as long as the reader holds it, and a reader dropped
        without `releaseLock()` leaves the response permanently unreadable by anything else -
        including the browser's own cleanup. The cancel is conditional (there is nothing to stop
        once the stream ended); the release is not.
        """
        if not drained:
            await _cancel(reader)
        _release(reader)
    if overflow:
        raise OSError(
            "%s kept sending past the %d bytes this read is bounded to (%d and counting). The "
            "transfer was cancelled rather than accumulated." % (url, limit, total)
        )
    return b"".join(chunks)


#: Marks a response whose body has already been taken, so it is never taken twice.
_BODY_DONE = "_freva_browser_body_done"


async def discard_body(response):
    """Let a response's body go without reading a byte of it.

    EVERY HEADER-ONLY EXIT, and this is not tidiness. A response whose body is never cancelled
    holds a live network transfer for as long as the server keeps sending - on the probe path that
    body may be the WHOLE object, which is exactly what a one-byte range request exists to avoid
    downloading. Reading it to "use it up" would be worse still.

    Best effort by design: a body already disturbed, already closed, or absent (a stub, a `HEAD`
    with nothing behind it) is nothing to do anything about, and a probe must not fail because its
    tidy-up did.
    """
    if getattr(response, _BODY_DONE, False):
        # Already read, or already cancelled. Taking a second reader would lock the stream again
        # and release it again, which is not tidier - it is one more thing that happened.
        return
    try:
        setattr(response, _BODY_DONE, True)
    except Exception:
        pass  # a proxy that refuses attributes; the cancel below is still worth attempting
    reader = _body_reader(response)
    if reader is None:
        return
    await _cancel(reader)
    _release(reader)


def _body_reader(response):
    """The response's streaming reader, or ``None`` when this response cannot give one."""
    js = getattr(response, "js_response", None)
    body = getattr(js, "body", None) if js is not None else None
    get_reader = getattr(body, "getReader", None) if body is not None else None
    if get_reader is None:
        return None
    try:
        return get_reader()
    except Exception:
        # A body already disturbed, or a stub without one. The whole-body read still works.
        return None


def _to_bytes(value):
    """A stream chunk as ``bytes``, whether it arrived as a JS ``Uint8Array`` or Python bytes."""
    if isinstance(value, (bytes, bytearray, memoryview)):
        return bytes(value)
    to_py = getattr(value, "to_py", None)
    if to_py is not None:
        return bytes(to_py())
    return bytes(value)


def _release(reader):
    """Give the stream's lock back. Best effort, and after cancellation as well as success."""
    release = getattr(reader, "releaseLock", None)
    if release is None:
        return
    try:
        release()
    except Exception:
        pass


async def _cancel(reader):
    """Stop the transfer. Best effort: the refusal is what matters, not the tidy-up."""
    cancel = getattr(reader, "cancel", None)
    if cancel is None:
        return
    try:
        result = cancel()
        if result is not None:
            await result
    except Exception:
        pass


def parse_content_range(headers):
    """``(first, last, total)`` from ``Content-Range: bytes 10-19/500``, or ``None``.

    ``total`` is ``None`` for the ``*`` form, which is legal and means the server will not say.
    """
    if not headers:
        return None
    raw = None
    for key in ("content-range", "Content-Range"):
        raw = headers.get(key) if hasattr(headers, "get") else None
        if raw:
            break
    if not raw:
        return None
    text = str(raw).strip()
    if not text.lower().startswith("bytes "):
        return None
    text = text[6:].strip()
    if "/" not in text:
        return None
    span, _, total_text = text.partition("/")
    span = span.strip()
    if "-" not in span:
        return None
    first_text, _, last_text = span.partition("-")
    try:
        first = int(first_text)
        last = int(last_text)
    except ValueError:
        return None
    total_text = total_text.strip()
    total = None
    if total_text and total_text != "*":
        try:
            total = int(total_text)
        except ValueError:
            return None
    """
    A HEADER THAT PARSES IS NOT A HEADER THAT MEANS ANYTHING.

    The grammar has nothing to say about whether a range describes an object that could exist, and
    every caller here goes on to use these numbers as arithmetic: `bytes 0-0/-1` parsed, satisfied
    "the byte I asked for", and became `(True, -1)` - a negative object size handed to fsspec,
    which a reader then plans chunks against. So the meaning is checked here, once, and a
    `Content-Range` that cannot describe any object is refused as unusable rather than passed on:

      * a first byte before the start of the object;
      * a last byte before the first;
      * a negative total;
      * a span that runs past the total it declares.

    `*` for the total remains legal and is `None`: it is a server declining to say, not a server
    saying something impossible.
    """
    if first < 0 or last < first:
        return None
    if total is not None and (total < 0 or last >= total):
        return None
    return (first, last, total)


def verify_content_range(url, header, headers, length):
    """Check that a 206 delivered the range that was ASKED for.

    The gap this closes was an asymmetry rather than an oversight: the 200 path was defended - a
    server that ignores ``Range`` is refused outright rather than handing Zarr a whole object where
    it expected a chunk - and the 206 path trusted the status alone.
    A 206 whose ``Content-Range`` says something else is not hypothetical: a caching proxy can
    coalesce or widen ranges, a gateway can clamp a suffix range it does not like, and an
    intermediary can serve a neighbouring slice from cache. The bytes then arrive with the right
    length and the wrong contents, Zarr decodes them without complaining, and the array is quietly
    wrong - which is exactly the failure the 200 refusal was written to prevent.

    A server that sends no ``Content-Range`` at all IS a failure, and the paragraph that used to
    stand here said the opposite - it survived from the version that returned early on a missing
    header, and described behaviour this function had already stopped having. RFC 9110 requires the
    header on a 206; without it there is nothing to check the body against, so accepting one means
    accepting an arbitrary body as the requested slice.

    ``length`` is the number of bytes actually delivered, or ``None`` when the body has not been
    read yet. `fetch_bytes` calls this twice: once on the headers alone, BEFORE reading anything,
    and again with the delivered length. Everything that can be decided from the headers is decided
    on the first call, so a response that is provably the wrong slice is never materialised.
    """
    parsed = parse_content_range(headers)
    if parsed is None:
        """
        A 206 with no parseable ``Content-Range`` is not evidence of anything.

        The header is REQUIRED on a 206 by RFC 9110, and accepting a response without it means
        accepting an arbitrary body as though it were the requested slice. The previous version
        returned here, which made "the server sent no header" the one way past every check below.
        """
        raise OSError(
            "%s answered 206 without a usable Content-Range header, so there is no evidence the "
            "body is the range that was requested (%s)." % (url, header)
        )
    first, last, total = parsed
    if last < first:
        raise OSError("%s answered 206 with an inverted range (%d-%d)" % (url, first, last))
    delivered = last - first + 1
    if total is not None and last >= total:
        raise OSError(
            "%s answered 206 with Content-Range %d-%d/%d, which runs past the end of the object"
            % (url, first, last, total)
        )
    if length is not None and length != delivered:
        raise OSError(
            "%s answered 206 with Content-Range %d-%d (%d bytes) but sent %d bytes"
            % (url, first, last, delivered, length)
        )

    wanted = header[len("bytes=") :] if header.startswith("bytes=") else header
    if wanted.startswith("-"):
        """
        A suffix range: the last N bytes.

        Where they START depends on the object's size, which is the SERVER's to know - so the only
        thing that makes this response the one that was asked for is a total, and a last byte that
        reaches it. Without a total there is nothing to check against: `bytes 92-99/*` might be the
        end of the object or might be eight bytes from the middle of a larger one, and accepting it
        means deciding on the server's behalf that it is the former.
        """
        suffix = int(wanted)
        if total is None:
            raise OSError(
                "%s answered bytes=%s with %d-%d and no total size, so there is no way to prove "
                "these are the LAST %d bytes rather than %d bytes from somewhere else. A store "
                "read this way must report Content-Range with a total; see the README on "
                "Access-Control-Expose-Headers." % (url, wanted, first, last, -suffix, -suffix)
            )
        if last != total - 1:
            raise OSError(
                "%s answered a suffix range with %d-%d of %d, which is not the end of the object"
                % (url, first, last, total)
            )
        if length is not None and length != min(-suffix, total):
            raise OSError(
                "%s answered bytes=%s with %d bytes" % (url, wanted, length)
            )
        return

    begin_text, _, end_text = wanted.partition("-")
    try:
        begin = int(begin_text)
    except ValueError:
        return
    if first != begin:
        raise OSError(
            "%s answered 206 starting at byte %d, but bytes=%s was requested. The response is a "
            "different part of the object than the one asked for." % (url, first, wanted)
        )
    if not end_text:
        """
        An OPEN-ENDED range: ``bytes=N-`` means "from N to the end of the object".

        Round 4 taught the bounded case to demand a full span, and this case had no requested last
        byte to compare against - so `bytes=10-` answered with `bytes 10-19/100` and ten bytes
        passed every check while being ninety bytes short. Zarr asks for open-ended ranges whenever
        it reads a chunk whose length it does not know, and ten bytes of a hundred-byte chunk
        decodes into an array that is quietly wrong rather than an error.

        The proof is the same one a short bounded range needs: a reported total, and a last byte
        that reaches it.
        """
        if total is None:
            raise OSError(
                "%s answered bytes=%s with %d-%d and no total size, so there is no way to prove "
                "the response runs to the end of the object as the request asked. A store read "
                "this way must report Content-Range with a total; see the README on "
                "Access-Control-Expose-Headers." % (url, wanted, first, last)
            )
        if last != total - 1:
            raise OSError(
                "%s answered bytes=%s with %d-%d of %d: an incomplete range that does not reach "
                "the end of the object. Half a chunk decodes into an array that is quietly wrong, "
                "so it was refused." % (url, wanted, first, last, total)
            )
        return

    if end_text:
        try:
            wanted_last = int(end_text)
        except ValueError:
            return
        if last > wanted_last:
            raise OSError(
                "%s answered 206 with %d-%d, wider than the requested bytes=%s"
                % (url, first, last, wanted)
            )
        if last < wanted_last:
            """
            SHORT is only legitimate at the end of the object.

            ``bytes=0-9`` answered with ``bytes 0-4/100`` and five bytes passed every check there
            was: the header parses, the start matches, the span is not wider than requested, and
            the body length matches the span. It is still half a Zarr chunk, and Zarr decodes half
            a chunk into an array that is quietly wrong - which is the whole failure this function
            exists to prevent.

            The one honest short answer is the last range of an object, where the reported total
            proves there was nothing more to send. Without a total - the ``*`` form - there is no
            proof, so there is no acceptance.
            """
            if total is None or last != total - 1:
                raise OSError(
                    "%s answered 206 with %d-%d for a request of bytes=%s: an incomplete range "
                    "that does not reach the end of the object%s. Half a chunk decodes into an "
                    "array that is quietly wrong, so it was refused."
                    % (
                        url,
                        first,
                        last,
                        wanted,
                        "" if total is None else " (%d bytes)" % total,
                    )
                )


async def head(url, fetcher=None):
    """Probe an object: ``(exists, size)``.

    HEAD first, then a one-byte ranged GET if HEAD does not settle it.

    The distinction this makes is the point. The previous version answered ``(False, None)`` for
    everything that was not a clean 2xx - a CORS rejection, a 403, a 500, a server that simply does
    not implement HEAD (405 is common on object stores, and S3-compatible gateways often answer 501)
    - so fsspec reported "this key does not exist" for a store that was there, reachable, and
    merely fussy. Someone debugging that is told their URL is wrong when their credentials, their
    CORS configuration or the server's health is the actual problem.

    So: 404 means missing and nothing else does. A HEAD that is refused for any other reason falls
    back to ``Range: bytes=0-0``, which is what the reader is going to use anyway and which many
    servers answer when they will not answer HEAD. A failure of BOTH is raised, not reported as a
    missing file, because a caller that cannot tell those apart cannot show a usable error.
    """
    if fetcher is None:
        from pyodide.http import pyfetch

        fetcher = pyfetch

    head_error = None
    try:
        # No cookies here either: a probe is a request like any other, and this adapter exists for
        # public, CORS-enabled data. See `fetch_bytes`.
        response = await fetcher(url, method="HEAD", credentials="omit")
        status = int(response.status)
        # The headers are the whole answer here; whatever body came with them is let go.
        await discard_body(response)
        if status == 404:
            return (False, None)
        if 200 <= status < 300:
            return (True, content_length(getattr(response, "headers", None)))
        head_error = OSError("HTTP %d for HEAD %s" % (status, url))
    except Exception as error:  # noqa: BLE001 - a network/CORS failure is not a missing object
        head_error = error

    # HEAD did not settle it. Ask for one byte: the smallest request that proves the object is
    # readable, and the same access pattern the reader itself uses.
    try:
        response = await fetcher(
            url, method="GET", headers={"Range": "bytes=0-0"}, credentials="omit"
        )
    except Exception as error:  # noqa: BLE001
        raise OSError(
            "cannot reach %s (HEAD: %s; ranged GET: %s). This is a network, CORS or server "
            "problem, not a missing object." % (url, head_error, error)
        ) from error

    status = int(response.status)
    headers = getattr(response, "headers", None)
    """
    THE BODY GOES, WHATEVER THE ANSWER IS.

    This function returns headers and never bytes, so on every path below the body is a transfer
    nobody is going to read. Left alone it keeps running: on the range-ignoring 200 case it is the
    WHOLE object, which is precisely what asking for one byte was meant to avoid.
    """
    await discard_body(response)

    if status == 404:
        return (False, None)
    if status == 416:
        # The server understood the range and says the object is empty. It exists.
        return (True, 0)
    if not (200 <= status < 300):
        raise OSError(
            "cannot read %s (HEAD: %s; ranged GET: HTTP %d). This is a server or permissions "
            "problem, not a missing object." % (url, head_error, status)
        )

    if status != 206:
        """
        THE SERVER IGNORED THE RANGE.

        It answered with the whole object, so the object EXISTS - that much is settled and is worth
        reporting, because the alternative is telling a caller a file is missing when it is there.
        What is not settled is anything else. `Content-Length` here describes the wire bytes of a
        response nobody asked for and may be a compressed length (see `MAX_DECODED_BODY_BYTES`),
        and a server that ignores `Range` cannot back a chunked read at all - so a size taken from
        here would be a number a reader builds a chunk plan on, from a server that will not serve
        chunks. `None` is the honest answer: fsspec accepts an unknown size, and the first ranged
        read will refuse this server with a message that names the real problem.
        """
        return (True, None)

    parsed = parse_content_range(headers)
    if parsed is None:
        # A 206 with no usable `Content-Range` proves the object is readable and nothing else.
        return (True, None)
    first, last, total = parsed
    if first != 0 or last != 0:
        """
        A DIFFERENT BYTE THAN THE ONE ASKED FOR.

        `bytes=0-0` answered with `bytes 5-5/100` used to become `(True, 100)`. A server that
        serves a different single byte is a server whose ranges do not mean what this adapter
        assumes - a proxy rewriting them, a gateway clamping them - and a total taken from it is a
        number every later chunk request is planned against. Existence is still established; the
        size is not.
        """
        return (True, None)
    return (True, total)


def content_range_total(headers):
    """Total object size from a ``Content-Range: bytes 0-0/12345`` reply, or ``None``.

    ``Content-Length`` on a 206 is the length of the SLICE - one byte here - so reading it as the
    object's size would tell Zarr every array is one byte long.
    """
    if not headers:
        return None
    raw = None
    for key in ("content-range", "Content-Range"):
        raw = headers.get(key) if hasattr(headers, "get") else None
        if raw:
            break
    if not raw or "/" not in str(raw):
        return None
    total = str(raw).rsplit("/", 1)[1].strip()
    if not total.isdigit():
        return None  # "*" - the server declines to say
    return int(total)


# --------------------------------------------------------------------------- fsspec adapter

INSTALL_ERROR = "fsspec is not available in this interpreter"


def _running_loop():
    """The event loop this interpreter is already running on, or None.

    Emscripten's single loop is the only one there is; fsspec's usual answer - start a thread and
    give it one - is not available. `None` is an acceptable answer for an asynchronous filesystem,
    which never touches `_loop` on the paths this adapter supports.
    """
    import asyncio

    try:
        return asyncio.get_running_loop()
    except RuntimeError:
        try:
            return asyncio.get_event_loop_policy().get_event_loop()
        except Exception:
            return None


def install(clobber=True):
    """Define and register ``BrowserHTTPFileSystem`` for both ``http`` and ``https``.

    Registered for BOTH because a Zarr store's own metadata may name either scheme, and a store
    opened as ``https`` can hold absolute ``http`` references. Registering one and not the other
    produces a store that opens and then fails partway through reading.

    ``clobber=True`` because fsspec ships its own aiohttp-based HTTP implementation and registers it
    first; without clobbering, this one is never consulted and the failure is an aiohttp import
    error from deep inside xarray.
    """
    import fsspec
    from fsspec.asyn import AsyncFileSystem

    class BrowserHTTPFileSystem(AsyncFileSystem):
        """Read-only HTTP(S) through the browser's Fetch. One object per URL, no listing."""

        protocol = ("http", "https")
        root_marker = ""
        # Not cachable: fsspec's instance cache keys on the constructor arguments, and a store
        # opened twice with different storage options would otherwise share the first one's.
        cachable = False
        async_impl = True

        def __init__(self, *args, **storage_options):
            # `anon` and `token` are what people paste from an s3fs/gcsfs example. They mean nothing
            # for public HTTP, but rejecting them would make a familiar snippet fail for a reason
            # that has nothing to do with the data, so they are accepted and ignored.
            storage_options.pop("anon", None)
            storage_options.pop("token", None)

            # ASYNCHRONOUS ALWAYS, and this is not a preference.
            #
            # fsspec's synchronous mode runs its coroutines on a background IO thread, which it
            # starts in `get_loop()` during `__init__`. Emscripten has no threads, so a filesystem
            # constructed the ordinary way dies at construction with `RuntimeError: can't start new
            # thread` - before a single byte is requested, and with a traceback that points at
            # `threading` rather than at anything to do with HTTP.
            #
            # In asynchronous mode fsspec skips the thread entirely and callers await the
            # `_`-prefixed coroutines directly, which is exactly how Zarr's `FsspecStore` uses a
            # filesystem anyway. Forced rather than defaulted: a caller passing
            # `asynchronous=False` would be asking for the one configuration that cannot work here.
            storage_options["asynchronous"] = True
            storage_options.setdefault("loop", _running_loop())
            super().__init__(*args, **storage_options)

        @classmethod
        def _strip_protocol(cls, path):
            """Keep the WHOLE URL.

            fsspec's default strips the scheme, which is right for a bucket-style filesystem where
            the remainder is a key. For plain HTTP the scheme, host and path together ARE the
            identity of the object; dropping the scheme leaves `//host/key`, which cannot be
            fetched. This is the single most important line in the adapter.
            """
            if isinstance(path, (list, tuple)):
                return [cls._strip_protocol(p) for p in path]
            return path

        @staticmethod
        def _get_kwargs_from_urls(path):
            return {}

        async def _cat_file(self, path, start=None, end=None, **_kwargs):
            return await fetch_bytes(path, start, end)

        async def _exists(self, path, **_kwargs):
            exists, _size = await head(path)
            return exists

        async def _info(self, path, **_kwargs):
            exists, size = await head(path)
            if not exists:
                raise FileNotFoundError(path)
            info = {"name": path, "type": "file"}
            info["size"] = size  # may legitimately be None - see `content_length`
            return info

        async def _isfile(self, path, **_kwargs):
            return await self._exists(path)

        async def _isdir(self, _path, **_kwargs):
            return False

        async def _ls(self, path, detail=True, **_kwargs):
            # Refused, not faked. Generic HTTP cannot enumerate an object-store prefix: there is no
            # listing verb, and an HTML index page is a different server's convention, not the
            # store's contents. Returning [] would be worse than refusing - a caller would read it
            # as "this prefix is empty" and quietly produce an empty dataset.
            raise NotImplementedError(
                "Listing is not possible over plain HTTP (%s). Open a Zarr store with "
                "consolidated metadata, which names its own keys." % path
            )

        async def _find(self, path, **_kwargs):
            raise NotImplementedError(
                "Searching is not possible over plain HTTP (%s); see _ls." % path
            )

        async def _glob(self, path, **_kwargs):
            raise NotImplementedError(
                "Globbing is not possible over plain HTTP (%s); see _ls." % path
            )

        async def _pipe_file(self, path, *_args, **_kwargs):
            raise PermissionError("This filesystem is read-only (%s)." % path)

        async def _rm_file(self, path, **_kwargs):
            raise PermissionError("This filesystem is read-only (%s)." % path)

    fsspec.register_implementation("http", BrowserHTTPFileSystem, clobber=clobber)
    fsspec.register_implementation("https", BrowserHTTPFileSystem, clobber=clobber)
    return BrowserHTTPFileSystem
