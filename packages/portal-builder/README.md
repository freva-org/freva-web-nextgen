# @freva-org/portal-builder

Build a Freva portal from declarative inputs. Closed YAML in, one immutable
static artifact out.

Everything about the site — its routes, navigation, theme, landing blocks and
prose — is decided while the artifact is built. The generated browser application
still calls live APIs for live things (data search, STAC, authentication), but it
never asks a service what the site _is_. That single rule is why a portal built
this way keeps working when the settings service is down, why a deep link is a
real file, and why two builds of the same inputs produce the same bytes.

> This is the build-time line. The existing `@freva-org/portal` package publishes
> a prebuilt runtime site and remains a maintenance line during migration; the
> two coexist deliberately and do not share an executable name.

## Install

The supported CI path is the canonical image, pinned by digest:

```console
docker run --rm --network=none \
  -v "$PWD:/src:ro" -v "$PWD/build:/out" \
  ghcr.io/freva-org/portal-builder@sha256:<digest> \
  build --source-root /src --config /src/portal/portal.yaml --out /out/portal
```

For local development against Node:

```console
npm install --save-dev @freva-org/portal-builder
npx freva-portal-builder validate --source-root . --config portal/portal.yaml
```

The npm path does not install Python. Rendering reStructuredText requires the
pinned `freva-portal-rst` helper with its exact Docutils, which the image
provides; the builder checks the whole handshake and stops if it does not match.

## The commands

```console
freva-portal-builder validate   --source-root . --config portal/portal.yaml
freva-portal-builder build      --source-root . --config portal/portal.yaml --out build/portal
freva-portal-builder dev        --config portal/portal.yaml
freva-portal-builder preview    --dir build/portal
freva-portal-builder verify     --dir build/portal
freva-portal-builder host-check --dir build/portal --url https://portal.example.org/
freva-portal-builder migrate    --from ui-manifest.json --out portal/
```

`--source-root` is the trust anchor and is mandatory for `validate` and `build`:
every config, landing, prose, asset, download and subsite input must resolve
inside it after normalization _and_ after the filesystem has canonicalized it.
Symlinks are refused. The output tree must be outside every declared input root,
and that is checked before anything is created.

There is no `--runtime`, no `--api-settings` and no silent HTTP fallback.

## A minimal site

```
site/
├── portal.yaml
├── landings/home.yaml
├── content/guide.md
└── assets/{logo.svg,favicon.svg}
```

```yaml
schemaVersion: 1

site:
  id: example-research
  title: Example Research Portal
  language: en
  # The exact absolute site-base URL. Its pathname is the one and only base path.
  canonicalUrl: https://portal.example.org/
  identity:
    logo: ./assets/logo.svg
    favicon: ./assets/favicon.svg

theme:
  preset: default

rendering:
  profile: portal-content-v1
  sources:
    - root: ./content
      mount: /docs/

landings:
  home:
    path: /
    source: ./landings/home.yaml
```

`examples/minimal-portal` and `examples/full-portal` in this repository are
working fictional consumers; the full one exercises every part of the contract.

## What the configuration can and cannot say

| You describe                                     | You do not describe              |
| ------------------------------------------------ | -------------------------------- |
| Site identity, chrome, a registered theme preset | CSS, fonts, or component styling |
| Named landings composed from framework blocks    | Astro components or JavaScript   |
| Content roots of Markdown and RST                | Renderer plugins                 |
| Public service URLs by kind                      | Credentials of any kind          |
| Which components are compiled in                 | How they are implemented         |
| Trusted documentation subsites, explicitly       | Arbitrary active files           |

Every portal-owned object is closed: an unknown key is an error with a JSON
Pointer and a line, never a quietly ignored extension point.

## Components

Three built-in components, each enabled by one field:

| Kind           | Service kind  | Route                        | What "disabled" means                                              |
| -------------- | ------------- | ---------------------------- | ------------------------------------------------------------------ |
| `databrowser`  | `databrowser` | required when enabled        | no route, no navigation entry, no module in the bundle, no request |
| `stac-browser` | `stac`        | required when enabled        | additionally no copied application files                           |
| `auth`         | `auth`        | one technical callback route | no callback page, no account control, no auth client               |

Absence is proved from the recorded build graph and copy manifest in
`component-evidence.json`, not inferred from filenames. Hiding a component with
CSS satisfies nothing.

## The artifact

```
build/portal/
├── index.html                 # and one real HTML file per route
├── 404.html
├── _portal/                   # content-hashed framework assets
├── identity/                  # sanitized logo and favicon
├── portal-manifest.json       # routes, components, services, files, cache classes
├── input-manifest.json        # every input hashed, plus builder/schema/profile identity
├── component-evidence.json    # what the bundler and the copier actually did
├── host-policy.json           # what a conforming host must do
├── BUILDINFO.json
└── checksums.sha256
```

The output directory _is_ the document root, mounted at the pathname of
`site.canonicalUrl`. For `https://example.org/portal/`, `index.html` is served as
`/portal/`; the builder does not emit `dist/portal/index.html`, and serving the
same directory at `/` is a deployment error rather than a supported relocation.

## Documentation

- [Consumer guide](./docs/consumer-guide.md) — repository shapes, CI, deployment
- [Configuration reference](./docs/configuration.md) — every field, with its rules
- [`portal-content-v1`](./docs/content-profile.md) — the accepted Markdown and RST
- [Components and services](./docs/components.md) — enablement, options, evidence
- [Hosting](./docs/hosting.md) — the conformance contract and recipes
- [Migrating from the runtime portal](./docs/migration.md)
- [Developing the builder](./docs/development.md)

## Licence

BSD-3-Clause.
