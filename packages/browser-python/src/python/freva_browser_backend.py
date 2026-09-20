"""A Matplotlib backend whose ``show()`` marks figures for the console to collect.

Why a backend rather than patching ``plt.show`` after the fact.

The patch used to be applied from ``capture_figures()``, which runs AFTER the user's command has
finished. On a fresh interpreter that is one command too late::

    import matplotlib.pyplot as plt; plt.plot([1, 4, 9]); plt.show()

Here the import, the plot and the ``show()`` all happen inside a single submission: the real
``show()`` runs, nothing is marked, the collection that follows finds no marked figures and returns
nothing - and only then is ``show`` patched. The user's first plot silently does not appear, which
is the worst possible first impression for a plotting console. The same is true of any
``engine.run()`` whose source both imports pyplot and shows a figure.

Matplotlib resolves its backend when pyplot is first imported, so a backend module is hooked in
from the very first import - there is no window in which the wrong ``show`` is live. ``MPLBACKEND``
is set to ``module://freva_browser_backend`` in ``rich_display``, before anything can import
Matplotlib.

Drawing is Agg's, unchanged: this is Agg plus a ``show()`` that records which figures the user
asked to see.
"""

from __future__ import annotations

from matplotlib.backends.backend_agg import FigureCanvasAgg, FigureManagerBase

import rich_display

# The names Matplotlib looks for on a backend module.
FigureCanvas = FigureCanvasAgg
FigureManager = FigureManagerBase


def show(*_args, **_kwargs):
    """Mark every open figure for display. The console renders them after this execution.

    Not a draw. Rendering happens once the command is over, in ``rich_display.capture_figures()``,
    because that is the point at which the payloads can be handed to the transport. ``show()``
    only records the intent - which is exactly what it means everywhere else.
    """
    from matplotlib import _pylab_helpers

    for manager in _pylab_helpers.Gcf.get_all_fig_managers():
        rich_display.mark_figure(manager.num)
