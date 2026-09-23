"""Handshake and wire format."""

from __future__ import annotations

import docutils

PROTOCOL = "portal-rst-ir/1"
HELPER_PACKAGE = "freva-portal-rst"
HELPER_VERSION = "1.0.0"


def handshake() -> dict[str, str]:
    """The first line the helper writes. The builder compares every field."""
    return {
        "protocol": PROTOCOL,
        "package": HELPER_PACKAGE,
        "version": HELPER_VERSION,
        "docutils": docutils.__version__,
    }
