"""Directive and role gate.

Docutils will happily render a `topic`, a `sidebar` or a `meta` directive, and
several of those carry capabilities the portal profile does not accept. Relying
on "Docutils reported an error" would therefore accept whatever the installed
Docutils happens to support today. The accepted vocabulary is instead read from
the profile the builder sends, and everything else is refused by name before the
document is parsed.
"""

from __future__ import annotations

import re
from typing import Iterable

DIRECTIVE_RE = re.compile(r"^\s*\.\.\s+([A-Za-z][\w+:.-]*)\s*::")
ROLE_RE = re.compile(r"(?<![`\w]):([a-zA-Z][\w+:.-]*):`")
ROLE_DEF_RE = re.compile(r"^\s*\.\.\s+role\s*::")


def scan(source: str, allowed_directives: Iterable[str], allowed_roles: Iterable[str]):
    """Yield (code, line, message) for every construct outside the profile."""
    allowed_d = set(allowed_directives)
    allowed_r = set(allowed_roles)
    in_literal_block = False
    literal_indent = 0

    for number, line in enumerate(source.splitlines(), start=1):
        stripped = line.strip()

        # A literal block's contents are text, not markup: `.. raw:: html` inside
        # a code sample is a documented example, not an attempt to inject.
        if in_literal_block:
            indent = len(line) - len(line.lstrip())
            if stripped and indent <= literal_indent:
                in_literal_block = False
            else:
                continue

        match = DIRECTIVE_RE.match(line)
        if match:
            name = match.group(1)
            if name not in allowed_d:
                yield (
                    "PC1003",
                    number,
                    f"RST directive '{name}' is not part of portal-content-v1.",
                )
            if name in {"code", "code-block", "math"}:
                in_literal_block = True
                literal_indent = len(line) - len(line.lstrip())
            continue

        if stripped.endswith("::") and stripped != "::" and not stripped.startswith(".."):
            in_literal_block = True
            literal_indent = len(line) - len(line.lstrip())

        for role in ROLE_RE.findall(line):
            if role not in allowed_r:
                yield (
                    "PC1004",
                    number,
                    f"RST role '{role}' is not part of portal-content-v1.",
                )
