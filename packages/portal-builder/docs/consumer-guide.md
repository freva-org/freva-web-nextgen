# Consumer guide

## Where your site lives

Your site's inputs live in a repository _you_ own. The framework repository holds
generic software, schemas, themes, tests and fictional fixtures — never a real
project's content, branding, endpoints or deployment settings.

Which repository is an ownership and release decision, not a property of your
project's name, its theme, or which components it enables:

| Situation                                                                  | Shape                                                    |
| -------------------------------------------------------------------------- | -------------------------------------------------------- |
| The site and the project software have the same owners and release cadence | a `portal/` directory in the existing project repository |
| The site has its own owners, permissions, deployment or cadence            | a dedicated lean site repository                         |
| One team intentionally releases several sites together                     | a co-owned multi-site repository                         |

None of the three is the default, and a site can move between them without any
change to the builder.

### A portal directory in an existing project

```
example-project/
├── portal/
│   ├── portal.yaml
│   ├── landings/home.yaml
│   ├── content/
│   │   ├── _fragments/introduction.md
│   │   └── guide.md
│   └── assets/{logo.svg,favicon.svg}
├── docs/                          # your MkDocs or Sphinx sources
├── mkdocs.yml
├── .github/workflows/portal.yml
└── build/                         # generated, ignored
```

`portal.yaml` can point at `../docs`; your content does not have to move under
`portal/`. A repository pinned to the canonical image needs no `package.json`.

### A dedicated site repository

```
consumer-site/
├── portal.yaml
├── landings/
├── content/
├── assets/
├── downloads/
├── tests/expected-routes.yaml
└── .github/workflows/build.yml
```

It contains no portal implementation, no project JavaScript, no renderer, no
framework plugin, no STAC patches and no copied framework source. Everything
reusable is released by `freva-web-nextgen`; you select it through YAML.

### Several sites owned together

```
portals/
├── site-a/portal.yaml
└── site-b/portal.yaml
```

Each command still builds one config into one artifact for one canonical URL.
Co-locating configs does not create browser-side brand selection.

## The first build

```console
freva-portal-builder validate --source-root . --config portal/portal.yaml
freva-portal-builder build    --source-root . --config portal/portal.yaml --out build/portal
freva-portal-builder verify   --dir build/portal
freva-portal-builder preview  --dir build/portal
```

`preview` is a local convenience server. It reproduces directory indexes, the
slash redirect and the declared headers so you can look at the artifact, and it
is deliberately not evidence about TLS, a CDN, access logs or your canonical URL.
Only `host-check` against a real deployment settles those.

## CI

```yaml
name: portal
on: [push, pull_request]

jobs:
  build:
    runs-on: ubuntu-latest
    container:
      # Pinned by digest, never by tag.
      image: ghcr.io/freva-org/portal-builder@sha256:<digest>
    steps:
      - uses: actions/checkout@v4

      # Optional: build documentation that will be mounted as a trusted subsite.
      - run: mkdocs build --strict --site-dir build/reference-docs

      # SOURCE_DATE_EPOCH is non-negative integer seconds, and nothing else.
      # `github.event.repository.pushed_at` is an ISO-8601 string on several
      # event types, so derive the value from the commit being built instead.
      # It is a property of the revision, not of when the job happened to run.
      - id: epoch
        run: echo "value=$(git show -s --format=%ct "$GITHUB_SHA")" >> "$GITHUB_OUTPUT"

      # No network from here on. A build that needs one is a defect.
      - run: |
          freva-portal-builder build \
            --source-root "$PWD" \
            --config portal/portal.yaml \
            --out build/portal \
            --source-revision "$GITHUB_SHA"
        env:
          SOURCE_DATE_EPOCH: ${{ steps.epoch.outputs.value }}

      - run: freva-portal-builder verify --dir build/portal

      - uses: actions/upload-artifact@v4
        with:
          name: portal
          path: build/portal
```

Add `--effective-at` when your configuration contains a dated announcement; the
builder requires it for a release build and refuses it when nothing uses it.

## Pull-request previews

A preview is a **separate build from complete preview inputs**, with its own
`canonicalUrl` and its own public service values. CI must not patch a URL into a
production artifact, and must not serve one artifact under an unrecorded URL. Two
environments that differ in any public input are two artifacts with two digests;
promotion by digest is a property of identical inputs, not a rule that makes them
identical.

## Deployment

The artifact carries `host-policy.json`, and every target must satisfy it
whatever tool installs the bytes:

- mount the artifact root at the pathname of `site.canonicalUrl`;
- serve directory `index.html` files and real deep links, with no SPA fallback;
- redirect the non-slash directory form to the slash form, keeping the query;
- return the generated `404.html` for unknown routes;
- apply the declared MIME, `nosniff`, download, CSP and cache headers;
- apply `no-store` and `no-referrer` to the auth callback and redact its query
  string from access logs;
- never grant immutable caching to stable, unhashed project asset names.

Then check the real thing:

```console
freva-portal-builder host-check --dir build/portal --url https://portal.example.org/
```

Ansible may fetch and atomically install the artifact on a managed VM. It must
not organize content, run npm or Astro on the target, or become a second source
of truth for site configuration.

## Documentation that outgrows the portal

`portal-content-v1` is a deliberately small, safe prose subset. Anything that
needs includes, cross-references, API documentation or a plugin ecosystem should
stay in MkDocs or Sphinx. Publish it either as a stable link, or mount its built
output as a declared trusted subsite:

```yaml
trustedSubsites:
  - profile: static-docs-v1
    source: ../build/reference-docs
    mount: /reference/
    trust: active
    policy: ./subsite-policies/reference.json
```

That is same-origin, trusted, executable code — the portal copies it without
running your generator, and inventories what it references. If you do not intend
to grant that trust, deploy the documentation on a separate origin.
