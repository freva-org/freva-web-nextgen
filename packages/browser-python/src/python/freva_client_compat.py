"""Everything that makes `freva_client` work in a browser, in one removable file.

This module is the ONLY place in @freva-org/browser-python that knows anything about Freva's
internals. Nothing in the worker, the REPL, the console controller or the other Python helpers
carries an `if emscripten` branch for Freva's benefit; if a patch does not fit here, it does not
belong in this package.

It is written to be deleted. Every section below states the upstream problem, the upstream symbol
it touches, and the condition under which the section can be removed. `tests/` carries a sunset
check that fails when an upstream version already provides the capability, so the removal condition
is enforced rather than merely documented.

Contract
--------
    install()   idempotent, safe to call more than once, a no-op off Emscripten.

Applied BEFORE the first `import freva_client`, because two of the patches replace attributes that
`freva_client`'s own modules bind at import time - after the fact is too late.

Supported upstream versions are pinned explicitly. An unknown version fails loudly instead of
patching something that may have moved: a compatibility layer that silently no-ops is worse than
one that is absent, because the failure surfaces somewhere else entirely.

Never logs, prints or returns a token value.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

# ---------------------------------------------------------------------------------------------
# The versions this adapter has actually been read against. Not a floor: an exact set.
#
# Every patch below reaches into a private implementation detail. A newer upstream may have fixed
# the problem, moved the symbol, or changed its signature, and in all three cases patching blind is
# how a compatibility layer starts corrupting behaviour instead of restoring it.
# ---------------------------------------------------------------------------------------------
SUPPORTED_FREVA_CLIENT = {"2607.1.0", "2607.1.0+browser.1"}
SUPPORTED_OIDC_CLIENT = {"2603.0.1"}

_INSTALLED = False


class CompatError(RuntimeError):
    """Raised when the runtime is not what this adapter was written against."""


def _version(module_name: str) -> str:
    from importlib.metadata import PackageNotFoundError, version

    try:
        return version(module_name)
    except PackageNotFoundError:  # pragma: no cover - only on a broken install
        return "(not installed)"


def _check_versions() -> None:
    freva = _version("freva-client")
    oidc = _version("py-oidc-auth-client")
    if freva not in SUPPORTED_FREVA_CLIENT:
        raise CompatError(
            f"freva_client_compat supports freva-client {sorted(SUPPORTED_FREVA_CLIENT)}, "
            f"found {freva!r}. Re-read the patches in src/python/freva_client_compat.py against "
            "the new version before widening this set - each one reaches into an implementation "
            "detail that may have moved or been fixed."
        )
    if oidc not in SUPPORTED_OIDC_CLIENT:
        raise CompatError(
            f"freva_client_compat supports py-oidc-auth-client {sorted(SUPPORTED_OIDC_CLIENT)}, "
            f"found {oidc!r}. See the note above."
        )


# =============================================================================================
# PATCH  CONFIG_GET_DIRS
#
# Upstream problem   `Config.get_dirs(user=True)` builds a sysconfig scheme name as
#                    f"{os.name}_user" -> "posix_user", and looks it up. Pyodide's sysconfig has
#                    no "posix_user" scheme, so this raises KeyError: 'posix_user'.
#
#                    Measured on Pyodide 314.0.6 / Python 3.14:
#                        os.name                     "posix"
#                        site.USER_BASE              None
#                        sysconfig.get_scheme_names  nt, nt_venv, posix_home, posix_prefix,
#                                                    posix_venv, venv
#
#                    Both `Config(host=...)` and `databrowser(host=...)` raise, so this blocks
#                    every other Freva feature. It is the first thing to fix and the reason the
#                    other patches could not be observed until it was.
#
# Affected symbol    freva_client.utils.databrowser_utils.Config.get_dirs   (staticmethod)
# Upstream file      freva-client/src/freva_client/utils/databrowser_utils.py
#
# What is NOT done   `sysconfig._INSTALL_SCHEMES` is not touched. Adding a fake "posix_user"
#                    scheme to a private dict would fix this call and silently change the answer
#                    for every other library in the interpreter that asks sysconfig where user
#                    data goes. The blast radius has to stay inside Freva.
#
# Removal condition  Delete when upstream `get_dirs` falls back rather than indexing an assumed
#                    scheme - i.e. when it honours PYTHONUSERBASE, or uses `site.USER_BASE or
#                    Path.home()/".local"`, or catches KeyError. The sunset test calls the
#                    unpatched implementation and fails if it no longer raises.
# =============================================================================================
def _patch_get_dirs() -> None:
    from freva_client.utils import databrowser_utils

    config = databrowser_utils.Config
    if getattr(config.get_dirs, "_freva_browser_patch", None) == "CONFIG_GET_DIRS":
        return

    original = config.get_dirs

    def get_dirs(user: bool = True) -> Path:
        """Portable replacement: PYTHONUSERBASE, then ~/.local. Non-user paths are unchanged."""
        if not user:
            return original(user=False)
        base = os.environ.get("PYTHONUSERBASE")
        root = Path(base) if base else Path.home() / ".local"
        return root / "share" / "freva"

    get_dirs._freva_browser_patch = "CONFIG_GET_DIRS"  # type: ignore[attr-defined]
    get_dirs._freva_browser_original = original  # type: ignore[attr-defined]
    config.get_dirs = staticmethod(get_dirs)


# =============================================================================================
# PATCH  AUTH_CONFIG_PORTS
#
# Upstream problem   `AuthConfig.__init__` performs a SYNCHRONOUS network request during ordinary
#                    `databrowser(host=...)` construction:
#
#                        requests.get(f"{host}/auth/v2/auth-ports").json().get("valid_ports", [])
#
#                    wrapped in `except Exception: pass`. Being precise about what this is: it does
#                    not raise, and `requests` works in this Worker, so in a browser it SUCCEEDS -
#                    a blocking round-trip on every construction, blocking the interpreter, for
#                    redirect ports that only the loopback CodeFlow can use. This profile
#                    authenticates with the device flow, which has no redirect port at all, so the
#                    request is pure latency and one more origin that must permit CORS.
#
# Affected symbol    freva_client.utils.AuthConfig.__init__
# Upstream file      freva-client/src/freva_client/utils/__init__.py  (the request is at :69)
#
# What is preserved  Everything else the constructor does: the same REST-host normalisation via
#                    `get_rest_host`, the same host-keyed `TokenStore`, the same `Config`. Only the
#                    port probe is skipped, and `redirect_ports` is simply never populated - which
#                    is what the `if not _redirect_ports` branch already means when the request
#                    fails, so this is a path upstream already supports.
#
# Removal condition  Delete when upstream makes the port probe lazy (only when a CodeFlow is
#                    actually about to run) or skips it for device-flow authentication. The sunset
#                    test asserts the unpatched constructor still issues the request.
# =============================================================================================
def _patch_auth_config() -> None:
    from freva_client import utils as freva_utils

    auth_config = freva_utils.AuthConfig
    if getattr(auth_config.__init__, "_freva_browser_patch", None) == "AUTH_CONFIG_PORTS":
        return

    original_init = auth_config.__init__

    def __init__(self, host, _redirect_ports=None):  # type: ignore[no-untyped-def]
        """Upstream's constructor with the /auth-ports probe removed. No network at all.

        `Config` and `TokenStore` are read off the upstream MODULE rather than imported here, and
        that is not fussiness. There are two classes called `Config` in this codebase - the OIDC
        client's, which `freva_client.utils` binds at line 12, and Freva's own in
        `databrowser_utils` - and they take different arguments. Importing "the" Config by name got
        the wrong one and produced

            TypeError: Config.__init__() got an unexpected keyword argument 'app_name'

        Reading the symbol the module itself resolved cannot pick the wrong one.
        """
        module = sys.modules["freva_client.utils"]
        self.token_db = module.TokenStore(app_name=self.app_name)
        host = self.get_rest_host(host)
        # No `redirect_ports`: the device flow has none, and upstream's own except-branch
        # constructs Config in exactly this shape when the probe fails.
        self.config = module.Config(host, app_name=self.app_name)

    __init__._freva_browser_patch = "AUTH_CONFIG_PORTS"  # type: ignore[attr-defined]
    __init__._freva_browser_original = original_init  # type: ignore[attr-defined]
    auth_config.__init__ = __init__  # type: ignore[method-assign]


# =============================================================================================
# PATCH  INTAKE_CATALOGUE
#
# Upstream problem   `databrowser.intake_catalogue()` cannot work in this profile, because the
#                    profile deliberately does not ship intake-esm: it pins polars >=1.24,<1.33 and
#                    the runtime ships polars 1.33.1. A version conflict, not a missing build.
#
#                    The browser wheel's `lazy.py` overlay already raises the right sentence when
#                    `intake`/`intake_esm` is touched - but upstream reaches the network BEFORE it
#                    touches either:
#
#                        with NamedTemporaryFile(suffix=".json") as temp_f:
#                            self._create_intake_catalogue_file(temp_f.name)   # <- HTTP first
#                            return intake.open_esm_datastore(temp_f.name)     # <- lazy import
#
#                    so on an unreachable host the user gets a connection error about a feature that
#                    was never going to work, and on a reachable one they pay for a request whose
#                    result is discarded. Measured: `ValueError: Could not connect to ...` rather
#                    than the documented message.
#
# Affected symbol    freva_client.query.databrowser.intake_catalogue
# Upstream file      freva-client/src/freva_client/query.py
#
# Why not an overlay The rest of this exclusion IS a build-time overlay, applied by this package's
#                    own `prepare-freva-wheelhouse` command (bin/freva-wheelhouse.mjs). Only the
#                    ORDER is patched here,
#                    and overlaying the method body would mean carrying a copy of a long upstream
#                    function whose real implementation is the one thing this must not change.
#
# The message        Read from the wheel overlay, not duplicated: one string, defined in
#                    `freva_client/utils/lazy.py`, so the adapter and the wheel cannot drift.
#
# Removal condition  Delete when intake-esm's polars pin admits the polars the runtime ships, at
#                    which point the profile can simply include it. Track intake-esm's
#                    requirements.txt.
# =============================================================================================
_INTAKE_FALLBACK_MESSAGE = (
    "intake_catalogue() is not included in the browser profile because\n"
    "intake-esm's dependency set is incompatible with this Pyodide runtime.\n"
    "Use the standard Freva Python environment for this feature."
)


def _intake_message() -> str:
    try:
        from freva_client.utils import lazy

        return lazy._BROWSER_UNSUPPORTED["intake_esm"]
    except Exception:
        return _INTAKE_FALLBACK_MESSAGE


def _patch_intake_catalogue() -> None:
    from freva_client import query

    databrowser = query.databrowser
    if getattr(databrowser.intake_catalogue, "_freva_browser_patch", None) == "INTAKE_CATALOGUE":
        return

    original = databrowser.intake_catalogue
    message = _intake_message()

    def intake_catalogue(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        """Refuse before doing any work. See the block comment above."""
        raise NotImplementedError(message)

    intake_catalogue.__doc__ = original.__doc__
    intake_catalogue._freva_browser_patch = "INTAKE_CATALOGUE"  # type: ignore[attr-defined]
    intake_catalogue._freva_browser_original = original  # type: ignore[attr-defined]
    databrowser.intake_catalogue = intake_catalogue


# =============================================================================================
# PATCH  CONFIG_FLAVOUR
#
# Upstream problem   `Config.flavour` asks the server which flavours it has, and is written to cope
#                    with an unreachable server by falling back to "freva":
#
#                        try:
#                            flavours = self.overview.get("flavours", [])
#                            self._flavour = flavours[0] if flavours else "freva"
#                        except (ValueError, IndexError, KeyError,
#                                requests.exceptions.ConnectionError,
#                                requests.exceptions.HTTPError,
#                                requests.exceptions.ReadTimeout):
#                            self._flavour = "freva"
#
#                    The intent is unambiguous. The exception list is not browser-shaped: a failed
#                    fetch surfaces as `pyodide.ffi.JsException: TypeError: Failed to fetch`, which
#                    is none of those, so the fallback never runs and `databrowser(host=...)` raises
#                    instead of defaulting.
#
#                    Found in the demo, not by the suite - and that is worth recording. The browser
#                    test constructs against the same host and PASSED, because on that run the
#                    failure happened to arrive as an exception the tuple does catch. A test that
#                    passes for a reason it did not intend is not evidence, so the assertion now
#                    pins the OUTCOME (constructs, flavour == "freva") against a host that is
#                    guaranteed unreachable, rather than trusting whichever error type turns up.
#
# Affected symbol    freva_client.utils.databrowser_utils.Config.flavour   (property)
# Upstream file      freva-client/src/freva_client/utils/databrowser_utils.py
#
# What is preserved  Everything. An explicit `flavour=` still wins, a reachable server still decides,
#                    and the fallback value is upstream's own. Only the set of failures that reach
#                    it is widened - to "the request did not work", which is what the code means.
#
# Removal condition  Delete when upstream catches the transport's failure generically (a bare
#                    `except Exception`, or `requests.exceptions.RequestException`, which is the
#                    base class the browser failure would also want to be). The sunset test asserts
#                    the unpatched property still narrows to a tuple.
# =============================================================================================
def _patch_flavour() -> None:
    from freva_client.utils import databrowser_utils

    config = databrowser_utils.Config
    if getattr(config.flavour, "fget", None) is None:
        return
    if getattr(config.flavour.fget, "_freva_browser_patch", None) == "CONFIG_FLAVOUR":
        return

    original = config.flavour

    def flavour(self):
        """Upstream's property, with a fallback that catches the browser's failure - quietly.

        The probe's stderr is captured, and that is not cosmetics for its own sake. A failed fetch
        writes `pyodide.ffi.JsException: TypeError: Failed to fetch` to stderr even when the
        exception is caught here and handled exactly as upstream intends, and the console renders
        any stderr in red with a gutter rule. So `databrowser(host=...)` SUCCEEDED and looked like a
        crash - the object was built, `_flavour` was "freva", and the transcript showed a red
        traceback line above it. Reporting a handled, expected condition as an error is how a
        working console teaches people not to trust it.

        Only this one probe is silenced, and only its stderr; a real failure still raises, and every
        other stream is untouched.
        """
        import contextlib
        import io

        if getattr(self, "_flavour", None):
            return self._flavour
        try:
            with contextlib.redirect_stderr(io.StringIO()):
                flavours = self.overview.get("flavours", [])
            self._flavour = flavours[0] if flavours else "freva"
        except Exception:
            # Deliberately broad: upstream enumerates the ways a request can fail on CPython, and
            # in a browser it fails in a way that list cannot name. The meaning is "we could not
            # ask the server", and every failure here means exactly that.
            self._flavour = "freva"
        return self._flavour

    flavour._freva_browser_patch = "CONFIG_FLAVOUR"
    flavour._freva_browser_original = original
    config.flavour = property(flavour)


# =============================================================================================
# PATCH  AUTHENTICATE_ASYNC  and  TOKEN_BRIDGE
#
# Upstream problem   `authenticate()` is synchronous and bottoms out in
#
#                        py_oidc_auth_client/__init__.py:203
#                        return asyncio.run(authenticate_async(host, ...))
#
#                    `asyncio.run` cannot run inside Pyodide's already-running event loop, so the
#                    documented Freva call cannot work here at all. Note where this is NOT:
#                    freva_client's own auth.py contains no asyncio - it delegates - so reading
#                    `inspect.getsource(freva_client.authenticate)` for "asyncio.run" finds nothing
#                    and suggests the opposite. It is one layer down.
#
#                    The alternative would be to bridge the loop from inside. That is deliberately
#                    not done: hiding browser Fetch behind a blocking wrapper freezes the only
#                    thread the page has. Top-level `await` works here, so the browser profile's
#                    `authenticate` is honestly asynchronous.
#
# Affected symbols   Four bindings, from THREE modules, and this is the part most likely to look
#                    finished while being half done:
#
#                      freva_client.authenticate                          (package re-export)
#                      freva_client.auth.authenticate                     (the definition)
#                      freva_client.utils.databrowser_utils.authenticate  from ..auth import ...
#                      freva_client.query.authenticate                    from py_oidc_auth_client
#
#                    The last two are bound at IMPORT time in their own modules, and they are not
#                    the same function: databrowser_utils binds Freva's, query binds the OIDC
#                    client's. Replacing freva_client.auth.authenticate alone fixes neither.
#
#                    They also need DIFFERENT replacements. `Config.auth_headers`
#                    (databrowser_utils.py:182) and `databrowser._authenticate` (query.py:744) are
#                    synchronous and must never receive a coroutine, so those two get the cached
#                    token bridge below rather than the async function.
#
# Flow               `DeviceFlow` directly, interactive=False, auto_open=False. NOT the upstream
#                    sync wrapper (asyncio.run), and never `CodeFlow`, which needs a loopback HTTP
#                    server, threads and sockets - none of which exist in a Worker. With
#                    auto_open=False the flow prints the verification URL and user code as ordinary
#                    text, which is what the console renders.
#
# Transport          NOTHING is injected. httpx was tested in this Worker before any transport was
#                    written: both `httpx.AsyncClient().get()` and `httpx.get()` returned 200.
#                    Pyodide's httpx/urllib3 recipe already speaks browser networking, so a PyFetch
#                    transport would be a second implementation of a working one. The suite asserts
#                    this, so if it stops being true the need resurfaces as a failure.
#
# Tokens             Never logged or printed here. `cached_token_hosts()` returns hosts only.
#
# Removal condition  AUTHENTICATE_ASYNC: delete when upstream exposes an awaitable authenticate, or
#                    when py-oidc-auth-client's wrapper detects a running loop instead of calling
#                    asyncio.run. TOKEN_BRIDGE: delete when Freva's synchronous auth paths accept a
#                    pre-obtained token, or become awaitable themselves.
# =============================================================================================
NO_TOKEN_MESSAGE = (
    "No valid browser authentication token.\n"
    'Run: await freva_client.authenticate(host="...")'
)

REFRESH_NEEDS_AWAIT_MESSAGE = (
    "The cached access token has expired and only a refresh token remains.\n"
    "Refreshing needs the network, which a synchronous call cannot do here.\n"
    'Run: await freva_client.authenticate(host="...")'
)

# api_url -> Token. Alongside the persistent TokenStore, not instead of it.
_TOKEN_CACHE: dict = {}


def _auth_config(host=None, token_file=None):
    """Upstream's own AuthConfig, so host normalisation stays upstream's business."""
    from freva_client.utils import AuthConfig

    if token_file:
        from freva_client.utils.databrowser_utils import Config as FrevaConfig

        return AuthConfig.from_token_file(FrevaConfig(host).api_url, token_file)
    return AuthConfig(host)


async def _browser_authenticate(host=None, *, token_file=None, force=False, timeout=180, **_ignored):
    """The browser profile's `authenticate`: awaitable, device flow, no event-loop bridge."""
    from py_oidc_auth_client.flows import DeviceFlow

    auth = _auth_config(host=host, token_file=token_file)
    api_url = auth.config.host
    flow = DeviceFlow(api_url, store=auth.token_db, timeout=timeout, interactive=False)
    token = await flow.authenticate(force=force, auto_open=False)
    _TOKEN_CACHE[api_url] = token
    await _flush_storage()
    return token


async def _flush_storage() -> None:
    """Push IDBFS writes to IndexedDB, if the host mounted it.

    IDBFS keeps writes in memory until `syncfs`, so a token written and never flushed is a token
    that does not survive the reload it was persisted for. The worker installs
    `_freva_browser_syncfs` only when the host opted into persistence; without it this is a no-op
    and the session is simply in-memory.
    """
    try:
        import js  # noqa: PLC0415 - only present inside Pyodide

        flush = getattr(js, "_freva_browser_syncfs", None)
    except Exception:
        flush = None
    if flush is None:
        return
    try:
        result = flush()
        if hasattr(result, "__await__"):
            await result
    except Exception:
        # A storage flush that fails must not fail an authentication that succeeded. The token is
        # in memory and usable; only its persistence is lost.
        pass


def persistence_available() -> bool:
    """Whether the host mounted persistent storage. Reported, never assumed."""
    try:
        import js  # noqa: PLC0415

        return getattr(js, "_freva_browser_syncfs", None) is not None
    except Exception:
        return False


def _cached_token(host=None, *_args, **kwargs):
    """The synchronous bridge: a cached, unexpired token, or a clear instruction. Never network.

    Accepts both shapes upstream calls it with - `authenticate(host=...)` from
    `Config.auth_headers`, and `authenticate(host, redirect_ports=..., store=..., app_name=...)`
    from `databrowser._authenticate` - and ignores the arguments that only matter to a real login.
    """
    from py_oidc_auth_client.utils import choose_token_strategy

    host = host or kwargs.get("host")
    auth = _auth_config(host=host)
    api_url = auth.config.host

    token = _TOKEN_CACHE.get(api_url) or auth.token_db.get(api_url) or None
    strategy = choose_token_strategy(token or None)
    if strategy == "use_token" and token:
        _TOKEN_CACHE[api_url] = token
        return token
    if strategy == "refresh_token":
        raise RuntimeError(REFRESH_NEEDS_AWAIT_MESSAGE)
    raise RuntimeError(NO_TOKEN_MESSAGE)


def _patch_authenticate() -> None:
    import freva_client
    from freva_client import auth as freva_auth
    from freva_client import query
    from freva_client.utils import databrowser_utils

    if getattr(freva_auth.authenticate, "_freva_browser_patch", None) == "AUTHENTICATE_ASYNC":
        return

    _browser_authenticate._freva_browser_patch = "AUTHENTICATE_ASYNC"
    _cached_token._freva_browser_patch = "TOKEN_BRIDGE"

    # Awaitable, for the user.
    freva_auth.authenticate = _browser_authenticate
    freva_client.authenticate = _browser_authenticate

    # Synchronous, for the two upstream call sites that cannot await. Each in its OWN module,
    # because each bound a different function at import time.
    databrowser_utils.authenticate = _cached_token
    query.authenticate = _cached_token


def cached_token_hosts() -> list:
    """Which hosts have a token in the in-memory cache. Hosts only - never token values."""
    return sorted(_TOKEN_CACHE)


# =============================================================================================
def install() -> None:
    """Apply every browser patch. Idempotent; a no-op off Emscripten."""
    global _INSTALLED
    if sys.platform != "emscripten":
        return
    if _INSTALLED:
        return
    _check_versions()
    _patch_get_dirs()
    _patch_auth_config()
    _patch_flavour()
    _patch_intake_catalogue()
    _patch_authenticate()
    _INSTALLED = True


def installed_patches() -> list[str]:
    """Which patches are live. Used by the tests and by the sunset check."""
    from freva_client import utils as freva_utils
    from freva_client.utils import databrowser_utils

    live = []
    if getattr(databrowser_utils.Config.get_dirs, "_freva_browser_patch", None):
        live.append("CONFIG_GET_DIRS")
    if getattr(freva_utils.AuthConfig.__init__, "_freva_browser_patch", None):
        live.append("AUTH_CONFIG_PORTS")
    if getattr(getattr(databrowser_utils.Config.flavour, "fget", None), "_freva_browser_patch", None):
        live.append("CONFIG_FLAVOUR")
    from freva_client import query

    if getattr(query.databrowser.intake_catalogue, "_freva_browser_patch", None):
        live.append("INTAKE_CATALOGUE")
    from freva_client import auth as freva_auth
    from freva_client.utils import databrowser_utils

    if getattr(freva_auth.authenticate, "_freva_browser_patch", None):
        live.append("AUTHENTICATE_ASYNC")
    if getattr(databrowser_utils.authenticate, "_freva_browser_patch", None) and getattr(
        query.authenticate, "_freva_browser_patch", None
    ):
        live.append("TOKEN_BRIDGE")
    return live
