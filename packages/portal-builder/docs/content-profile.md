# `portal-content-v1`

One named profile, not a plugin collection. Its normative form is
[`portal-content-v1.profile.json`](../schema/portal-content-v1.profile.json);
this page explains it. The artifact records the profile's name and its SHA-256
digest, so it is always possible to say exactly which rules produced a page.

Consumers do not choose remark, rehype, Docutils, Mermaid, maths or highlighting
plugins. That is the whole point: the complicated details exist once, in a place
that has tests, rather than being re-decided in every project.

## Pipeline

Markdown and RST produce the _same_ closed intermediate representation, and
everything after that happens once:

1. discover the source and derive its route;
2. parse and validate frontmatter;
3. select the pinned Markdown parser or the exact RST helper by extension;
4. produce source-positioned `PortalDocumentIR`;
5. normalize the title, headings, ids and table of contents;
6. render code, diagrams and mathematics **at build time**;
7. rewrite internal document and asset references;
8. lower to an HTML tree and sanitize it against the profile allowlist;
9. validate links, fragments, accessibility metadata and output limits;
10. serialize a static HTML fragment.

Sanitization is last, after the transforms that add markup. Anything that
modified the tree afterwards could undo it.

## Markdown

| Area        | Behaviour                                                           |
| ----------- | ------------------------------------------------------------------- |
| Base        | CommonMark, pinned parser                                           |
| Extensions  | GFM autolinks, footnotes, strikethrough, tables, task lists         |
| Directives  | `note`, `tip`, `warning`, `caution` — container form only           |
| Captions    | `/// caption`, `:::{figure}`, `:::{table}` — see below              |
| Card grids  | `:::cards`, Material's `<div class="grid cards" markdown>` — below  |
| Frontmatter | `title`, `description`, `path`, `toc`, `navOrder`, and nothing else |
| MDX         | rejected                                                            |
| Raw HTML    | rejected, not passed through                                        |

```markdown
:::warning[Optional title]
The body is ordinary Markdown.
:::
```

A bare `www.example.org` autolink is normalized to `https://` **before** scheme
validation, so no renderer default can turn it into plain HTTP.

Task lists emit a state-bearing list item, a decorative marker and a
screen-reader label. No `input` element is produced, and authored form controls
remain forbidden, even though GFM would normally emit a disabled checkbox.

## reStructuredText

Core Docutils only, through the exact `freva-portal-rst` helper. The builder
compares the whole handshake — protocol, helper package, helper version and the
pinned Docutils version — and refuses to render otherwise. Implementing a
compatible protocol is deliberately not enough.

| Allowed                                                                                       | Rejected                                                                      |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| admonitions, `code`, `math`, `image`, `figure`, tables, `list-table`, `contents`, `container` | `raw`, `include`, file/URL-backed `csv-table`, `meta`, `role`, `default-role` |
| `math`, `literal`, `emphasis`, `strong`, `sub`/`superscript`, `title-reference`, `code` roles | Sphinx domains, cross-reference roles, autodoc, extension substitutions       |

File inclusion is intentionally absent. A project that needs includes, Sphinx
roles or API documentation should build that with Sphinx or MkDocs and mount it
as a trusted subsite. That is a boundary, not a missing feature.

## Headings, anchors and the table of contents

One package-owned, Unicode-aware slug algorithm: decompose, drop combining
marks, lower-case, keep letters and numbers, collapse separators. Duplicates get
stable numeric suffixes; an empty result becomes `section`. An anchor someone
pasted into a ticket keeps working across builds, and an RST heading gets the
same anchor its Markdown twin would.

The table of contents covers headings 2–3 by default and is disabled per page
with `toc: false`.

`navOrder` is an integer between -10000 and 10000 that orders a page among the other pages of its
directory in the derived section navigation. It orders siblings and nothing else: it does not change
a route, does not create or remove a page, and means nothing outside its own directory. Pages that
declare nothing sort by filename, so a section can be partly ordered. A float, or a value outside
the range — usually a year pasted into the wrong key — is a `PC1005` error rather than a silent
sort.

## Code, mathematics and diagrams

All three are rendered while the artifact is built, so a reader downloads no
highlighter, no maths engine and no diagram library.

- **Highlighting** uses a pinned grammar and theme. An unknown language warns and
  renders as escaped plain code. Token colours become deterministic classes plus
  one framework stylesheet — never inline styles, so the output stays servable
  under a strict CSP.
- **Mathematics** uses a pinned engine in strict mode. A TeX command outside the
  supported surface is a source-located error rather than a red `\undefined`
  nobody notices.
- **Mermaid** renders to sanitized SVG with deterministic identifiers. Invalid
  diagram source stops the build.

Code blocks keep a fixed background rather than the theme surface: the pinned
highlighting theme's contrast ratios are only true against the background it was
designed for, and a preset that tinted it would quietly push keyword colours
below 4.5:1.

## Captions, figures and code titles

Consumer documentation already carries captions, written for Material for MkDocs
or for MyST. The profile reads those two spellings and nothing else. This table
is the whole of it — a construct not listed here is refused with a diagnostic
that names the author's line, never printed at the reader as prose.

| Authored                                      | Attaches to                     | Becomes                                      |
| --------------------------------------------- | ------------------------------- | -------------------------------------------- |
| `/// caption` … `///` (PyMdown Blocks)        | the immediately preceding block | see the lowering table below                 |
| `:::{figure} src` (and ` ```{figure} ` )      | its own body                    | `figure` + `figcaption` (+ legend)           |
| `:::{table} Caption` (and ` ```{table} ` )    | the table in its body           | `table` > `caption`                          |
| `.. figure::` with a caption paragraph        | its own body                    | `figure` + `figcaption` (+ legend)           |
| `.. table::` / `.. list-table::` with a title | the table                       | `table` > `caption`                          |
| `{ width="600" .img-center }`                 | the image before it             | width and alignment on the image or figure   |
| ` ```lang title="name" `                      | the code block                  | a title bar above the code — _not_ a caption |

What a `/// caption` may follow, and what it lowers to:

| Preceding block                 | Result                                                |
| ------------------------------- | ----------------------------------------------------- |
| one image                       | `<figure>` + `<figcaption>`                           |
| a paragraph that is only images | one `<figure>`, every image in it, one `<figcaption>` |
| a GFM table                     | `<caption>` as the table's first child                |
| a fenced code block             | `<figure>` around the code block + `<figcaption>`     |
| a Mermaid block                 | the diagram `<figure>` gains a `<figcaption>`         |
| a blockquote                    | `<figure>` + `<figcaption>`                           |
| anything else, or nothing       | `PC1020`, positioned at the author's line             |

A table is never wrapped in a card to hold its caption: HTML has `<caption>`, and
a `<figure>` around a table would not be its accessible name.

Supported `:::{figure}` options are `alt`, `width`, `align` and `name`, and no
others. A figure's first paragraph is its caption and the rest is its legend,
which is the Docutils rule for `.. figure::` and the one MyST inherits.

### Image attribute lists

`![Alt](x.png){ width="600" .img-center }` is read, because consumer
documentation is written that way and because an unread attribute list is worse
than a missing feature: the braces print at the reader, and the paragraph stops
being images-only, so the `/// caption` under it has nothing to attach to.

The subset is `width`, `height` (accepted and ignored — the theme keeps the
aspect ratio) and the three classes `.img-left`, `.img-center` and `.img-right`.
Any other attribute is `PC1020`. A width or an alignment on a captioned image
moves to the figure, so the caption sits under the image at the image's width.
This is not attribute-list support; it is the part of one an image with a
caption needs.

### Where a marker is not a marker

The recognition is line-aware, not a search-and-replace, so the page that
_documents_ this syntax renders correctly. `/// caption` is left exactly as
written inside a fenced code block, inside an indented code block, and inside
inline code. Everywhere else it either becomes a caption or becomes a diagnostic.

### Light and dark image pairs

`![Alt](image.png#only-light)` and `#only-dark`, the MkDocs Material spelling, are
recognized. The fragment is stripped before the asset is resolved, so the file is
found, and kept on the emitted `src` alongside a `data-portal-only` attribute, so
the theme can show one variant per colour scheme. Two such images written on
consecutive lines are one paragraph, so they become **one** figure with **one**
caption.

### Code titles are not captions

` ```python title="remap.py" ` puts the file name in the code block's own header,
beside the language and the copy button. It is a label on the block, not a
description of a figure, so it is a separate IR property, it does not create a
`<figure>`, and it does not become an accessible name. The two can be written
together: the title names the file, the caption describes it. Fence metadata
other than `title=`, a malformed `title=`, or two of them, is `PC1021`.

### Deliberately absent

No figure or equation numbering, and no cross-referencing: `:name:` gives the
element an id to link to, and nothing counts figures for you. No Pandoc
`Table:` syntax, no raw HTML `<figure>`, no captions on audio or video, no
`csv-table`, no external file insertion, no Sphinx subfigures. This is a caption
subset, not MyST support and not MkDocs support.

## Card grids

A gallery or an overview page is a grid of cards: a thumbnail, a linked title and
a short summary each. Two spellings, one result:

```markdown
<div class="grid cards" markdown>

- [![](01_first_map.png)](01_first_map.md)
  **[A map of one month](01_first_map.md)**
  First paragraph of the example...

- [![](02_zonal_mean.png)](02_zonal_mean.md)
  **[A zonal mean](02_zonal_mean.md)**
  ...

</div>
```

```markdown
:::cards

- **[A map of one month](01_first_map.md)**
  First paragraph of the example...
  :::
```

The Material form is recognized the way `!!!` and `/// caption` are: the `<div>` line and its
`</div>` are block spellings, never raw HTML, and are left alone inside code. Only
`class="grid cards"` (plus an optional `cols-N` hint) with a `markdown` attribute is accepted;
`<div class="grid" markdown>` is `PC1023`, and any other `<div>` is raw HTML (`PC1002`).

The body is one Markdown list, one card per item. Each item is read in order:

| Part    | What it is                                                                 | Optional |
| ------- | -------------------------------------------------------------------------- | -------- |
| image   | the item's first thing, an image or a link around one                      | yes      |
| title   | then a link, or `**strong**`/`*emphasis*` text around one, on its own line | yes      |
| `---`   | Material's separator between title and summary; dropped                    | yes      |
| summary | everything else in the item, as ordinary Markdown                          | yes      |

The pieces may share one paragraph (line breaks between them) or be separate
paragraphs. Links and images are resolved like any other: `01_first_map.md`
becomes that page's route and a missing target is an error.

The result is a `<ul role="list">` of `<li>` cards, so a screen reader announces the count and
moves card by card. The title is a paragraph, not a heading, so a gallery adds nothing to the
table of contents. When image and title link to the same place, the image is not linked again and
counts as decorative (no `PC1014` for an empty `alt`); the title link is stretched over the card -
one click target, one tab stop - and a link in the summary stays its own.

**Columns.** As many as fit at 21rem or more (narrower, the summary wraps every few words): two or
three in the docs column, never four, one on a phone - with no inline style and no script.

An optional **column hint** caps it:

```markdown
:::cards{columns=2}

- **[The guide](guide/index.md)**
  ...
  :::
```

or, in Material's spelling, a `cols-N` class:

```markdown
<div class="grid cards cols-2" markdown>
...
</div>
```

`2`, `3` and `4` are accepted. The hint is a **maximum**: the grid still drops to fewer columns
when narrow, and to one on a phone. It becomes a class (`portal-cardgrid-max-2`), never a style
attribute, and lets cards go down to 13rem so `columns=3` or `4` fits a docs column.

Refused, as `PC1023`: a body that is not exactly one list, a title on `:::cards` or any attribute
but `columns`, a column hint other than `2`, `3` or `4` (`columns=5`, `cols-5`, two `cols-`
classes), a task-list item, an empty item, and a linked image with no `alt` that keeps its own
link (no title, or a title linking elsewhere) - it would be a link with no name.

Card grids are Markdown only; the RST lane has no spelling for them.

## Links and assets

- A link from `.md` or `.rst` to another source file is rewritten to that file's
  generated route.
- A relative fragment is checked against normalized heading ids.
- A root-relative internal URL is checked against every generated route, static
  file and subsite mount.
- Missing internal pages, fragments and assets are build errors.
- External links allow `https` and `mailto`. `javascript:`, `vbscript:`, `file:`
  and unapproved `data:` URLs are errors.
- External URLs are syntax-checked and never requested during the build.
- No remote asset is downloaded, ever.

## Fragments

A source referenced directly by a landing `prose` block, `chrome.*.prose` or a
STAC `rootPage.intro` is a **fragment**: rendered, hashed and link-checked like a
page, but owning no route. Keep fragments in an excluded directory — `_fragments/`
by convention. Using one source as both a discovered page and a direct fragment
is an error, because one of the two uses is not what the author meant.

## Safety

The final tree permits semantic prose, tables, images, links, code, maths output
and sanitized diagram SVG. It rejects authored `script`, `style`, `iframe`,
`object`, `embed`, `form` and `input`; inline event handlers; inline JavaScript
URLs; ids that collide with portal shell identifiers; classes outside the
profile namespaces; and inline styles except on nodes created and tagged by the
pinned maths and diagram transforms.

Every project-supplied SVG — identity logo, favicon, prose image, landing image,
component chrome — goes through **one** sanitizer, and only the sanitized
derivative is published. There is no second entry point, so a future component
schema cannot introduce a raw-SVG copy path.

Sanitization happens even though content is reviewed in Git. Review reduces risk;
it does not protect against a compromised dependency, a mistaken paste, or a
change in who owns the content directory next year.

## Diagnostics and limits

Errors stop the build. Warnings print with source locations and become errors
when `rendering.diagnostics.warningsAsErrors` is true. `--diagnostics json`
emits the same information for CI.

Every diagnostic carries a stable code (`PC…` for content, `FP…` for
configuration and the build), a severity, a file path, and either a JSON Pointer
or a source position. A location is labelled by how it was obtained — reported by
the parser, inherited through a rule the profile names, or generated by a
transform — because "use the parent's line and call it parser-provided" is a
fabrication, and a source position that might be wrong is worse than an honest
absence.

The profile enforces limits on source size, rendered tree size, diagram
complexity, nesting, page count and total asset bytes. They are operational
guardrails, not renderer settings.
