# Components and services

A component is a built-in interactive application. The framework owns what it is;
you own whether it exists and which public endpoint it talks to.

## Enable and disable

```yaml
components:
  data:
    kind: databrowser
    enabled: true
    service: dataApi
    route: /data/
```

When a routed component is **enabled**, the build generates its route as a real
HTML file, adds the navigation entries that reference it, includes its browser
entry and required chunks, emits only its validated public service and option
projection, records its module graph and copied files, and runs its tests.

When it is **disabled**, there is no route, no navigation reference, no
initializer, no owned module in the bundle, no copied asset, no emitted service
projection and no request. The generated island entry contains literal imports
for enabled components only — a runtime lookup table containing every component
would defeat this, because a bundler cannot drop what it cannot prove unused.

That mechanism is necessary but not sufficient, so the build also records the
real module graph and copy manifest and fails if anything owned by a disabled
component appears through a barrel, a CSS import, a shared chunk or a stray copy.
`verify` re-checks the recorded evidence and the known asset namespaces against
the artifact. It does not claim to reconstruct a source graph from minified
files, and CSS-hiding a component satisfies none of this.

## Data Browser

```yaml
options:
  defaultFlavour: freva # any flavour YOUR freva-rest serves, not a fixed list
  fixedFacets:
    project: example
  scopeRemovable: false # may a visitor take the fixed facet off?
  defaultLayout: browse # or `overview`
  overview:
    mainFacets: [variable, experiment, model, __time, __bbox]
    order: [variable, experiment, model, __time, __bbox]
```

`defaultFlavour` names a lens your own freva-rest instance serves. It is
constrained to an identifier, never to a list of names this builder happens to
know: a deployment serving a `waterpark` flavour must be able to say so.

`defaultLayout` is a **default, not a lock** — the Browse/Overview control is
still there, and a visitor's own choice is remembered over it on their next
visit.

`overview.mainFacets` chooses which blocks are main; everything else **moves**
under "Show additional facets" rather than being hidden, so a scoped deployment
can push its locked facet out of the first position without losing it.
`overview.order` sets the sequence, and keys you do not name keep their natural
position _after_ the ones you do — naming three blocks is a statement about
those three, not an accidental hiding of the rest. Both accept `__time` and
`__bbox`, the two blocks that are not facets, so the map can be ordered among
the facets rather than pinned after them.

`scopeRemovable` decides whether a value from `fixedFacets` can be taken off.
The default, `false`, renders it locked and survives "Clear all"; `true` makes it
a starting point instead of a boundary. **Neither is an authorization boundary** —
the scope is applied in the browser, and a fixed facet is presentation, not
tenancy.

Every one of these defaults to what the widget does when told nothing, so a
`portal.yaml` that states none of them builds exactly as it did before they
existed.

Authentication, URL synchronization and theming are the adapter's, not
duplicated here. When its service declares `authentication: required`, an auth
component must be enabled; with `optional` it works anonymously and receives a
token supplier when auth is present.

A landing `component-search` block hands a search over as a versioned
`SearchIntentV1` serialized into the component's own URL contract, consumed by a
typed initializer in the Data Browser package. No DOM selectors, no globals, no
in-memory state that a reload would erase — and the form is a plain GET form, so
it works without JavaScript.

## STAC Browser

STAC Browser is a pinned third-party application behind a framework-owned
adapter. **The adapter is the public contract, not upstream's option list.**
Mirroring every upstream option would create a shadow API; passing them through
would make upstream's breaking changes yours.

```yaml
options:
  chrome:
    title: Example Catalog
    image: ./assets/catalog-mark.svg
    footerLinks:
      - label: Institute
        href: https://www.example.org/
  access:
    externalCatalogs: deny
  rootPage:
    title: Example Research Catalog
    intro: ./content/_fragments/catalog-intro.md
    keywords: [example, reanalysis]
    license: CC-BY-4.0
    providers:
      - name: Example Institute
        url: https://www.example.org/
        roles: [host]
  linkPolicy:
    canonicalizeAdvertisedRoot: true
    hiddenRelations: [service-desc]
    rootAliases:
      - https://internal.example.org/stac/
```

- `rootPage.intro` is rendered by `portal-content-v1` and shown on the catalog
  root. It is markup the portal owns: it is never handed to upstream and never
  passed through upstream's own CommonMark renderer. Supplying one replaces the
  API's root description in this presentation, so the two do not appear as
  duplicate copy one above the other.
- `rootPage.title`, `description`, `keywords`, `license` and `providers` are
  **this deployment's presentation of the catalog root**, applied to the root
  document and to nothing under it. They do not modify — and do not claim to
  modify — the remote STAC API: a licence or provider stated here is what this
  portal displays, not an assertion the API makes. Metadata every client should
  see still belongs in the STAC root document; these exist for the deployment
  that publishes a catalog it does not own the metadata of.
- The route's page title follows the same names. `title` on the component wins,
  then `rootPage.title`, then `chrome.title`, then the framework's default — so
  the browser tab, the meta description and the catalog's own heading do not end
  up telling a visitor three different things.
- `canonicalizeAdvertisedRoot` normalizes root-equivalent spellings of your
  catalog URL, resolving each advertised link against the document that supplied
  it rather than against the portal page. A query is part of the catalog's
  identity — `?visible_collections=a,b` is a different catalog from the
  unfiltered one — but it is compared as parameters, so a re-encoded or
  reordered query is still the same catalog.
- `linkPolicy.rootAliases` lists the URLs this deployment **declares** to be the
  same catalog; the root and anything beneath one is rewritten to the public
  catalog URL. Nothing else is: an unlisted origin is never guessed to be an
  alias, because that could turn a genuine external link into a trusted local
  one.
- History mode and the upstream path prefix are **derived** from the canonical
  base and the resolved route, not configurable. That is what makes a reload of
  `/catalog/#/collections/x` land on the generated route rather than requiring an
  SPA fallback from the host. The adapter reads them back to know which view is
  on screen, which is how the introduction appears at the root and nowhere else.
- `access.basemapOrigins` decides whether the map fetches tiles from anyone else. Upstream draws a
  basemap on every document with a footprint, from `openstreetmap.org` or `usgs.gov`, once per
  tile, from the visitor's browser. The default is an empty list: no third-party request, and a map
  that shows the footprint over blank ground. Listing an origin is one statement that does two
  things — it reaches the application and it adds that origin to the artifact's `img-src` — so the
  policy and the map cannot disagree, and upstream's own attribution is displayed with the layer.
- **No service worker is published.** The prepared tree drops upstream's `sw.js` and `mitm.html`
  (StreamSaver's download shim) and its `.htaccess`. None can work under a portal policy of
  `default-src 'none'` with no `worker-src` and no `frame-src`, and a service worker script served
  from the deployment's own origin is an interceptor for everything under its scope — one relaxed
  directive away from being live, and outliving the page that registered it. The visible
  consequence is that upstream's "alternative download" does not work, which is what it already did
  under this policy.
- The catalog URL reaches upstream **resolved against the portal document**. A
  deployment states it the way it states any other portal URL (`/api/.../stac/`);
  a relative base cannot tell upstream that an advertised absolute link belongs
  to the same catalog, which renders such children as raw hrefs instead of browse
  routes.

There is no `upstreamOptions` map, no `SB_CONFIG` path, no `runtime-config.js`
and no JavaScript callback. The adapter generates the upstream configuration and
any required hook from named, framework-owned operations; the result is bundled
and content-hashed.

Upstream source, dependencies, patches and licences are prepared when the
canonical image is built. A consumer build neither clones upstream nor runs an
inner install. An upgrade is an adapter-maintenance pull request: bump the exact
tag and commit, verify hashes, read upstream's configuration and security
changes, rebuild in the network-enabled preparation job, run the adapter
fixtures and browser tests, and either prove the consumer schema is unchanged or
release a deliberate migration. A new upstream option is not automatically
exposed.

## Auth

```yaml
options:
  callbackPath: /auth/callback/
  expectedIssuer: https://identity.example.org/realms/portal
  additionalResourceOrigins:
    - https://jobs.example.org
```

Two values are **derived and not configurable**: the absolute `redirectUri`
(from `site.canonicalUrl` plus `callbackPath`) and the bearer-resource allowlist
(the credential-accepting services, plus the origins you listed). The first
prevents a base-path change from silently breaking login; the second prevents a
token being attached merely because some URL appeared in site content.

Enabling auth generates `<callbackPath>/index.html`. That page carries
`<meta name="referrer" content="no-referrer">` before any subresource, loads no
third-party resource, scrubs the callback parameters with `history.replaceState`
as its first client action, validates the stored same-origin return path, and
redirects. A direct visit without a transaction shows a safe message and a link
home. The host must serve it with `no-store`, `Referrer-Policy: no-referrer`, and
must redact its query string from access logs; those are conformance
requirements recorded in `host-policy.json`, not deployment advice.

Disabling auth removes the page, the initializer, the account control and the
auth client bundle.

## Runtime API rule

Components may call live APIs after the static shell has loaded. They receive
only the public endpoint and non-secret public options produced at build time.
Tokens are acquired at runtime and are never written into build output.

> Live data may be runtime. Instructions for constructing the site may not.
