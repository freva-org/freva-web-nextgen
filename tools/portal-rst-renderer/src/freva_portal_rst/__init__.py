"""The exact RST helper named by ``portal-content-v1``.

The portal owns this process. It speaks one line-delimited JSON protocol, it
emits only the closed ``PortalDocumentIR`` node set, and it has no network and no
filesystem reach: ``raw``, ``include`` and file/URL-backed ``csv-table`` are
disabled, which is what the Docutils security guidance asks of any deployment
that renders material it did not write itself.

Implementing a compatible protocol is deliberately not enough to be accepted -
the builder compares the whole handshake, including this package version and the
exact Docutils version, so an approximate helper fails loudly instead of
producing subtly different HTML.
"""

from .protocol import PROTOCOL, HELPER_PACKAGE, HELPER_VERSION, handshake
from .render import render_source

__all__ = ["PROTOCOL", "HELPER_PACKAGE", "HELPER_VERSION", "handshake", "render_source"]
