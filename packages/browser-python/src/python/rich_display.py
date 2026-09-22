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
