# Patch provenance

This workspace compiles upstream STAC Browser and applies the ordered patch series from
[`patches/`](./patches). The series is declared in [`upstream.json`](./upstream.json) and that
recipe is the count of record; this file records what each patch does, why it exists, and where
the idea came from. `upstream-pin.test.mjs` fails if the two disagree, and if any sentence here or
in the sibling documents states a number the recipe does not have.

## The nine patches

All nine are written for this repository against the pinned commit, and they exist for one
reason: the portal hosts STAC Browser **inside its own page**, so the shell's header, navigation
and footer stay put and the visitor never leaves the portal. Upstream, reasonably, assumes it owns
the document.

| Patch                                                        | File                                                | What it changes                                                                                                                 |
| ------------------------------------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `0001-mount-into-the-portal-host-element`                    | `src/init.js`                                       | `app.mount("body")` -> mount into `#stac-browser-mount`; fail closed if absent; release a prior instance                        |
| `0002-expose-init-for-re-entry`                              | `src/main.js`                                       | Publish `window.STAC_BROWSER_INIT` so a second visit can re-mount                                                               |
| `0003-follow-the-host-theme`                                 | `src/StacBrowser.vue`                               | Scope the colour attribute to the mount, follow the portal's `data-theme`, hide upstream's own toggle                           |
| `0004-do-not-scroll-lock-the-host-document`                  | `src/components/Sidebar.vue`                        | `body-scrolling` on the Browse drawer, and a namespaced `stac-browser-sidebar` body class                                       |
| `0005-open-the-validation-report-in-a-new-tab`               | `src/components/Validation.vue`                     | The Source valid/invalid tick opens the report with `target="_blank"` instead of navigating in place                            |
| `0006-teleport-the-example-code-modal-into-the-embed`        | `src/components/SearchFilter.vue`                   | `teleport-to="#stac-browser"` on the search example-code modal, so it renders inside the mount                                  |
| `0007-open-the-catalogue-description-expanded`               | `src/components/ReadMore.vue`                       | `expanded` defaults true and the measured height is set on mount; the toggle still collapses                                    |
| `0008-ask-before-fetching-a-third-party-basemap`             | `basemaps.config.js`                                | Basemap layers are kept only for origins the deployment listed; the default list is empty                                       |
| `0009-place-the-portal-introduction-in-the-catalogue-column` | `widgets.config.js`, `src/components/Providers.vue` | A widget moves the portal's rendered introduction into `section.intro`; a provider draws a host-supplied `logo` when it has one |

0005 is the one a visitor notices going wrong: the validation route is a route of the _embedded_
application, so following it in place replaces the portal's page with the report and the back
button no longer goes where the reader came from. 0006 matters because a modal teleported to
`document.body` is outside `#stac-browser` - outside everything the build-time containment pass
scoped - so it renders unstyled and outside the mount the embed is meant to stay in. 0007 is a
rendering change: on a landing page the catalogue description is the content, not a summary.

0008 is the external-resource one. Upstream's basemap table fetches tiles from `openstreetmap.org`
and `usgs.gov`, once per tile, from the visitor's browser, on every document that has a footprint.
The portal publishes a self-contained artifact under `default-src 'none'`, so the browser refused
them: a map that drew blank and a console full of policy violations, on every collection and item
page. The layers are not removed - the answer is not "never" but "not unless this deployment said
so". A deployment lists origins in `access.basemapOrigins`, and that one statement is what both
reaches this filter through the runtime configuration and puts the origin into the artifact's
`img-src`. Upstream's own attribution metadata rides along with the layer, so a deployment that
enables OpenStreetMap gets the attribution its tile policy requires.

0009 is a placement, not a rewrite. A portal that embeds a catalogue has something to say about
it, and the portal renders that introduction through its own content pipeline - its Markdown
dialect, its sanitizer, its content-hashed asset URLs - so the result is HTML, not CommonMark. It
therefore cannot be handed over as `description`: upstream renders that field with `safe: true`
and would strip it, and re-rendering it as CommonMark would undo the asset resolution that made
its image load at all. Without a placement the only remaining option is to stack the fragment
above the mount, which is what the portal did, and which reads as a separate page with the
catalogue's own toolbar and title beneath it. The widget uses upstream's own extension point to
move the fragment - the node itself, not a copy - into the top of the metadata column, and puts it
back when the view is torn down. Which views it is visible on stays the portal's decision, made in
the portal's stylesheet.

Into `section.intro`, specifically, and not into the widget's own place at the top of the column.
Above `xl` the metadata column is a flex row whose `> section` children divide it, so a fragment in
a wrapper of its own is a third item that takes a line to itself and pushes the providers below it -
the same wrong composition, reached from the other side. Inside `section.intro` it shares that item
with the keywords and the links, and the providers keep the other half of the row.

The same patch carries the provider mark, for the same reason: STAC has no logo field, and the
deployment this replaces drew them with five stylesheet rules keyed on each provider's URL. A portal
deployment cannot ship a stylesheet - there is no consumer CSS hook, by design - so the mark is a
configured local file that the portal publishes and projects onto the root document's provider
entries, and `Providers` draws it when it is there. `logo` also joins the key list that decides
whether a provider is "simple": a provider with a mark is still a simple provider, and without that
one word every deployment that added logos would have silently switched its provider list to the
accordion.

Patch 0001 is the load-bearing one. 0002 exists because an ES module is evaluated
once per document: the bare `init()` at the bottom of `main.js` runs on the first
visit only, and every later entry to the route needs an explicit call. 0004 stops
the Browse drawer setting `overflow: hidden` on the host document.

0003 is Waterpark's colour-mode patch with the host swapped: it watches the
portal's `data-theme` on `<html>` where Waterpark watched Material's
`data-md-color-scheme` on `<body>`. The mechanism matters and is easy to get
wrong - it assigns STAC's own reactive `colorMode`, which its watcher commits to
the store, so _every_ component that reads the mode follows. Writing the
`data-bs-theme` attribute from outside, or forcing `enforcedColorMode` through
configuration, repaints the shell of the application and leaves its maps, code
blocks and tables behind. It also hides upstream's own theme button while the
sync is active, so the page has one theme control rather than two.

Nothing else is patched. In particular:

- **The catalogue lock needs no patch.** Upstream derives `allowSelectCatalog`
  from `!config.catalogUrl`, so configuring a catalogue already removes the
  "switch catalog" control; `allowExternalAccess: false` closes the `external/`
  route as well. The portal sets both. See `packages/portal/docs/stac.md`.
- **The build manifest needs no patch.** The hashed entry file names are read out
  of upstream's own built `index.html` - the file the embed does not use - and
  written to `dist/EMBED.json`.
- **The global CSS is handled after the build, not in source.** See below.

## What the build does instead of patching

`scripts/build.mjs` rewrites the rule-sets in the compiled CSS that name the
document itself - `:root`, `html`, `body`, and a _leading_ `[data-bs-theme=…]` -
so they match the mount element instead, then asserts that none are left. Almost
all of upstream's CSS is already safe (component styles are either
`#stac-browser`-scoped or carry a `data-v-` hash), so this touches about
thirty-four rule-sets rather than the whole 300 KB, and a leak fails the build
rather than a visitor's page.

**Both theme blocks must be scoped, or neither.** Upstream's
`:root,[data-bs-theme=light]` and `[data-bs-theme=dark]` have equal specificity
and are decided by source order, so dark wins when the attribute says dark.
Scope only the light one and it becomes `#stac-browser-mount, …` - an id
selector that matches whatever the theme is and outranks the dark block it is
supposed to lose to. The symptom is an application that goes _half_ dark: the
attribute flips and the page background follows, while every surface driven by
a Bootstrap variable - cards, tiles, tables, inputs - silently stays light. A
browser test now asserts `--bs-body-bg` actually changes, because asserting the
attribute proves nothing.

A `[data-bs-theme=…]` that is not leading is a component rule and is left alone,
as is any selector that also names `#stac-browser`: `[data-bs-theme=dark]
#stac-browser .fullscreen` cannot reach outside the embed, because the element
it ends at is inside it.

## Relationship to Waterpark

The Waterpark deployment (`grid-doctor/docs/assets/`) carries eight patches
against an unreleased `main` commit
(`75fa292087dab160bc10389d2a3238fa6712cf11`, 51 commits before `v5.0.0`), by
`tropicrainforest <tropicrainforest27017@gmail.com>`, **with no stated licence**.

That series is the proof that this integration works, and it is where the
approach comes from - mount into a host element, expose init, scope the colour
mode, stop the drawer scroll-locking the host. **No Waterpark patch text has been
copied.** Each patch here was written against this workspace's pinned revision,
with its own comments explaining the change in the portal's terms, and applied to
different files in some cases (Waterpark's series targets a different revision).

Three of Waterpark's four remaining patches are now carried too, as 0005-0007. They were written
against this workspace's pinned revision - the earlier judgement that they were cosmetic or
unobserved did not survive contact with a real deployment:

| Waterpark patch     | here as | why the earlier judgement was wrong                                                                                                                                                                             |
| ------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `validation-link`   | 0005    | "Worth revisiting if the report proves to freeze the embed here too; it has not been observed." It has now. Following the tick in place replaces the portal's page with the report and strands the back button. |
| `modal-teleport`    | 0006    | "The portal scopes styles at build time instead." True, and beside the point: a modal teleported to `document.body` is outside `#stac-browser`, so the scoped rules cannot reach it either.                     |
| `readmore-expanded` | 0007    | "Cosmetic: a deployment preference." On a landing page the catalogue description is the content, and three clamped lines read as a broken paragraph rather than as a summary.                                   |

One is still not carried, and that one really is unnecessary:

| Waterpark patch         | Why it is not here                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------- |
| `vite` (build manifest) | Enables Vite's manifest. The entry names are read from the built `index.html` instead. |

Waterpark also mirrors MkDocs Material's palette toggle into STAC through a
`MutationObserver` on `<body>`. The portal does not: patch 0003 scopes the colour
attribute to the embed and leaves STAC's own toggle in place, which is one moving
part fewer.

## Upgrading the pin

Each patch is applied with `git apply` from a clean checkout, in filename order,
and a patch that does not apply **stops the build**. That is deliberate: a patch
that silently no-ops against a new revision would leave an artefact that no longer
matches what this file describes. Re-derive the failing patch against the new
revision, and re-read the CSS-scoping assertion output - a new upstream global
rule would fail the build too.
