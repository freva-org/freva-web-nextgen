"""The display bridge: turn Matplotlib figures into protocol payloads.

Matplotlib's default Pyodide backend draws into a canvas and therefore reaches for ``document`` and
``window``. Neither exists in a Worker, so the first ``import matplotlib.pyplot`` there fails with
``ReferenceError: window is not defined`` - and it fails at IMPORT, before any user code has had a
chance to choose a backend. ``MPLBACKEND`` is read when the library first configures itself, so the
only reliable place to set it is here, before anything can import Matplotlib.

Nothing in this module imports Matplotlib. That is deliberate: a wheel that is only needed by people
who plot should be fetched when they plot, not during startup because plotting is *supported*.
``figures_pending()`` answers "has anyone imported it yet" by looking in ``sys.modules``, which is
free.
"""

from __future__ import annotations

import base64
import io
import os
import sys

# Set BEFORE any possible Matplotlib import. See the module docstring.
#
# A backend module, not plain "Agg". Matplotlib resolves its backend when pyplot is first imported,
# so this is hooked in from that very first import - which is the only way a single submission like
# `import matplotlib.pyplot as plt; plt.plot([1, 4, 9]); plt.show()` can work. Patching `plt.show`
# afterwards is one command too late: the real `show()` has already run and marked nothing.
# `freva_browser_backend` is Agg's drawing plus a `show()` that records the intent.
os.environ.setdefault("MPLBACKEND", "module://freva_browser_backend")

# What a figure is rendered to. PNG only for now: the protocol carries PNG and text, and SVG would
# be markup this package would then be implying is safe to inject. See protocol.ts.
_FORMAT = "png"
_MIME = "image/png"


def matplotlib_imported():
    """True once the user's code has actually imported pyplot. Costs one dict lookup."""
    return "matplotlib.pyplot" in sys.modules


_MARKED = set()
"""Figure numbers that `plt.show()` asked to display, cleared each time they are collected."""


def mark_figure(number):
    """Record that the user asked to see this figure. Called by the backend's ``show()``."""
    _MARKED.add(int(number))


def _configure(pyplot):
    """Belt and braces: make ``plt.show()`` mark figures even if the backend is not ours.

    The backend does this properly, from Matplotlib's first import. This stays for the case where a
    consumer sets ``MPLBACKEND`` themselves, or replaces ``plt.show`` in their own code - it costs a
    dict lookup per execution and means the console still behaves if the backend is not in play.
    Under plain Agg it also silences ``FigureCanvasAgg is non-interactive, and thus cannot be
    shown``, a warning that is right for a script and wrong here.
    """
    if getattr(pyplot, "_freva_browser_python_patched", False):
        return

    def _show(*_args, **_kwargs):
        """Mark every open figure for display. The console renders them after this execution."""
        for number in pyplot.get_fignums():
            mark_figure(number)

    pyplot.show = _show
    pyplot._freva_browser_python_patched = True


def capture_figures():
    """Render the figures that ``show()`` asked for, and return protocol-shaped dicts.

    Explicit show, and this is a deliberate change from rendering-and-closing everything open.

    The old rule - after every command, draw all open figures and close them - made the one-liner
    work and made everything else impossible. A figure is normally BUILT over several commands::

        fig, ax = plt.subplots()
        ax.plot(temperature)
        ax.set_title("2m air temperature")
        plt.show()

    Under the old rule the first line displayed an empty pair of axes and then closed the figure, so
    `ax` referred to something detached and the next two commands drew into nothing. Every plot had
    to be a single pasted block, which is not what a console is for.

    Now `plt.show()` marks what to display, exactly as it does in any other Python session, and only
    marked figures are rendered and closed. A figure nobody showed stays open and stays yours.

    The cost is that a bare `plt.plot(...)` no longer draws anything by itself - `plt.show()` is
    required, as it is outside a notebook. The gain is that building a figure across several
    commands works at all. Unshown figures do accumulate; Matplotlib's own `figure.max_open_warning`
    is what warns about that, and it is left in place rather than second-guessed here.

    Returns ``[]`` - never raises - when Matplotlib was never imported, which is the common case and
    is checked on every execution.
    """
    if not matplotlib_imported():
        return []

    import matplotlib.pyplot as plt

    _configure(plt)

    rendered = []
    # Only what was shown, and only what still exists: a figure the user closed by hand between
    # `show()` and now is not an error, it is just gone.
    open_now = set(plt.get_fignums())
    wanted = sorted(_MARKED & open_now)
    _MARKED.clear()
    for number in wanted:
        figure = plt.figure(number)
        buffer = io.BytesIO()
        try:
            figure.savefig(buffer, format=_FORMAT, bbox_inches="tight")
        except Exception as exc:  # a broken figure must not take the whole execution with it
            plt.close(figure)
            rendered.append(
                {
                    "mime": "text/plain",
                    "encoding": "utf8",
                    "data": "Figure %d could not be rendered: %s" % (number, exc),
                    "metadata": {"figure": number},
                }
            )
            continue

        size = figure.get_size_inches() * figure.dpi
        plt.close(figure)
        rendered.append(
            {
                "mime": _MIME,
                "encoding": "base64",
                "data": base64.b64encode(buffer.getvalue()).decode("ascii"),
                "metadata": {
                    "figure": number,
                    "width": int(size[0]),
                    "height": int(size[1]),
                },
            }
        )
    return rendered


# MIME bundles
#
# Notebook cells and `display()` publish Jupyter-style MIME bundles. Every limit is checked BEFORE
# the costly step (base64, JSON, the trip to JavaScript); the same limits are enforced again at the
# worker and engine boundaries (`protocol.ts`), which are the ones that count.

TEXT_LIMIT = 256 * 1024
HTML_LIMIT = 1024 * 1024
SVG_LIMIT = 4 * 1024 * 1024
PNG_BYTES_LIMIT = 18 * 1024 * 1024
BUNDLE_LIMIT = 24 * 1024 * 1024

_TEXT_MIMES = {"text/plain": TEXT_LIMIT, "text/html": HTML_LIMIT, "image/svg+xml": SVG_LIMIT}
_REPR_METHODS = (
    ("text/html", "_repr_html_"),
    ("image/svg+xml", "_repr_svg_"),
    ("image/png", "_repr_png_"),
)
_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"

_publisher = None
_cell_mode = False


def set_publisher(callback):
    """The worker's sink for bundles: called with one JSON string per message."""
    global _publisher
    _publisher = callback


def _publish(message):
    import json

    if _publisher is None:
        return False
    _publisher(json.dumps(message, ensure_ascii=False, separators=(",", ":")))
    return True


def begin_cell():
    global _cell_mode
    _cell_mode = True
    _MARKED.clear()


def end_cell():
    global _cell_mode
    _cell_mode = False


def cell_mode():
    return _cell_mode


def _mib(n):
    return "%.1f MiB" % (n / 1048576) if n >= 1048576 else "%d KiB" % max(1, round(n / 1024))


def _method(obj, name):
    """A repr method of the object's TYPE: `__getattr__` that answers every name is not a repr."""
    if isinstance(obj, type):
        return None
    try:
        if getattr(type(obj), name, None) is None:
            return None
        found = getattr(obj, name)
    except Exception:
        return None
    return found if callable(found) else None


def _numbers(meta):
    out = {}
    if isinstance(meta, dict):
        for key in ("width", "height"):
            value = meta.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                if 0 < value <= 100000:
                    out[key] = value
    return out


class _Bundle:
    def __init__(self, label):
        self.label = label
        self.data = {}
        self.metadata = {}
        self.problems = []
        self.size = 0

    def add(self, mime, value, meta=None):
        if mime in self.data or value is None:
            return
        if mime == "image/png":
            if isinstance(value, (bytes, bytearray, memoryview)):
                raw = bytes(value)
                if len(raw) > PNG_BYTES_LIMIT:
                    return self._over(mime, len(raw), PNG_BYTES_LIMIT)
                if not raw.startswith(_PNG_SIGNATURE):
                    return self.problems.append("%s: image/png is not a PNG" % self.label)
                text = base64.b64encode(raw).decode("ascii")
            elif isinstance(value, str):
                text = value.replace("\n", "")
                if len(text) > PNG_BYTES_LIMIT * 4 // 3 + 4:
                    return self._over(mime, len(text) * 3 // 4, PNG_BYTES_LIMIT)
            else:
                return self.problems.append("%s: image/png must be bytes" % self.label)
        else:
            if mime == "image/svg+xml" and isinstance(value, (bytes, bytearray)):
                if len(value) > SVG_LIMIT:
                    return self._over(mime, len(value), SVG_LIMIT)
                value = bytes(value).decode("utf-8", "replace")
            if not isinstance(value, str):
                return self.problems.append(
                    "%s: %s must be text, not %s" % (self.label, mime, type(value).__name__)
                )
            limit = _TEXT_MIMES[mime]
            if len(value) > limit:
                return self._over(mime, len(value), limit)
            text = value
        if self.size + len(text) > BUNDLE_LIMIT:
            return self._over(mime, self.size + len(text), BUNDLE_LIMIT, "this output")
        self.size += len(text)
        self.data[mime] = text
        numbers = _numbers(meta)
        if numbers:
            self.metadata[mime] = numbers

    def _over(self, mime, size, limit, what=None):
        self.problems.append(
            "%s: %s is %s, over the %s limit for %s; showing a simpler form"
            % (self.label, mime, _mib(size), _mib(limit), what or "one representation")
        )

    def broken(self, method, exc):
        self.problems.append(
            "%s.%s() raised %s: %s; showing a simpler form"
            % (self.label, method, type(exc).__name__, _short(exc))
        )


def _short(exc):
    try:
        text = str(exc)
    except Exception:
        text = "<unprintable>"
    return text if len(text) <= 300 else text[:300] + "..."


def _plain(obj):
    try:
        from pyodide.console import repr_shorten

        return repr_shorten(obj, limit=4000)
    except Exception as exc:
        return "<unrepresentable %s: %s>" % (type(obj).__name__, _short(exc))


def format_bundle(obj):
    """MIME bundle for one object: `_repr_mimebundle_`, then `_repr_html_`, `_repr_svg_`,
    `_repr_png_`, a Matplotlib figure as PNG, and always a plain-text fallback."""
    bundle = _Bundle(type(obj).__name__)
    method = _method(obj, "_repr_mimebundle_")
    if method is not None:
        try:
            try:
                result = method(include=None, exclude=None)
            except TypeError:
                result = method()
        except Exception as exc:
            bundle.broken("_repr_mimebundle_", exc)
            result = None
        meta = {}
        if isinstance(result, tuple) and len(result) == 2:
            result, meta = result
        if isinstance(result, dict):
            for mime in ("text/plain", "text/html", "image/svg+xml", "image/png"):
                if mime in result:
                    bundle.add(mime, result[mime], meta.get(mime) if isinstance(meta, dict) else None)
    for mime, name in _REPR_METHODS:
        if mime in bundle.data:
            continue
        method = _method(obj, name)
        if method is None:
            continue
        try:
            value = method()
        except Exception as exc:
            bundle.broken(name, exc)
            continue
        meta = None
        if isinstance(value, tuple) and len(value) == 2:
            value, meta = value
        bundle.add(mime, value, meta)
    if "image/png" not in bundle.data and _is_figure(obj):
        try:
            png, meta = _figure_png(obj)
            bundle.add("image/png", png, meta)
        except Exception as exc:
            bundle.broken("savefig", exc)
    if not isinstance(bundle.data.get("text/plain"), str):
        bundle.data.pop("text/plain", None)
        bundle.data["text/plain"] = _plain(obj)[:TEXT_LIMIT]
    return bundle


def _is_figure(obj):
    module = sys.modules.get("matplotlib.figure")
    return module is not None and isinstance(obj, getattr(module, "Figure", ()))


def _figure_png(figure):
    buffer = io.BytesIO()
    figure.savefig(buffer, format=_FORMAT, bbox_inches="tight")
    size = figure.get_size_inches() * figure.dpi
    return buffer.getvalue(), {"width": int(size[0]), "height": int(size[1])}


def _report(problems):
    for problem in problems:
        sys.stderr.write("[display] %s\n" % problem)


def _emit(kind, bundle, extra=None):
    _report(bundle.problems)
    message = {"output": kind, "data": bundle.data}
    if bundle.metadata:
        message["metadata"] = bundle.metadata
    if extra:
        message.update(extra)
    return _publish(message)


def publish_result(value, count):
    """The cell's last expression, as `execute_result`."""
    _emit("execute_result", format_bundle(value), {"executionCount": count})


def display(*objs, raw=False, metadata=None, clear=False, **_ignored):
    """Show objects below the running code, like IPython's ``display``.

    ``raw=True`` takes ready-made bundles (``{"text/html": ...}``). Only text/plain, text/html,
    image/svg+xml and image/png are carried; anything else is dropped.
    """
    if clear:
        clear_output(wait=True)
    for obj in objs:
        if raw:
            bundle = _Bundle("display(raw=True)")
            if isinstance(obj, dict):
                for mime in ("text/plain", "text/html", "image/svg+xml", "image/png"):
                    if mime in obj:
                        bundle.add(mime, obj[mime], (metadata or {}).get(mime))
            if "text/plain" not in bundle.data:
                bundle.data["text/plain"] = "<%d representation(s)>" % len(bundle.data)
        else:
            bundle = format_bundle(obj)
        if not _emit("display_data", bundle):
            print(bundle.data.get("text/plain", ""))


def clear_output(wait=False):
    """Clear this cell's output, now or (``wait=True``) when the next output arrives."""
    _publish({"output": "clear_output", "wait": bool(wait)})


def show_now():
    """`plt.show()` in a notebook cell: draw every open figure here, in order, then close it."""
    flush_figures()


def flush_figures():
    """End of a cell: display every open figure and close it, as IPython's inline backend does."""
    if not matplotlib_imported():
        return
    import matplotlib.pyplot as plt

    for number in plt.get_fignums():
        figure = plt.figure(number)
        bundle = _Bundle("Figure %d" % number)
        try:
            png, meta = _figure_png(figure)
            bundle.add("image/png", png, meta)
        except Exception as exc:
            bundle.broken("savefig", exc)
        finally:
            plt.close(figure)
        bundle.data["text/plain"] = "<Figure %d>" % number
        _emit("display_data", bundle)


def install_builtins():
    """`display` and `clear_output` without an import, as in Jupyter."""
    import builtins

    builtins.display = display
    builtins.clear_output = clear_output
