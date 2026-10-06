# Migrating from the runtime portal

The runtime portal assembled routes, navigation, chrome and content in the
browser from a settings API. The build-time portal decides all of that while the
artifact is produced. Most of the migration is therefore a translation of data,
plus a small number of things that deliberately do not come across.

## Start with the inventory

```console
freva-portal-builder migrate --from ui-manifest.json --out portal/
```

It reads a **saved** manifest — never the settings API — and writes:

- `portal/portal.yaml`, a candidate configuration to review;
- `portal/landings/home.yaml`, if the manifest had landing blocks;
- `portal/migration-loss-report.json`, naming every field that has no build-time
  representation, together with its supported replacement.

Nothing is silently discarded. Review every value; the tool cannot know your
canonical URL, and it writes a placeholder for it on purpose.

## What does not come across, and what to use instead

| Runtime field                | Replacement                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `uiId`                       | Nothing. One artifact is one site at one canonical URL.                                                             |
| `deployment-config.json`     | Build-time service declarations in `services`.                                                                      |
| `public_extensions`          | A typed service or component option. `stac_catalog_url` becomes `services.<id>.catalogUrl`.                         |
| `html-fragment`              | A Markdown or RST prose source rendered by `portal-content-v1`.                                                     |
| `sandbox-html`               | A declared `static-docs-v1` trusted subsite — on a separate origin if you do not intend to grant same-origin trust. |
| Clock-selected announcements | `startsAt`/`endsAt` plus `--effective-at` and a scheduled build at each boundary.                                   |
| An unrecognized feature flag | A framework capability proposal with a schema, tests and a registry entry.                                          |

## Moving a static documentation site

A site that already has public URLs - a MkDocs site, say - keeps them working
with `redirects:` (old path to route, landing or component; see the
configuration reference). What else a MkDocs site typically carries, and where
it goes:

| MkDocs feature                               | In the portal                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------- |
| Material `!!!`, `/// caption`, `grid cards`  | Read as written by `portal-content-v1`.                                         |
| Header search                                | `chrome.header.search: { enabled: true }` - a static index built with the site. |
| Runtime announcement banner from a JSON file | `announcementFeed.url` - the same file, read by the page at load.               |
| A newsletter sign-up form (e.g. listmonk)    | Stays with the newsletter service; see below.                                   |
| Scripts in `docs/` served as downloads       | `rendering.downloads` with `files.include`.                                     |

**A newsletter sign-up stays external, deliberately.** A double opt-in form collects a personal
address for another service and needs that service's privacy notice, abuse protection and
confirmation flow; authored forms are refused in content for the same reasons. Use the service's
own hosted page (listmonk serves one at `/subscription/form`) and point the old URL and a footer
link at it:

```yaml
redirects:
  - from: /newsletter/
    href: https://lists.example.org/subscription/form
chrome:
  footer:
    enabled: true
    groups:
      - title: Stay informed
        links:
          - label: Newsletter
            href: https://lists.example.org/subscription/form
```

## Classify the rest of the tree

For each source, decide which of four things it is:

1. **Portal content** — prose that belongs on the site. Move it under a content
   root and let `portal-content-v1` render it.
2. **Independently owned technical documentation** — keep it with its project.
   Link to it with a stable public URL, or consume it as an explicitly
   versioned, digest-verified artifact under the trusted-subsite rules.
3. **Generated output** — rebuild it; do not copy it.
4. **Obsolete** — delete it.

A current mixed tree is evidence to classify, not an artifact to copy wholesale.

## Remove local vendoring

Consumer-local Data Browser or STAC copies, patch stacks and portal JavaScript
are replaced by the central component packages, selected through YAML. Local
look and layout move into the two closed customisation capabilities instead of
local overrides: typed layout options in `portal.yaml`, a `portal-style-v1`
stylesheet for the public parts and tokens, and `portal-template-v1` slot
templates for the named slots ([customisation.md](customisation.md)). Both are
parsed and enforced by the builder; neither can enable a feature, change an
endpoint or own a route. A local theme stylesheet that overrode framework
classes is rewritten against `schema/style-parts-v1.json`; a patched header or
footer becomes header and footer options plus slot templates. If a consumer
needs something these cannot express, that is a framework capability proposal —
not permission for a local escape hatch, which is how a framework acquires as
many execution paths as it has consumers.

## Verify the outcome

```console
freva-portal-builder validate --source-root . --config portal/portal.yaml --diagnostics json
freva-portal-builder build    --source-root . --config portal/portal.yaml --out build/portal
freva-portal-builder verify   --dir build/portal
```

Then confirm in a browser that the production site makes **no** settings or
content API request, and that its landing, navigation and prose survive both a
backend outage and JavaScript being switched off.

## The legacy package

`@freva-org/portal` remains a maintenance line: security and critical fixes for
at least six months after the first stable builder release, and until every
known consumer has actually migrated or been decommissioned — unless its
accountable owner explicitly accepts the documented residual risk. An approved
plan is not the same as a completed migration. No dual runtime/static mode is
added to the new package.
