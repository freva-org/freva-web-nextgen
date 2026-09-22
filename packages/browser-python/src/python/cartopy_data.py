"""On-demand Natural Earth data for Cartopy, in a browser.

Why this exists
---------------
Cartopy draws its coastlines, borders and land polygons from Natural Earth shapefiles that it
downloads on first use. In a browser neither half of that works:

* ``urllib.request.urlopen`` - which Cartopy's downloader uses - has no socket in Pyodide. It does
  not raise a clear "no network here"; it fails somewhere inside the socket module, and the
  traceback a reader sees has nothing to do with maps.
* ``naturalearth.s3.amazonaws.com``, the host Cartopy asks, serves no
  ``Access-Control-Allow-Origin`` header, so even a working transport would be refused by the
  browser before the bytes arrived. Loosening a Content-Security-Policy does not change that: CORS
  is the server's decision, not the page's.

So a portal could prepare the 110m files and ``ax.coastlines()`` would work, and the moment a reader
drew a regional map - where Cartopy AUTOMATICALLY selects 50m or 10m - it stopped working, with an
error about sockets.

What this does
--------------
Registers one Cartopy downloader, for one key: ``('shapefiles', 'natural_earth')``. It keeps
Cartopy's own path templates, so the lookup order is unchanged - a prepared file under
``CARTOPY_DATA_DIR`` is found and nothing is fetched; a file already downloaded this session is
found in Cartopy's own cache; only a genuine miss is fetched, and it is written where Cartopy
expects it so the next draw finds it too.

The two things it replaces are the URL and the transport:

* the URL is the same pinned Natural Earth release the prepared add-on is built from -
  ``nvkelso/natural-earth-vector`` at a tag, served by raw.githubusercontent.com, which DOES send
  ``Access-Control-Allow-Origin: *``. Same data, same version, a host a browser can actually read.
* the transport is ``pyodide.ffi.run_sync`` over ``pyfetch``. Cartopy's downloader API is
  synchronous, so a ``fetch`` promise cannot be awaited from inside it - and a synchronous
  ``XMLHttpRequest``, the usual answer, was measured to BLOCK FOREVER in this Worker. Stack
  switching is the mechanism this package already uses to put a synchronous call on an
  asynchronous fetch; see ``_fetch``.

Scope, stated plainly
---------------------
This patches CARTOPY. It does not replace ``urllib``, it does not install an opener, and it does not
touch any other library's downloads - a global transport shim would change the behaviour of every
package a visitor installs, which is exactly the kind of invisible difference that makes a browser
Python session untrustworthy.

Nothing here is forced: resolutions, features and a local data directory all keep working as they
do anywhere else, and a deployment that prepares more data simply sees fewer fetches.
"""

from __future__ import annotations

import sys

#: The pinned Natural Earth release, and the only host this module fetches from.
#:
#: The tag is pinned for the same reason the prepared add-on pins it: "the coastlines moved" is not
#: an acceptable thing for a figure to do between two runs of the same notebook. It is the SAME tag
#: the add-on uses, so a session that has some files prepared and fetches others is not mixing two
#: releases of the dataset.
MIRROR_TEMPLATE = (
    "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/"
    "v5.1.2/{resolution}_{category}/ne_{resolution}_{name}{extension}"
)

#: What a shapefile needs to be readable, and what is merely nice to have.
#:
#: ``.shp`` is the geometry, ``.shx`` its index and ``.dbf`` the attributes - pyshp opens all three
#: and a missing one is a broken read. ``.prj`` (the projection) and ``.cpg`` (the encoding) are
#: optional in the format and are not present for every layer in the upstream repository, so a 404
#: on one of them is not a failure.
REQUIRED_EXTENSIONS = (".shp", ".shx", ".dbf")
OPTIONAL_EXTENSIONS = (".prj", ".cpg")


class MirrorUnavailable(OSError):
    """A Natural Earth file could not be fetched. Raised with the URL and the status."""


def _fetch(url):
    """Fetch one URL as bytes, synchronously, or raise `MirrorUnavailable`.

    SYNCHRONOUS OVER AN ASYNCHRONOUS TRANSPORT, which needs explaining because the obvious answers
    do not work here.

    Cartopy's ``Downloader.acquire_resource`` is a plain method called from plain plotting code:
    there is no coroutine to await in and no event loop turn available, so ``pyfetch`` alone returns
    a coroutine that nothing can run. The usual escape is a synchronous ``XMLHttpRequest``, which a
    Worker is nominally allowed - and it does not work in this one. Measured, in the shipped console
    under its own deployment policy: ``open_url`` and a hand-rolled sync XHR both BLOCK FOREVER,
    printing nothing and never returning the Worker to idle. A hang is the worst failure mode
    available, so it is not what this ships.

    What does work is the mechanism this package already depends on for exactly this shape of
    problem: WebAssembly stack switching. ``run_sync`` suspends the Python stack while a JavaScript
    promise settles, which is how a synchronous Zarr decode calls an asynchronous fetch underneath
    it - see the JSPI note in the Worker's start-up. The same primitive makes a synchronous
    downloader API sit on ``pyfetch``.

    Without JSPI this raises rather than hangs, and says which capability is missing. A browser
    without stack switching gets prepared data and no on-demand downloads, which is a smaller
    console than the one this aims at and a working one.
    """
    try:
        from pyodide.ffi import run_sync
        from pyodide.http import pyfetch
    except ImportError as exc:  # pragma: no cover - only outside Pyodide
        raise MirrorUnavailable(
            "Natural Earth data can only be fetched from inside the browser interpreter"
        ) from exc

    async def _get():
        response = await pyfetch(url)
        if response.status != 200:
            raise MirrorUnavailable(f"{url}: HTTP {response.status}")
        return await response.bytes()

    try:
        return run_sync(_get())
    except MirrorUnavailable:
        raise
    except Exception as exc:
        # A refusal by the browser - CORS, or a policy that does not permit the origin - and a
        # missing JSPI both land here. The URL and the underlying message are what a reader needs.
        raise MirrorUnavailable(f"{url}: {type(exc).__name__}: {exc}") from exc


def _install_downloader(shapereader):
    """Replace the `('shapefiles', 'natural_earth')` downloader with the mirrored one."""
    import cartopy

    key = ("shapefiles", "natural_earth")
    existing = cartopy.config["downloaders"].get(key)
    if existing is None:  # pragma: no cover - Cartopy always registers one
        existing = shapereader.NEShpDownloader.default_downloader()

    class MirroredNEDownloader(shapereader.NEShpDownloader):
        """Cartopy's own downloader, with a reachable host and a transport that exists.

        Everything else is inherited, deliberately: `path()` still checks the pre-downloaded
        directory first, then the cache, and only then calls `acquire_resource` - so the prepared
        add-on still short-circuits every fetch, and a second draw in one session reads the file
        written by the first.
        """

        def url(self, format_dict):
            return MIRROR_TEMPLATE.format(extension=".shp", **format_dict)

        def acquire_resource(self, target_path, format_dict):
            """Fetch the shapefile and its companions beside it, then hand back the path.

            The upstream repository stores the parts UNZIPPED, one file per extension, which is why
            this does not reuse the base class's zip handling: there is no archive to open. The
            files land exactly where Cartopy asked for them, under the names Cartopy expects.
            """
            from pathlib import Path

            target = Path(target_path)
            target.parent.mkdir(parents=True, exist_ok=True)
            stem = target.with_suffix("")

            fetched = {}
            for extension in REQUIRED_EXTENSIONS:
                fetched[extension] = _fetch(
                    MIRROR_TEMPLATE.format(extension=extension, **format_dict)
                )
            for extension in OPTIONAL_EXTENSIONS:
                try:
                    fetched[extension] = _fetch(
                        MIRROR_TEMPLATE.format(extension=extension, **format_dict)
                    )
                except MirrorUnavailable:
                    pass  # not every layer has one; see OPTIONAL_EXTENSIONS

            # Nothing is written until every required part has arrived, so a half-fetched
            # layer cannot be left behind for the next draw to find and trust.
            for extension, payload in fetched.items():
                stem.with_suffix(extension).write_bytes(payload)
            return str(target)

    mirrored = MirroredNEDownloader(
        url_template=MIRROR_TEMPLATE,
        target_path_template=existing.target_path_template,
        pre_downloaded_path_template=existing.pre_downloaded_path_template,
    )
    cartopy.config["downloaders"][key] = mirrored
    return mirrored


class _ShapereaderFinder:
    """Arm the replacement for the moment `cartopy.io.shapereader` is first imported.

    A meta-path finder rather than an import at startup, because importing Cartopy pulls in
    Matplotlib, SciPy and Shapely - several megabytes of wheels that a session which never draws a
    map should not pay for. The engine's whole loading strategy is that the plotting stack arrives
    on the first `import`, and this has to not defeat it.

    It answers for exactly one module name and delegates everything else, so no other import in the
    interpreter changes shape because this is installed.
    """

    TARGET = "cartopy.io.shapereader"

    def find_spec(self, fullname, path=None, target=None):
        if fullname != self.TARGET:
            return None
        import importlib.util

        # Step aside while the normal machinery builds the spec, or this would find itself.
        try:
            sys.meta_path.remove(self)
        except ValueError:  # pragma: no cover - only if something else removed it first
            return None
        try:
            spec = importlib.util.find_spec(fullname)
        finally:
            sys.meta_path.insert(0, self)
        if spec is None or spec.loader is None:
            return None
        spec.loader = _AfterExec(spec.loader)
        return spec


class _AfterExec:
    """The real loader, plus one call once the module's own code has run."""

    def __init__(self, inner):
        self._inner = inner

    def create_module(self, spec):
        return self._inner.create_module(spec)

    def exec_module(self, module):
        self._inner.exec_module(module)
        try:
            _install_downloader(module)
        except Exception as exc:  # never break `import cartopy` over this
            print(
                "browser-python: Natural Earth downloads are unavailable "
                f"({type(exc).__name__}: {exc}). Prepared data still works.",
                file=sys.stderr,
            )

    def __getattr__(self, name):
        return getattr(self._inner, name)


def install():
    """Arm the adaptation. Idempotent, and cheap when no map is ever drawn.

    Returns a short status string for the ready event: `"armed"` when the hook is in place and
    Cartopy has not been imported yet, `"installed"` when Cartopy was already loaded and the
    downloader was replaced immediately.
    """
    if any(isinstance(finder, _ShapereaderFinder) for finder in sys.meta_path):
        return "armed"

    if "cartopy.io.shapereader" in sys.modules:
        # Already imported - patch what is there rather than waiting for an import that has been.
        _install_downloader(sys.modules["cartopy.io.shapereader"])
        return "installed"

    sys.meta_path.insert(0, _ShapereaderFinder())
    return "armed"
