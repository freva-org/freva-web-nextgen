"""Anonymous, read-only ``s3://`` over an S3-compatible HTTPS gateway.

NOT S3 SUPPORT: no signing, no credential chain, no region resolution, no listing. A URL
translation in front of `browser_http`, so a catalogue written as `s3://bucket/key` opens without
`s3fs` - which wants botocore, threads and a credential resolver, none of which exist here.
`s3://<bucket>/<key>` plus an endpoint becomes ``<endpoint>/<bucket>/<key>``, path style, and every
byte after that is fetched by the code that serves ``https://``: the same ranges, validation and
size ceiling.

Supported: `anon=True`, an HTTPS `endpoint_url`, path style, consolidated Zarr, reads. Everything
else is refused BY NAME - a credential silently dropped means an unauthenticated request that 403s
somewhere the reader cannot see.
"""

from __future__ import annotations

from urllib.parse import quote, urlsplit

# Every option that means "authenticate as somebody", so a reader who pastes a working boto3 or
# s3fs snippet is told which key cannot be honoured rather than discovering it from a 403.
CREDENTIAL_OPTIONS = (
    "key",
    "secret",
    "token",
    "aws_access_key_id",
    "aws_secret_access_key",
    "aws_session_token",
    "session_token",
    "profile",
    "profile_name",
    "client_kwargs_credentials",
)

NO_ENDPOINT = (
    "s3:// needs storage_options={'anon': True, 'endpoint_url': 'https://<gateway>'}. This "
    "filesystem does not resolve AWS endpoints or regions: it rewrites s3://<bucket>/<key> to "
    "<endpoint>/<bucket>/<key> and fetches that over HTTPS, so the gateway has to be named."
)

NOT_ANONYMOUS = (
    "Only anonymous access is supported: pass anon=True. This filesystem cannot sign a request - "
    "there is no credential chain and no signing implementation in the browser build - so a "
    "bucket that requires authentication has to be served through a gateway that does the "
    "signing, or exposed with a presigned URL opened as https://."
)

NOT_HTTPS = (
    "endpoint_url must be an https:// origin (got %r). A page served over HTTPS cannot fetch "
    "http://, and an unencrypted gateway would put every byte of the dataset on the wire in "
    "clear. `http://localhost`, `http://127.0.0.1` and `http://[::1]` are the exception, because "
    "a browser treats them as potentially trustworthy (W3C Secure Contexts)."
)

ENDPOINT_PART = (
    "endpoint_url must be an origin with an optional base path; this one carries %s (%r). "
    "Anything after the path is concatenated in front of the object key, which produces a URL "
    "that addresses something other than the object."
)

# The Secure Contexts list, so a local gateway is not a special case invented here.
LOCAL_HOSTS = ("localhost", "127.0.0.1", "[::1]", "::1")

DOT_SEGMENT = (
    "An s3 key may not contain a `.` or `..` segment (%r). S3 treats a key as an opaque string, "
    "but a URL parser resolves those segments before the request is sent, so the object fetched "
    "would not be the object asked for. Nothing here can encode its way out of that."
)

NO_LISTING = (
    "Listing is not possible here (%s): ListObjectsV2 is an S3 API call this filesystem does not "
    "make, and an anonymous gateway may refuse it anyway. Open a Zarr store with consolidated "
    "metadata, which names its own keys."
)


def split_path(path):
    """``s3://bucket/key`` (or ``bucket/key``) -> ``("bucket", "key")``. Key may be empty."""
    text = path
    if "://" in text:
        scheme, _, rest = text.partition("://")
        if scheme.lower() not in ("s3", "s3a", "s3n"):
            raise ValueError("Not an s3 path: %s" % path)
        # NOT lstripped when a scheme was given. `s3:///key` has an empty bucket, and stripping the
        # slashes first would promote the key to bucket and fetch `<endpoint>/<key>` - a URL that
        # may well exist and hold something else.
        text = rest
    else:
        text = text.lstrip("/")
    bucket, sep, key = text.partition("/")
    if not bucket:
        raise ValueError("An s3 path needs a bucket: %s" % path)
    # THE KEY IS RETURNED EXACTLY, and this is the whole of it. S3 keys are opaque strings, not
    # paths: `a/c`, `a//c`, `/a/c` and `a/c/` are four different objects, and a filesystem that
    # tidied them would read the wrong one and say nothing. Only the separator after the bucket is
    # consumed.
    return bucket, key if sep else ""


def object_url(endpoint, bucket, key):
    """Path-style object URL, each segment percent-encoded, the key preserved exactly.

    Per SEGMENT, so a key keeps its slashes: a gateway matching on `%2F` would 404 on a store that
    works everywhere else. Everything else - a space, `#`, `?`, non-ASCII - is escaped, because
    unescaped it would end the path or start a query. An EMPTY segment is kept, because `a//c` is
    not `a/c` in a bucket, and `.`/`..` are refused rather than encoded: a URL parser resolves
    them on the way out, so no escaping saves them.
    """
    base = endpoint.rstrip("/")
    segments = key.split("/") if key else []
    for segment in segments:
        if segment in (".", ".."):
            raise ValueError(DOT_SEGMENT % key)
    parts = [quote(bucket, safe="")]
    parts.extend(quote(segment, safe="") for segment in segments)
    return "%s/%s" % (base, "/".join(parts))


def check_endpoint(endpoint):
    """Return the endpoint origin, or raise with the reason it cannot be used."""
    if not endpoint:
        raise ValueError(NO_ENDPOINT)
    split = urlsplit(endpoint)
    if not split.netloc:
        raise ValueError(NOT_HTTPS % endpoint)
    # An endpoint is an ORIGIN and an optional base path, and nothing else. A query or a fragment
    # would be concatenated in front of the key - `https://host/base?t=x` + `/bucket/key` is a
    # query string containing the object, not a path to it - and userinfo is a credential, which
    # this filesystem refuses everywhere else and must refuse here too.
    if split.query:
        raise ValueError(ENDPOINT_PART % ("a query string", endpoint))
    if split.fragment:
        raise ValueError(ENDPOINT_PART % ("a fragment", endpoint))
    if split.username is not None or split.password is not None:
        raise ValueError(ENDPOINT_PART % ("credentials in the URL", endpoint))
    try:
        port = split.port  # raises ValueError on a port that is not a number or is out of range
    except ValueError:
        raise ValueError(ENDPOINT_PART % ("an invalid port", endpoint)) from None
    if port is not None and not 1 <= port <= 65535:
        raise ValueError(ENDPOINT_PART % ("an invalid port", endpoint))
    if split.scheme == "https":
        return endpoint
    if split.scheme == "http" and split.hostname in LOCAL_HOSTS:
        return endpoint
    raise ValueError(NOT_HTTPS % endpoint)


def check_options(options):
    """Refuse credentials and non-anonymous access, by name."""
    named = [name for name in CREDENTIAL_OPTIONS if options.get(name) is not None]
    if named:
        raise ValueError(
            "Credentials are not supported here (%s). %s" % (", ".join(sorted(named)), NOT_ANONYMOUS)
        )
    client_kwargs = options.get("client_kwargs") or {}
    if isinstance(client_kwargs, dict):
        for name in ("aws_access_key_id", "aws_secret_access_key", "aws_session_token"):
            if client_kwargs.get(name) is not None:
                raise ValueError(
                    "Credentials are not supported here (client_kwargs.%s). %s"
                    % (name, NOT_ANONYMOUS)
                )
    if options.get("anon") is False:
        raise ValueError(NOT_ANONYMOUS)


def endpoint_from(options):
    """The gateway origin, from `endpoint_url` or `client_kwargs={'endpoint_url': ...}`."""
    endpoint = options.get("endpoint_url")
    if not endpoint:
        client_kwargs = options.get("client_kwargs") or {}
        if isinstance(client_kwargs, dict):
            endpoint = client_kwargs.get("endpoint_url")
    return check_endpoint(endpoint)


def install(clobber=True):
    """Register ``BrowserS3FileSystem`` for ``s3``, ``s3a`` and ``s3n``.

    All three because a catalogue written for Hadoop or Spark names the other two. `clobber=True`
    for the reason `browser_http` clobbers: if `s3fs` is present it registers first, and its first
    act is to want botocore.
    """
    import browser_http
    import fsspec
    from fsspec.asyn import AsyncFileSystem

    class BrowserS3FileSystem(AsyncFileSystem):
        """Read-only, anonymous ``s3://`` translated to path-style HTTPS. One object per key."""

        protocol = ("s3", "s3a", "s3n")
        root_marker = ""
        cachable = False
        async_impl = True

        def __init__(self, *args, **storage_options):
            check_options(storage_options)
            self.endpoint_url = endpoint_from(storage_options)
            # Consumed here: they describe the gateway, and fsspec's base class rejects unknowns.
            for name in ("anon", "endpoint_url", "client_kwargs", "config_kwargs", "use_ssl"):
                storage_options.pop(name, None)
            # Asynchronous always: Emscripten has no threads for fsspec's IO loop. See
            # `browser_http.install`.
            storage_options["asynchronous"] = True
            storage_options.setdefault("loop", browser_http._running_loop())
            super().__init__(*args, **storage_options)

        @classmethod
        def _strip_protocol(cls, path):
            """``s3://bucket/key`` -> ``bucket/key``.

            The scheme goes, unlike `browser_http`: here the endpoint is the object's identity, and
            what remains is what gets appended to it.
            """
            if isinstance(path, (list, tuple)):
                return [cls._strip_protocol(p) for p in path]
            bucket, key = split_path(path)
            return "%s/%s" % (bucket, key) if key else bucket

        @staticmethod
        def _get_kwargs_from_urls(_path):
            # Nothing: an s3 URL carries no endpoint, which is exactly why one must be supplied.
            return {}

        def url_for(self, path):
            """The HTTPS URL this key is fetched from. Public, because it is what a reader debugs."""
            bucket, key = split_path(path)
            return object_url(self.endpoint_url, bucket, key)

        async def _cat_file(self, path, start=None, end=None, **_kwargs):
            return await browser_http.fetch_bytes(self.url_for(path), start, end)

        async def _exists(self, path, **_kwargs):
            exists, _size = await browser_http.head(self.url_for(path))
            return exists

        async def _info(self, path, **_kwargs):
            url = self.url_for(path)
            exists, size = await browser_http.head(url)
            if not exists:
                raise FileNotFoundError(path)
            info = {"name": self._strip_protocol(path), "type": "file"}
            info["size"] = size  # may legitimately be None - see browser_http.content_length
            return info

        async def _isfile(self, path, **_kwargs):
            return await self._exists(path)

        async def _isdir(self, _path, **_kwargs):
            return False

        async def _ls(self, path, detail=True, **_kwargs):
            raise NotImplementedError(NO_LISTING % path)

        async def _find(self, path, **_kwargs):
            raise NotImplementedError(NO_LISTING % path)

        async def _glob(self, path, **_kwargs):
            raise NotImplementedError(NO_LISTING % path)

        async def _pipe_file(self, path, *_args, **_kwargs):
            raise PermissionError("This filesystem is read-only (s3://%s)." % path)

        async def _rm_file(self, path, **_kwargs):
            raise PermissionError("This filesystem is read-only (s3://%s)." % path)

    for scheme in ("s3", "s3a", "s3n"):
        fsspec.register_implementation(scheme, BrowserS3FileSystem, clobber=clobber)
    return BrowserS3FileSystem
