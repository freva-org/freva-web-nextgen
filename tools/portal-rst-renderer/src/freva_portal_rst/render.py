"""Docutils doctree to PortalDocumentIR.

Two properties matter more than completeness here.

First, the IR is *closed*: an unmapped Docutils node is an error, not a silent
drop and not a passthrough of its HTML. A construct nobody has decided about
should stop the build rather than appear differently from how the author expected.

Second, source positions are honest. Docutils reports a line for some nodes and
not for others, so each node's location is labelled `parser`, `inherited` (with
the rule and the origin node that supplied it) or `generated`. Nothing claims a
precision Docutils did not provide.
"""

from __future__ import annotations

from typing import Any

from docutils import nodes
from docutils.core import publish_doctree
from docutils.parsers.rst import directives
from docutils.parsers.rst.directives.admonitions import BaseAdmonition
from docutils.parsers.rst.directives.body import CodeBlock
from docutils.utils import SystemMessage

from .syntax import scan


class SeeAlso(BaseAdmonition):
    """`.. seealso::`, which Sphinx defines and bare docutils does not.

    The profile lists it because Sphinx-authored documentation uses it heavily,
    and a directive the profile accepts but the parser rejects is a build that
    fails on documents the schema promised to render. It is an ordinary
    admonition with a fixed title, so it lands on the portal's `note` kind by
    the same mapping as `.. admonition::`.
    """

    node_class = nodes.admonition

    def run(self):
        self.options.setdefault("class", ["seealso"])
        if not self.arguments:
            self.arguments = ["See also"]
        return super().run()


directives.register_directive("seealso", SeeAlso)


#: The one spelling of the runnable marker, shared with the Markdown lane.
RUNNABLE_OPTION = "try-in-python"


class PortalCodeBlock(CodeBlock):
    """`.. code-block::`, and the `:try-in-python:` option both spellings accept.

    Two gaps closed by one class. The profile has always listed `code-block`
    among its allowed directives - Sphinx-authored documentation is full of it -
    but bare docutils registers only `code`, so a `.. code-block:: python`
    reached the parser as an unknown directive and came out as a literal block
    of its own source. And the runnable marker needs somewhere to live that is
    not the language: `:try-in-python:` is a flag on the directive, so the
    argument still says `python` and the highlighting, the label and the reader
    all see what they saw before.

    Everything else is docutils' own `CodeBlock`, subclassed rather than
    reimplemented so `:class:`, `:name:` and `:number-lines:` keep behaving
    exactly as they do today.
    """

    option_spec = dict(CodeBlock.option_spec)
    option_spec[RUNNABLE_OPTION] = directives.flag

    def run(self):
        produced = super().run()
        if RUNNABLE_OPTION in self.options:
            for node in produced:
                if isinstance(node, nodes.literal_block):
                    node["portal_runnable"] = True
        return produced


directives.register_directive("code", PortalCodeBlock)
directives.register_directive("code-block", PortalCodeBlock)

# Docutils' admonition classes, mapped onto the portal's semantic kinds.
#
# Docutils names a smaller set than Material for MkDocs, and the two disagree
# about a few words - `caution` is its own class here and a warning there. The
# mapping is the portal's vocabulary, so a `.. caution::` and a `!!! caution`
# arrive at the same kind and are drawn the same way; the authored word survives
# as the title either way.
ADMONITION_LEVELS = {
    "note": "note",
    "seealso": "note",
    "admonition": "note",
    "hint": "tip",
    "tip": "tip",
    "important": "tip",
    "attention": "warning",
    "caution": "warning",
    "warning": "warning",
    "danger": "danger",
    "error": "danger",
}



# Titles that are not just the directive name capitalised.
ADMONITION_TITLES = {"seealso": "See also"}


class Rejected(Exception):
    def __init__(self, code: str, message: str, line: int | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.line = line


class Converter:
    def __init__(self, name: str, profile: dict[str, Any]) -> None:
        self.name = name
        self.profile = profile
        self.rules = (
            profile.get("ir", {}).get("locationProvenance", {}).get("perNodeType", {})
        )
        self.diagnostics: list[dict[str, Any]] = []
        # The document's first child that carries a line, resolved once. It is
        # what the `parent-document-first-child` rule names, and a rule that
        # names something has to be able to produce it.
        self.document_first_child: dict[str, Any] | None = None

    # -- locations ---------------------------------------------------------

    def rule_for(self, ir_type: str) -> dict[str, Any]:
        return self.rules.get(ir_type) or self.rules.get("*") or {"kind": "parser"}

    def nearest_positioned_ancestor(self, node: Any) -> tuple[Any, int] | None:
        parent = getattr(node, "parent", None)
        while parent is not None:
            line = getattr(parent, "line", None)
            if line is not None:
                return (parent, int(line))
            parent = getattr(parent, "parent", None)
        return None

    def enclosing(self, node: Any, node_class: Any) -> tuple[Any, int] | None:
        parent = getattr(node, "parent", None)
        while parent is not None:
            if isinstance(parent, node_class):
                line = getattr(parent, "line", None)
                if line is not None:
                    return (parent, int(line))
                return None
            parent = getattr(parent, "parent", None)
        return None

    def resolve_origin(
        self, rule_name: str, node: Any, origin: dict[str, Any] | None
    ) -> tuple[str, int] | None:
        """Produce the origin the *named* rule asks for, or nothing.

        Reporting `parent-figure` while having walked to whatever ancestor
        happened to carry a line would be a claim the data does not support.
        """
        if rule_name == "nearest-ancestor-with-position":
            found = self.nearest_positioned_ancestor(node)
            if found:
                return (type(found[0]).__name__, found[1])
            if origin and origin["loc"].get("line") is not None:
                return (origin["type"], origin["loc"]["line"])
            return None
        if rule_name == "parent-figure":
            found = self.enclosing(node, nodes.figure)
            return (type(found[0]).__name__, found[1]) if found else None
        if rule_name == "parent-document-first-child":
            first = self.document_first_child
            if first is None:
                return None
            return (first["type"], first["line"])
        return None

    def location(self, node: Any, ir_type: str, origin: dict[str, Any] | None) -> dict[str, Any]:
        rule = self.rule_for(ir_type)
        rule_name = rule.get("originRule", "nearest-ancestor-with-position")

        if rule.get("kind") == "generated":
            loc = {
                "kind": "generated",
                "file": self.name,
                "transform": rule.get("transform", ir_type),
            }
            resolved = self.resolve_origin(rule_name, node, origin)
            if resolved:
                loc["originType"], loc["line"] = resolved
            return loc

        line = getattr(node, "line", None)
        if line is not None:
            return {"kind": "parser", "file": self.name, "line": int(line)}

        if rule.get("fallback") == "inherited":
            resolved = self.resolve_origin(rule_name, node, origin)
            if resolved:
                return {
                    "kind": "inherited",
                    "file": self.name,
                    "line": resolved[1],
                    "originRule": rule_name,
                    "originType": resolved[0],
                }

        # The named rule could not be satisfied. Saying so is the point.
        return {
            "kind": "generated",
            "file": self.name,
            "transform": "parser-position-unavailable",
        }

    # -- conversion --------------------------------------------------------

    def children(self, node: Any, origin: dict[str, Any]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for child in node.children:
            out.extend(self.convert(child, origin))
        return out

    def simple(self, ir_type: str, node: Any, origin: dict[str, Any], **extra: Any):
        loc = self.location(node, ir_type, origin)
        me = {"loc": loc, "type": ir_type}
        return [{"type": ir_type, "loc": loc, "children": self.children(node, me), **extra}]

    def convert(self, node: Any, origin: dict[str, Any]) -> list[dict[str, Any]]:
        if isinstance(node, nodes.system_message):
            level = int(node.get("level", 1))
            self.diagnostics.append(
                {
                    "code": "PC1003" if level >= 3 else "PC1013",
                    "severity": "error" if level >= 3 else "warning",
                    "message": node.astext().replace("\n", " ")[:400],
                    "file": self.name,
                    "position": {"line": int(node.get("line") or getattr(node, "line", 0) or 1)},
                }
            )
            return []
        if isinstance(node, (nodes.comment, nodes.target, nodes.substitution_definition)):
            return []
        if isinstance(node, nodes.Text):
            return [
                {
                    "type": "text",
                    "loc": self.location(node, "text", origin),
                    "value": node.astext(),
                }
            ]
        if isinstance(node, nodes.section):
            # Sections flatten: the IR carries headings with a depth, not a tree.
            out: list[dict[str, Any]] = []
            for child in node.children:
                out.extend(self.convert(child, origin))
            return out
        if isinstance(node, nodes.title):
            # Depth is the number of enclosing sections, so a top-level RST title
            # is an h1 exactly like a top-level Markdown `#`.
            depth = 0
            parent = node.parent
            while isinstance(parent, nodes.section):
                depth += 1
                parent = parent.parent
            depth = min(depth, int(self.profile.get("limits", {}).get("maxHeadingDepth", 6)))
            loc = self.location(node, "heading", origin)
            me = {"loc": loc, "type": "heading"}
            return [
                {
                    "type": "heading",
                    "loc": loc,
                    "depth": depth,
                    "children": self.children(node, me),
                }
            ]
        if isinstance(node, nodes.paragraph):
            return self.simple("paragraph", node, origin)
        if isinstance(node, nodes.emphasis):
            return self.simple("emphasis", node, origin)
        if isinstance(node, (nodes.strong,)):
            return self.simple("strong", node, origin)
        if isinstance(node, nodes.subscript):
            return self.simple("subscript", node, origin)
        if isinstance(node, nodes.superscript):
            return self.simple("superscript", node, origin)
        if isinstance(node, nodes.literal):
            return [
                {
                    "type": "inlineCode",
                    "loc": self.location(node, "inlineCode", origin),
                    "value": node.astext(),
                }
            ]
        if isinstance(node, nodes.literal_block):
            language = None
            classes = list(node.get("classes", []))
            if node.get("language"):
                language = node.get("language")
            else:
                for cls in classes:
                    if cls not in {"code", "literal-block"}:
                        language = cls
                        break
            item = {
                "type": "code",
                "loc": self.location(node, "code", origin),
                "value": node.astext(),
            }
            if language:
                item["lang"] = language
            # Set by PortalCodeBlock when the directive carried `:try-in-python:`.
            # Whether it MEANS anything is the portal's decision, not this helper's.
            if node.get("portal_runnable"):
                item["runnable"] = True
            return [item]
        if isinstance(node, nodes.math_block):
            return [
                {
                    "type": "math",
                    "loc": self.location(node, "math", origin),
                    "value": node.astext(),
                }
            ]
        if isinstance(node, nodes.math):
            return [
                {
                    "type": "inlineMath",
                    "loc": self.location(node, "inlineMath", origin),
                    "value": node.astext(),
                }
            ]
        if isinstance(node, nodes.bullet_list):
            return self.simple("list", node, origin, ordered=False)
        if isinstance(node, nodes.enumerated_list):
            extra: dict[str, Any] = {"ordered": True}
            if node.get("start"):
                extra["start"] = int(node.get("start"))
            return self.simple("list", node, origin, **extra)
        if isinstance(node, nodes.list_item):
            return self.simple("listItem", node, origin)
        if isinstance(node, nodes.block_quote):
            return self.simple("blockquote", node, origin)
        if isinstance(node, nodes.transition):
            return [{"type": "thematicBreak", "loc": self.location(node, "thematicBreak", origin)}]
        if isinstance(node, nodes.reference):
            uri = node.get("refuri")
            if uri is None and node.get("refid"):
                uri = "#" + node.get("refid")
            if uri is None:
                uri = node.get("name") or ""
            loc = self.location(node, "link", origin)
            me = {"loc": loc, "type": "link"}
            return [
                {
                    "type": "link",
                    "loc": loc,
                    "url": uri,
                    "children": self.children(node, me),
                }
            ]
        if isinstance(node, nodes.image):
            item = {
                "type": "image",
                "loc": self.location(node, "image", origin),
                "url": node.get("uri", ""),
                "alt": node.get("alt", ""),
            }
            return [item]
        if isinstance(node, nodes.figure):
            # `:width:` lands on the image and `:align:` on the figure; both are
            # carried on the figure node, which is what the lowering reads.
            item = self.simple("figure", node, origin)[0]
            width = node.get("width")
            if width is None:
                for child in node.children:
                    if isinstance(child, nodes.image) and child.get("width"):
                        width = child.get("width")
                        break
            if width:
                item["width"] = str(width)
            align = node.get("align")
            if align in ("left", "center", "right"):
                item["align"] = align
            return [item]
        if isinstance(node, nodes.caption):
            return self.simple("caption", node, origin)
        if isinstance(node, nodes.legend):
            # The figure's longer body. A distinct node, not a container: the
            # short caption and the long legend are different things and the
            # theme draws them differently.
            return self.simple("legend", node, origin)
        if isinstance(node, nodes.definition_list):
            return self.simple("definitionList", node, origin)
        if isinstance(node, nodes.definition_list_item):
            return self.children(node, origin)
        if isinstance(node, nodes.term):
            return self.simple("definitionTerm", node, origin)
        if isinstance(node, nodes.definition):
            return self.simple("definitionDescription", node, origin)
        if isinstance(node, nodes.container):
            return self.simple("container", node, origin)
        if isinstance(node, nodes.topic):
            # `.. contents::` becomes the framework's own table of contents.
            return [{"type": "tableOfContents", "loc": self.location(node, "tableOfContents", origin)}]
        if isinstance(node, nodes.Admonition):
            name = type(node).__name__
            level = ADMONITION_LEVELS.get(name, "note")
            loc = self.location(node, "admonition", origin)
            me = {"loc": loc, "type": "admonition"}
            children = []
            title = None
            for child in node.children:
                if isinstance(child, nodes.title):
                    title = child.astext()
                    continue
                children.extend(self.convert(child, me))
            item = {"type": "admonition", "loc": loc, "level": level, "children": children}
            # An untitled `.. caution::` still says "Caution", not "Warning".
            # The kind decides how the block is drawn; the authored word is what
            # the reader was told, and it survives as the title.
            if not title and name != "admonition":
                title = ADMONITION_TITLES.get(name, name.replace("_", " ").capitalize())
            if title:
                item["title"] = title
            return item and [item]
        if isinstance(node, nodes.table):
            return self.convert_table(node, origin)
        if isinstance(node, nodes.footnote):
            loc = self.location(node, "footnoteDefinition", origin)
            me = {"loc": loc, "type": "footnoteDefinition"}
            identifier = (node.get("names") or node.get("ids") or ["1"])[0]
            children = [
                item
                for child in node.children
                if not isinstance(child, nodes.label)
                for item in self.convert(child, me)
            ]
            return [
                {
                    "type": "footnoteDefinition",
                    "loc": loc,
                    "identifier": str(identifier),
                    "children": children,
                }
            ]
        if isinstance(node, nodes.footnote_reference):
            identifier = node.get("refname") or node.astext()
            return [
                {
                    "type": "footnoteReference",
                    "loc": self.location(node, "footnoteReference", origin),
                    "identifier": str(identifier),
                    "label": node.astext(),
                }
            ]
        if isinstance(node, nodes.title_reference):
            return self.simple("emphasis", node, origin)
        if isinstance(node, nodes.problematic):
            return []

        raise Rejected(
            "PC1003",
            f"RST construct '{type(node).__name__}' has no portal-content-v1 representation.",
            getattr(node, "line", None),
        )

    def convert_table(self, node: Any, origin: dict[str, Any]) -> list[dict[str, Any]]:
        loc = self.location(node, "table", origin)
        me = {"loc": loc, "type": "table"}
        rows: list[dict[str, Any]] = []
        align: list[Any] = []
        caption: dict[str, Any] | None = None
        for group in node.children:
            # `.. table:: A caption` puts the title here, as a direct child of
            # the table and outside every tgroup. Skipping it - which is what
            # looking only for tgroups does - silently drops authored text.
            if isinstance(group, nodes.title):
                caption_loc = self.location(group, "tableCaption", me)
                caption = {
                    "type": "tableCaption",
                    "loc": caption_loc,
                    "children": self.children(
                        group, {"loc": caption_loc, "type": "tableCaption"}
                    ),
                }
                continue
            if not isinstance(group, nodes.tgroup):
                continue
            for part in group.children:
                if isinstance(part, nodes.colspec):
                    align.append(None)
                    continue
                if not isinstance(part, (nodes.thead, nodes.tbody)):
                    continue
                header = isinstance(part, nodes.thead)
                for row in part.children:
                    row_loc = self.location(row, "tableRow", me)
                    row_me = {"loc": row_loc, "type": "tableRow"}
                    cells = []
                    for entry in row.children:
                        cell_loc = self.location(entry, "tableCell", row_me)
                        cell_me = {"loc": cell_loc, "type": "tableCell"}
                        cell = {
                            "type": "tableCell",
                            "loc": cell_loc,
                            "children": self.children(entry, cell_me),
                        }
                        if header:
                            cell["header"] = True
                        cells.append(cell)
                    row_ir = {"type": "tableRow", "loc": row_loc, "children": cells}
                    # Docutils says which rows are the head. A table with no
                    # thead - a body-only list-table, for instance - must not
                    # acquire one downstream.
                    if header:
                        row_ir["header"] = True
                    rows.append(row_ir)
        # The caption is the table's first child, which is where HTML requires
        # `<caption>` to be and what the lowering relies on.
        children = ([caption] if caption is not None else []) + rows
        return [{"type": "table", "loc": loc, "align": align, "children": children}]


def render_source(source: str, name: str, profile: dict[str, Any]) -> dict[str, Any]:
    """Parse one RST document and return `{document, diagnostics}`."""
    rst_profile = profile.get("rst", {})
    diagnostics: list[dict[str, Any]] = []

    for code, line, message in scan(
        source,
        rst_profile.get("allowedDirectives", []),
        rst_profile.get("allowedRoles", []),
    ):
        diagnostics.append(
            {
                "code": code,
                "severity": "error",
                "message": message,
                "file": name,
                "position": {"line": line},
            }
        )
    if diagnostics:
        return {"diagnostics": diagnostics}

    settings = {
        "file_insertion_enabled": False,
        "raw_enabled": False,
        "report_level": 2,
        "halt_level": 3,
        "input_encoding": "utf-8",
        "embed_stylesheet": False,
        "_disable_config": True,
        "syntax_highlight": "none",
        "doctitle_xform": False,
        "sectsubtitle_xform": False,
        "docinfo_xform": False,
        "warning_stream": False,
        "strip_comments": True,
    }
    settings.update(
        {k: v for k, v in rst_profile.get("settings", {}).items() if k in settings}
    )

    try:
        doctree = publish_doctree(source, source_path=name, settings_overrides=settings)
    except SystemMessage as exc:
        return {
            "diagnostics": [
                {
                    "code": "PC1003",
                    "severity": "error",
                    "message": str(exc).replace("\n", " ")[:400],
                    "file": name,
                    "position": {"line": 1},
                }
            ]
        }

    converter = Converter(name, profile)
    root_loc = {"kind": "generated", "file": name, "transform": "document"}
    origin = {"loc": root_loc, "type": "root"}
    for child in doctree.children:
        child_line = getattr(child, "line", None)
        if child_line is not None:
            converter.document_first_child = {
                "type": type(child).__name__,
                "line": int(child_line),
            }
            break
    try:
        children = converter.children(doctree, origin)
    except Rejected as exc:
        entry = {
            "code": exc.code,
            "severity": "error",
            "message": exc.message,
            "file": name,
        }
        if exc.line:
            entry["position"] = {"line": int(exc.line)}
        return {"diagnostics": converter.diagnostics + [entry]}

    if any(d["severity"] == "error" for d in converter.diagnostics):
        return {"diagnostics": converter.diagnostics}

    return {
        "document": {
            "type": "root",
            "loc": root_loc,
            "frontmatter": {},
            "children": children,
        },
        "diagnostics": converter.diagnostics,
    }
