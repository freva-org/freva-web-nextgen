# Customisation

A portal is customised from its own repository through three closed capabilities, all parsed and
enforced by the builder:

1. **Typed configuration** - header, footer, navigation, fonts, scales and landing layout options
   in `portal.yaml` and the landing files ([configuration.md](configuration.md)).
2. **`portal-style-v1`** - one restricted local stylesheet, written against a published, versioned
   API (`schema/style-parts-v1.json`).
3. **`portal-template-v1`** - restricted templates for named slots (`schema/slots-v1.json`).

None of them runs consumer code. There are no consumer Astro components, plugins, build commands,
scripts or escape hatches (FP-001 D11). Customisation can never enable a feature, change an
endpoint or own a route: a part of a disabled feature renders nothing, a rule that can only match
one is pruned, and an action on a disabled component is omitted. Every option is validated with a
source location, recorded in `input-manifest.json`, and covered by `verify`. Every customisation
input - the stylesheet, the templates, fonts, images and whatever the stylesheet and the templates
reference - must lie outside the output, temporary and backup trees, checked before anything is
written (`FP1003`).

What does not change: the artifact is build-time output only, the CSP stays `style-src 'self'`
(plus whatever enabled components already need) with no new origin and no new inline script or
style, nothing is fetched from a third party, and the stylesheet and the templates are scanned for
secrets like every other input. A portal that uses none of this is unaffected by it.

## The public API

### Tokens

Custom properties a stylesheet may set and read. Each maps onto the framework's own property, so
`--portal-color-accent: #0b6e8a` in your stylesheet is `--accent: #0b6e8a` in the published one.

| Token                                                                               | Meaning                                     |
| ----------------------------------------------------------------------------------- | ------------------------------------------- |
| `--portal-color-background`, `-surface`, `-surface-alt`                             | Page, card and alternate surfaces           |
| `--portal-color-border`, `-border-strong`                                           | Rules                                       |
| `--portal-color-text`, `-text-secondary`, `-text-muted`                             | Text                                        |
| `--portal-color-accent`, `-accent-hover`, `-accent-contrast`                        | The main colour and the text on it          |
| `--portal-color-chrome`, `-chrome-text`, `-chrome-text-secondary`, `-chrome-border` | Header bar                                  |
| `--portal-color-footer`                                                             | Footer                                      |
| `--portal-color-danger`, `-warning`                                                 | Status colours                              |
| `--portal-font-body`, `-heading`, `-mono`                                           | Font stacks                                 |
| `--portal-radius-small`, `-medium`, `-large`, `-pill`                               | Corner radii                                |
| `--portal-shadow-card`, `-panel`                                                    | Elevation                                   |
| `--portal-content-width`, `--portal-shell-padding`                                  | The page column and its gutter              |
| `--portal-header-height`, `--portal-footer-height`                                  | Chrome heights (the page clearance follows) |
| `--portal-type-scale`, `--portal-space-scale`, `--portal-border-width`              | The scales set by `theme.tokens`            |

Your own properties start with `--site-`. Any other custom property - a framework one such as
`--accent`, or an unknown `--portal-*` - is rejected, in a declaration and in `var()`.

### Parts, variants, states and themes

Markup carries `data-part`, `data-variant` and `data-state` **only on a customised portal**:

| Part                                                                                                                                                                                                                                                                                         | Notes                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `skip-link`, `header`, `header-nav`, `nav-toggle`, `header-auth`, `side-nav`, `main`, `footer`                                                                                                                                                                                               | **Protected**: may not be hidden, made inert or lose their focus indicator |
| `header-controls`, `header-extra` (when it holds the account control)                                                                                                                                                                                                                        | Contain a protected control: the same rules apply                          |
| `header-brand`, `header-logo`, `header-title`, `header-links`, `header-link`, `header-search`, `header-theme-toggle`                                                                                                                                                                         | Header                                                                     |
| `side-nav-link`                                                                                                                                                                                                                                                                              | Side navigation entries                                                    |
| `landing`, `landing-section`, `section-shell`, `block`, `block-hero`, `block-prose`, `block-cards`, `block-links`, `block-callout`, `block-component-link`, `block-component-search`, `block-dataset-tree`, `card`, `button`                                                                 | Landing                                                                    |
| `document`, `prose`, `prose-aside`                                                                                                                                                                                                                                                           | Content pages                                                              |
| `footer-index`, `footer-top`, `footer-about`, `footer-groups`, `footer-group`, `footer-group-title`, `footer-link`, `footer-columns`, `footer-logos`, `footer-logo`, `footer-legal`, `footer-prose`, `footer-bottom`, `footer-bar`, `footer-badge`, `footer-shortcuts`, `footer-institution` | Footer                                                                     |

`header-search` belongs to the documentation search, `header-auth` to auth,
`block-component-search` to the Data Browser, `block-dataset-tree` to the dataset tree and
`footer-badge` to the footer badge: with the feature off they are not in the markup and a rule
for them is pruned.

Variants: `[data-part="header"][data-variant=…]` is `standard`, `centered`, `split`, `compact` or
`minimal`; `[data-part="footer"][data-variant=…]` is `columns`, `stacked`, `minimal` or
`bar-only`. States: `[data-state="current"]` on the link to the page being shown and
`[data-state="external"]` on a link to another origin. Themes: `[data-theme="light"]` and
`[data-theme="dark"]` (on the root element).

The authoritative list, with a description of each part and the feature that owns it, is
`schema/style-parts-v1.json`.

## portal-style-v1

```yaml
theme:
  stylesheet:
    profile: portal-style-v1
    path: ./brand/site.css
```

The builder parses the file with PostCSS, a selector parser and a value parser. Comments are
removed and CSS escapes decoded **before** anything is compared, so `\75 rl(` is `url(` and
`u/**/rl(` is not a function. What is published is re-serialized from the checked form.

**Selectors.** `:root`, `[data-theme]`, `[data-part]`, `[data-variant]`, `[data-state]` (exact
`=` matches with a value from the API), `.site-*` classes, and element types - only inside a
`.site-*` element or a slot container (`header-extra`, `footer-top`, `footer-columns`,
`footer-bottom`, `section-shell`, `prose-aside`), and only those a template can emit. Combinators:
descendant and child. Pseudo-classes: `:hover`, `:focus-visible`, `:active`, `:first-child`,
`:last-child`, `:nth-child()`, and `:not()`, `:is()`, `:where()` over simple selectors.
Pseudo-elements: `::before`, `::after`. No ids, no framework classes, no `*`, no other attributes,
no sibling combinators, no `:has()`, no nesting. (`FP1902`)

**At-rules.** `@media` with width/height, `prefers-color-scheme`, `prefers-reduced-motion`,
orientation, `screen` and `print`; `@supports` with property: value conditions; `@layer` (nested
inside your `portal-site` layer); `@keyframes` (names not starting with `portal`); `@font-face`
whose `src` is `url()` of a local font file. `@import`, `@namespace` and everything else are
rejected (`FP1903`).

**Values.** `url()` and `image-set()` point at local files under the source root, which are
resolved relative to the stylesheet, hashed and published under `_portal/site/`. Remote,
protocol-relative, `data:` and `javascript:` URLs are rejected, as are `expression()`, `behavior`,
`-moz-binding`, `local()` font sources and any function outside a fixed list (colours, gradients,
math, transforms, filters, `var()`, `counter()`). `content` takes strings, `none`, `normal` and
counters only - never `attr()` or `url()`. Custom-property values pass the same checks. (`FP1904`,
`FP1907`)

**Protected controls.** Listing ways to hide something is never complete, so a rule that can
match the skip link, a landmark, the menu button, the account control or an element containing
one (`:root` included) takes an allowlist:

- Paint that cannot hide a control takes any checked value: backgrounds, border colours, styles
  and radii, shadows, font family, weight and style, text decoration and transform, alignment,
  cursors, `--site-*` properties.
- Text colour (`color`) is a provably visible colour (see below), and so is every
  `--portal-color-*` token, on every rule.
- Nothing that needs evaluating: `calc()`, `min()`, `var()` and the like are refused, since
  `opacity: calc(1 - 1)` is zero. Border shorthands may name colour tokens, never a length token.
- No transforms (`transform`, `translate`, `scale`, `rotate` take only `none`) and no offsets
  (`top`, `left`, `inset` take only `auto`): they compose with each other and down the nested
  elements, so no per-declaration limit bounds the result.
- What adds up is capped per element: margins within 8px (or `auto`), padding up to 16px, gaps up
  to 16px, border widths up to 2px, `text-indent` up to 8px, `letter-spacing` within 8px. Widths
  are a content keyword or 50%-100%; heights 24px-256px; `max-*` sizes at least 24px.
- What multiplies is bounded below by itself: `opacity` at least 0.9; `font-size` 10px-32px,
  0.625rem-2rem, or 1em-2em (never a relative size below 1em).
- `display` other than `none`; `visibility: visible`; `pointer-events: auto`;
  `overflow: visible`; `clip`, `clip-path`, masks and `backdrop-filter` only at their defaults;
  `filter` of colour functions only; `--portal-header-height` and `--portal-footer-height`
  24px-256px, `--portal-content-width` at least 640px, `--portal-shell-padding` up to 16px,
  `--portal-type-scale` at least 0.5.
- Any other property, `position` and `z-index` among them, is refused on such a rule.

A control sits inside its landmark, a container and - through a `headerExtra` template - at most
one wrapper (a protected part inside two elements is `FP1913`). At 26px per element the whole
chain adds at most 86px along the header. That bounds what spacing can do; it does not prove the
control stays on screen, because a 320px header has less room than that to spare.

`::before` and `::after` of such an element may only be glyphs in the flow: `content` of strings
only, at most three characters in all once escapes are decoded and the strings joined; colour,
font and text properties, `display`, `visibility`, `opacity`, a bounded `font-size`,
`letter-spacing` and inline margins up to 8px - nothing that paints a surface or moves, which
could cover the control.

On every rule:

- `z-index` is at most 10 and nothing is `position: fixed`. The framework raises the account
  control and the menu button to `z-index: 11`, and the header, footer and side navigation already
  sit above that, so no consumer box, shadow or outline is painted over them.
- Outlines are provably visible, wherever they are set: any element can take focus, and the
  framework's `:focus-visible` ring is in a lower layer than your rules. `outline` names a visible
  style and a width of 1px-8px; `outline-style` is a visible style; `outline-width` is `thin`,
  `medium`, `thick` or 1px-8px; `outline-color` is a provably visible colour; `outline-offset` is
  within 8px. Widths, styles and offsets are literals; `outline: none` is refused everywhere.
- A provably visible colour is a named colour or `currentcolor`; a hex colour whose alpha, if it
  has one, is at least one half; a colour function (`rgb()`, `hsl()`, `oklch()` and the rest) whose
  every argument is a literal and whose alpha is at least one half; or `var()` of a
  `--portal-color-*` token without a fallback. `calc()` inside a colour, `color-mix()`, a relative
  colour (`rgb(from …)`, which takes its alpha from another colour), a `none` channel, a length
  token and a `--site-*` property are refused wherever a colour has to be visible.
- Transitions do not hold a change back: durations and delays up to 1s, no `allow-discrete`.

An `animation` or `animation-name` on a protected rule must name `@keyframes` declared in the
same stylesheet, and every declaration in them must pass the same allowlist. Names are read as the
browser reads them: quoted or not, escapes decoded, case-sensitive, every identifier of
`animation-name` but `none`, and in the shorthand any keyword that is also the name of declared
keyframes. A rule inside `@media` whose every query is the `print` media type is exempt; `not
print`, `print, screen` and feature-only queries reach the screen and are not. (`FP1905`)

What a static check cannot settle is layout. Within the bounds above, spacing on the chain, a
wide font, or a neighbour that is not protected - a brand or a template element made wide - can
still push a control partly past the edge of a narrow header: with every bound used at once, a
320px header overflows by about 40px on each side. The browser suite
`browser-tests/customisation.mjs` asserts on the fixture portals that the account control and
search are visible and focusable at desktop width and that the menu button opens at phone width
(and at tablet width, where centre-b has no tabs); run the same checks against a portal whose
stylesheet reworks its header.

**Disabled features.** A selector that can only match a disabled feature's parts is pruned from
its rule, with an info diagnostic (`FP1906`) and an entry in `component-evidence.json`
(`customisation.stylesheet.prunedRules`); a rule left with no selector is dropped.

**Output.** One `_portal/site-style.<hash>.css`:

```css
@layer portal-framework, portal-site;
/* builder-generated @font-face rules and layout backgrounds */
@layer portal-site {
  /* your checked rules */
}
```

On a portal with a stylesheet every framework stylesheet is compiled into
`@layer portal-framework`, so your layer wins by layer order, not by specificity, and the
framework's own `!important` safeguards (such as `[hidden]`) still win over yours. Third-party
styles a framework stylesheet adjusts join that layer too - the prepared STAC Browser stylesheets
and the dataset tree's adopted sheet - so their order relative to it is kept. The exception is
the Data Browser's host stylesheet: its counterpart is injected by the Data Browser package at
runtime, which the build cannot layer, so both stay unlayered. The file is linked after the
framework's stylesheets on every page, limited to 256 KiB (`FP1407`) and scanned for credentials
(`FP1210`). Every diagnostic is `file:line:col`.

## portal-template-v1

```yaml
chrome:
  slots:
    footerBottom: ./templates/address.html
```

A template is HTML with four constructs:

- `{{ site.title }}` - a field from the slot's read-only context, always escaped, in text and in
  attribute values only. `href` takes a literal or exactly one `url` field; `src` and `srcset`
  take a literal local file or exactly one `image` field. A `url` may point off the site, so it is
  never an image source; an `image` is always a same-origin file this build published, and the
  rendered value is checked again (`FP1912`, `FP1917`).
- `{% if route.isHome %}…{% else %}…{% endif %}`
- `{% for link in links %}…{% endfor %}` - at most 64 iterations per loop and 256 per render
  (`FP1916`).
- `{% part "legal-links" %}` - a sealed framework part, rendered by the framework.

Pipeline: tokenise → parse5 → interpolate → `sanitize()` with the slot profile → link and asset
validation → serialize. Elements: `a`, `img`, `picture`, `source` (only directly inside
`picture`, with `srcset` and a `(prefers-color-scheme: light|dark)` `media`; left out when its
image field is empty), `svg` (through `sanitizeSvg`), `span`, `div`, `p`, `ul`, `ol`, `li`,
`section`, `strong`, `em`, `small`, `br`, `hr`, `h2`-`h6`,
`address`, `figure`, `figcaption`, `time`. Attributes: `class` (literal `site-*` names only),
`href`, `src`, `srcset`, `alt` (required on `img`), `title`, `lang`, `datetime`, `aria-label`, and
`role` from a short list that excludes landmarks. `script`, `style`, `iframe`, `object`, `embed`,
`form`, `input`, `on*` handlers, `style`, `id` and `target` are rejected (`FP1914`). Links are
site paths, `https:` or `mailto:`, checked like every other link (an internal target must exist),
or a fragment naming an element the shell writes on every page: `#top`, `#portal-main`,
`#portal-shell`, and `#portal-header` when the header is on. Images are local files, published
hashed (`FP1917`). Entities are decoded before the check, so `&#106;avascript:` is refused, and a
character reference to a private-use code point is a syntax error (`FP1911`): those are the
builder's own markers.

Unknown fields and fields of the wrong type are `FP1912`. A part must be one the slot takes, may
appear once, never inside a loop, and a protected or required part never inside `{% if %}`
(`FP1913`). A part of a disabled feature renders nothing, with an info diagnostic (`FP1915`) and
an entry in `customisation.templates[].emptyParts`. Templates are limited to 64 KiB and scanned
for credentials.

### Slots

| Slot                  | Where                                         | Parts                                    |
| --------------------- | --------------------------------------------- | ---------------------------------------- |
| `headerBrand`         | Inside the header's home link (no `a` inside) | `logo`                                   |
| `headerExtra`         | At the end of the header, after its controls  | `logo`, `search`, `theme-toggle`, `auth` |
| `footerTop`           | At the top of the footer index                | `logo`, `nav-links`, `legal-links`       |
| `footerColumns`       | After the link groups, as one more column     | `logo`, `nav-links`, `legal-links`       |
| `footerBottom`        | At the end of the footer index                | `logo`, `nav-links`, `legal-links`       |
| `landingSectionShell` | Around each section of a laid-out landing     | `blocks` (required, exactly once)        |
| `proseAside`          | At the end of a content page's article        | `logo`, `nav-links`                      |

A `search`, `theme-toggle` or `auth` part placed in `headerExtra` leaves its place in the header
(it may not also be listed in `chrome.header.items`), and `legal-links` placed in a footer slot
leaves the index's legal section. The Freva badge is not a part: it is a fixed overlay its own
runtime positions against the footer bar.

### Context

Every slot gets:

| Field                                                               | Type                             |
| ------------------------------------------------------------------- | -------------------------------- |
| `site.title`, `site.subtitle`, `site.language`                      | string                           |
| `site.institution.name`, `site.institution.url`                     | string, url                      |
| `logo.src`, `logo.light`, `logo.dark`, `logo.alt`                   | image, image, image, string      |
| `route.path`, `route.title`, `route.kind`, `route.isHome`           | string, string, string, bool     |
| `links[]`: `label`, `href`, `external`, `current`                   | the header's links               |
| `footer.groups[]`: `title`, `links[]`                               | the footer's link groups         |
| `footer.legal[]`, `footer.logos[]` (`src` image, `alt`, `href` url) | legal links, the logo wall       |
| `build.year`                                                        | string, from `SOURCE_DATE_EPOCH` |

`landingSectionShell` adds `section.id` and `section.heading`; `proseAside` adds `page.title` and
`page.headings[]` (`text`, `href`). Values are typed and read-only; an empty `url` renders the
element's children without the link, and an empty `image` renders nothing.

## Versioning and deprecation

`portal-style-v1` and `portal-template-v1` are versioned profiles, and `style-parts-v1.json` and
`slots-v1.json` are their published contracts.

- Within v1, changes are additive only: a new part, token, variant, slot, context field or sealed
  part is a minor release of `@freva-org/portal-builder`. Nothing accepted by a v1 release is
  rejected by a later v1 release, and no published name changes meaning.
- Removing or renaming anything, or narrowing a rule, needs a new profile (`portal-style-v2`,
  `portal-template-v2`) with its own API file. The previous profile stays accepted for at least one
  further minor release, during which using it is a warning that names its replacement; then it
  is removed in a major release.
- Framework class names (`.portal-*`), ids and internal custom properties are not part of any
  profile and may change in any release; that is why a stylesheet cannot name them.

## Worked examples

Two fictional portals in the repository exercise all of this, and the browser suite
`browser-tests/customisation.mjs` drives both.

**`examples/centre-a`** - a centred, sticky logo header, transparent over the hero; a columns
footer with a logo wall; a three-column landing:

```yaml
chrome:
  header:
    enabled: true
    variant: centered
    transparentOverHero: true
    logo: { src: ./brand/logo-light.svg, dark: ./brand/logo-dark.svg, alt: Centre A }
  footer:
    enabled: true
    variant: columns
    columns: 4
    order: [about, groups, logos, legal]
    logos:
      - { src: ./brand/partner-1.svg, alt: North Agency, href: "https://north-agency.example.org/" }
```

```css
/* brand/site.css */
:root {
  --portal-color-accent: #0b6e8a;
}
[data-theme="dark"] {
  --portal-color-accent: #4fb3d1;
}
[data-part="landing-section"]:nth-child(2) [data-part="card"] {
  border-top: 4px solid var(--portal-color-accent);
}
@media print {
  [data-part="footer-logos"] {
    display: none;
  }
}
```

**`examples/centre-b`** - a split header with side navigation, local fonts and a larger type
scale; a minimal footer whose funding notice and address come from templates; the search block
before the hero and sections of different widths:

```yaml
chrome:
  header:
    enabled: true
    variant: split
    items: [brand, navToggle, search, auth]
  footer:
    enabled: true
    variant: minimal
  slots:
    headerExtra: ./templates/header-extra.html
    footerBottom: ./templates/footer-bottom.html
navigation:
  placement: side
theme:
  fonts:
    - { family: Centre Sans, src: ./brand/poppins-regular.woff2, weight: 400 }
    - { family: Centre Sans, src: ./brand/poppins-bold.woff2, weight: 700 }
  tokens:
    fontBody: Centre Sans
    typeScale: large
```

```html
<!-- templates/footer-bottom.html -->
<address class="site-address">
  {{ site.institution.name }}<br />
  1 Harbour Road, 00000 Example Town
</address>
<p class="site-copyright"><small>&copy; {{ build.year }} {{ site.institution.name }}</small></p>
{% part "legal-links" %}
```

```html
<!-- templates/header-extra.html: the theme switch moves here, out of the item list -->
<span class="site-status">{% part "theme-toggle" %}</span>
```

## Diagnostics

| Code     | Meaning                                                          |
| -------- | ---------------------------------------------------------------- |
| `FP1230` | A layout option would hide a protected control                   |
| `FP1231` | Font file is not WOFF2                                           |
| `FP1232` | Action intent does not match its target component                |
| `FP1233` | A layout option has no effect (warning)                          |
| `FP1234` | Header arrangement not supported                                 |
| `FP1901` | Stylesheet could not be parsed                                   |
| `FP1902` | Selector outside the portal-style-v1 public API                  |
| `FP1903` | At-rule not allowed in portal-style-v1                           |
| `FP1904` | Property or value not allowed in portal-style-v1                 |
| `FP1905` | Style would hide a protected control or remove a focus indicator |
| `FP1906` | Style rule for a disabled feature pruned (info)                  |
| `FP1907` | Customisation asset rejected                                     |
| `FP1911` | Template syntax error                                            |
| `FP1912` | Unknown or mistyped template field                               |
| `FP1913` | Unknown, misplaced or repeated slot part                         |
| `FP1914` | Element or attribute not allowed in portal-template-v1           |
| `FP1915` | Part of a disabled feature renders nothing (info)                |
| `FP1916` | Template loop exceeds the iteration cap                          |
| `FP1917` | Template link or image rejected                                  |

Existing codes apply too: `FP1104` (schema), `FP1201` (unknown target or section), `FP1202`
(disabled target, info), `FP1208` (duplicate), `FP1210` (credential), `FP1407` (size).
