# External-consumer playground

How a consumer tests **its own sources** against the portal builder, from a
clean checkout, without putting anything of its own into this repository.

The framework repository stays generic: it contains no consumer content, no
consumer branding and no consumer code path. Everything that varies is an
argument. `waterpark` appears in this repository only as the name of a swappable
visual preset, and neither the builder nor the smoke command branches on any
consumer's name.

## Why staging, and what the command does

FP-001 gives a build exactly **one trusted source root** and refuses a symlink
that leaves it. That rule is what makes an artifact's input manifest mean
something: every declared input is a real file under one root, so it can be
hashed and recorded. It also means you cannot point the builder at two
repositories at once, and you must not try to fake it with symlinks.

So the supported command stages instead. It copies the parts of your tree that
are under test into a **disposable staging root**, by value, refusing symlinks,
and builds that.

```console
freva-portal-builder smoke --help
```

| Argument              | Meaning                                                               |
| --------------------- | --------------------------------------------------------------------- |
| `--stage <dir>`       | Disposable staging root. Must be empty or absent.                     |
| `--copy <src>=<dest>` | Copy an external tree or file to a staging-relative path. Repeatable. |
| `--config <rel>`      | The `portal.yaml`, staging-root-relative.                             |
| `--out <dir>`         | Artifact output. Must be outside `--stage`.                           |
| `--effective-at <ts>` | Only when the configuration has dated announcements.                  |
| `--result <file>`     | Where to write the JSON smoke result.                                 |
| `--keep`              | Keep the staging root for inspection.                                 |

It runs `validate`, then `build`, then `verify`, stopping at the first failure,
and writes a JSON result with the exact command, exit status, builder identity,
input-manifest digest, artifact checksum digest and the list of failed checks.

**It exits nonzero unless every step succeeded and nothing was refused during
staging.** There is no partial pass: a file that could not be staged is a file
the build did not see, so the artifact does not describe the inputs anybody
meant.

`smoke` is part of the published package, so the recipe below works from an
`npm install` or from the digest-pinned image, not only from a checkout of this
repository.

## The two rendering lanes

**Portal-content lane.** `.md` and `.rst` sources are rendered by the builder
through `portal-content-v1`. The portal owns the output: it is sanitized, it
inherits the site chrome and theme, its headings and anchors are generated
deterministically, and every link and image is resolved at build time. This lane
reports unsupported constructs with file and line, which is what makes it useful
before it is convenient.

**Full-documentation lane.** Some documentation is produced by a generator with
its own theme, navigation and search. The portal builder **never runs that
generator**. Your pipeline builds it separately, and the already-built output is
staged and declared as a `static-docs-v1` trusted subsite. The builder then
inspects it: it parses every HTML and CSS file, requires every fetched
subresource to be local and present, permits an external frame or connection
only when your policy names its exact origin, refuses inline event handlers and
active URLs, and derives the subsite's Content Security Policy from what it
actually found.

Both lanes can be used in one site, mounted at different paths. The recipe uses
both.

## The recipe

Copy-paste, from a clean checkout, in order.

### 1. Required tools, with exact version checks

```console
node --version          # v24.x or newer
npm --version
git --version
python3 --version       # only for the RST helper and your own docs build
```

### 2. Get a builder

**The canonical image** is the supported path, and the only supported path for
RST without extra setup, because it carries the exact Docutils the rendering
profile pins:

```console
docker pull ghcr.io/freva-org/portal-builder@sha256:<digest>
```

**Or install the package**:

```console
npm install --no-save @freva-org/portal-builder
export PATH="$PWD/node_modules/.bin:$PATH"
freva-portal-builder --version
```

**Or from a checkout** of this repository:

```console
npm ci
npm run build -w @freva-org/freva-client-terminal
npm run build -w @freva-org/ts-oidc-auth-client
npm run build -w @freva-org/databrowser
npm run build -w @freva-org/portal-builder
```

### 2a. If your configuration enables STAC, prepare the materials

A portal build never fetches, patches or compiles upstream. It consumes a directory that one
separate, network-enabled stage produced, and it consumes the directory you name - it does not go
looking. The recipe below enables STAC, so this step is not optional for it; a build without it
stops with `FP1604` and tells you the two commands.

Freva owns the recipe centrally. You do not fork it, copy its patches or pin your own upstream:

```console
npm run stac:prepare -- --out /tmp/stac-materials
```

That fetches the pinned commit, verifies it against `packages/stac-browser/upstream.json`, applies
the reviewed patch series, installs upstream's own dependency tree from upstream's own lockfile,
builds, and writes a verified materials directory with a manifest, a tree digest and a provenance
record. It prints the cache key for those inputs.

Then hand that exact directory to the build:

```console
freva-portal-builder build --source-root . --config portal.yaml --out dist \
  --stac-materials /tmp/stac-materials
```

`FREVA_PORTAL_STAC_MATERIALS=/tmp/stac-materials` says the same thing for CI that prefers an
environment variable. Neither the published packages nor the base builder image contains a
compiled STAC Browser, so there is no third place it could come from - which is the point.

**Or skip STAC entirely.** If you are not embedding a catalogue, set
`enabled: false` on the `stac-browser` component in the overlay below and delete
its `publicCatalog` service, its navigation entry and its landing card. Nothing
above is then needed, and the artifact contains no STAC byte at all - which the
enablement matrix checks.

An installed package renders Markdown out of the box. For **RST** it needs the
pinned helper, which is not an npm dependency:

```console
python3 -m venv /tmp/portal-rst
/tmp/portal-rst/bin/pip install 'docutils==0.23' \
  git+https://github.com/freva-org/freva-web-nextgen#subdirectory=tools/portal-rst-renderer
export FREVA_PORTAL_RST=/tmp/portal-rst/bin/freva-portal-rst
```

The builder compares the whole handshake - protocol, package, version and
Docutils version - and refuses anything else rather than rendering RST with
whatever happens to be installed. If you do not need RST, skip this and the
builder will tell you if a document needs it.

### 3. Set and check `SOURCE_DATE_EPOCH` first

Before any build command, because a build is not reproducible without it.
`SOURCE_DATE_EPOCH` is **non-negative integer seconds**, not a timestamp string,
and it is a property of the revision rather than of when the job ran:

```console
export WATERPARK_DOCS_ROOT=/absolute/path/to/the/consumer-owned-repository
export SMOKE=/tmp/portal-smoke
export SOURCE_DATE_EPOCH="$(git -C "$WATERPARK_DOCS_ROOT" show -s --format=%ct HEAD)"

case "$SOURCE_DATE_EPOCH" in
  ''|*[!0-9]*) echo "SOURCE_DATE_EPOCH must be integer seconds"; exit 1 ;;
esac
echo "building as of $SOURCE_DATE_EPOCH"
```

### 4. Create the staging area and a temporary pilot overlay

If the consumer repository already contains a portal configuration, skip the
overlay and stage that instead. If it does not, this is a complete, runnable
overlay. It lives in the staging area, is deleted with it, and belongs to
neither repository.

```console
rm -rf "$SMOKE"
mkdir -p "$SMOKE/overlay/portal/landings" "$SMOKE/overlay/portal/subsite-policies" \
         "$SMOKE/overlay/portal/assets"

cat > "$SMOKE/overlay/portal/PILOT-OVERLAY-README.md" <<'EOF'
# Temporary pilot overlay - part of no repository. Delete with the staging root.
# Every value below is a placeholder. Replace before this is anything but a test:
#   site.id, site.title, site.canonicalUrl, site.institution
#   services.dataApi.baseUrl, services.publicCatalog.catalogUrl, services.authBroker.baseUrl
EOF

cat > "$SMOKE/overlay/portal/portal.yaml" <<'EOF'
# PILOT OVERLAY - placeholder identity and service values.
schemaVersion: 1

site:
  id: pilot-consumer                                   # REPLACE
  title: Pilot Consumer Portal                         # REPLACE
  language: en
  canonicalUrl: https://portal.example.org/site/       # REPLACE
  identity:
    logo: ./assets/logo.svg                            # REPLACE
    favicon: ./assets/favicon.svg                      # REPLACE
  institution:
    name: Example Institute                            # REPLACE
    url: https://www.example.org/                      # REPLACE

chrome:
  header:
    enabled: true
    links:
      - label: Reference
        href: /reference/
  footer:
    enabled: true
    groups:
      - title: Project
        links:
          - label: Documentation
            href: /docs/

theme:
  preset: waterpark          # any registered preset; themes are visual only

rendering:
  profile: portal-content-v1
  sources:
    - root: ../content
      mount: /docs/
      files:
        include: ["**/*.md", "**/*.rst"]
  assets:
    - root: ../content/assets
      mount: /docs/assets/
  diagnostics:
    warningsAsErrors: false

landings:
  home:
    path: /
    source: ./landings/home.yaml

services:
  dataApi:
    kind: databrowser
    baseUrl: /api/freva-nextgen/databrowser           # REPLACE
    authentication: optional
  publicCatalog:
    kind: stac
    catalogUrl: /api/freva-nextgen/stac/              # REPLACE
  authBroker:
    kind: auth
    baseUrl: /api/freva-nextgen/auth/v2               # REPLACE

components:
  data:
    kind: databrowser
    enabled: true
    service: dataApi
    route: /data/
    options:
      defaultFlavour: freva
  catalog:
    kind: stac-browser
    enabled: true
    service: publicCatalog
    route: /catalog/
    options:
      chrome:
        title: Pilot Catalog
      access:
        externalCatalogs: deny
  login:
    kind: auth
    enabled: true
    service: authBroker
    options:
      callbackPath: /auth/callback/

navigation:
  header:
    - landing: home
      label: Home
    - component: data
      label: Data Browser
    - component: catalog
      label: Catalog
    - href: /docs/
      label: Documentation

trustedSubsites:
  - profile: static-docs-v1
    source: ../reference-docs
    mount: /reference/
    trust: active
    policy: ./subsite-policies/reference.json
EOF

cat > "$SMOKE/overlay/portal/landings/home.yaml" <<'EOF'
schemaVersion: 1
title: Pilot Consumer Portal
description: A pilot landing page for an external-consumer smoke run.
blocks:
  - type: hero
    heading: Data, documentation and the catalog in one place
    summary: A pilot build of an external consumer's own sources.
    actions:
      - label: Browse data
        component: data
      - label: Read the documentation
        href: /docs/
  - type: cards
    heading: Where to go next
    items:
      - title: Documentation
        summary: Prose rendered by portal-content-v1.
        href: /docs/
      - title: Reference
        summary: A separately generated documentation subsite.
        href: /reference/
      - title: Catalog
        summary: Browse the STAC catalog in place.
        component: catalog
EOF

cat > "$SMOKE/overlay/portal/subsite-policies/reference.json" <<'EOF'
{
  "schemaVersion": 1,
  "profile": "static-docs-v1",
  "entryPoints": ["index.html"],
  "runtime": { "connectOrigins": [], "frameOrigins": [], "workers": "none" }
}
EOF

# Placeholder identity marks, so the overlay is complete rather than nearly so.
cat > "$SMOKE/overlay/portal/assets/logo.svg" <<'EOF'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Pilot">
  <rect width="64" height="64" rx="8" fill="#006f86" />
</svg>
EOF
cp "$SMOKE/overlay/portal/assets/logo.svg" "$SMOKE/overlay/portal/assets/favicon.svg"
```

### 5. Build the documentation subsite into the staging area

This is your pipeline, pinned by you, run by you. The builder does not invoke
it. `--site-dir` is not optional here: without it the generator writes inside
the consumer repository, and this recipe writes nothing there.

```console
mkdocs build --strict \
  -f "$WATERPARK_DOCS_ROOT/mkdocs.yml" \
  --site-dir "$SMOKE/docs-site"

# or:
sphinx-build -W "$WATERPARK_DOCS_ROOT/docs" "$SMOKE/docs-site"
```

Two properties of the output matter to `static-docs-v1`:

- **No external subresource.** A theme that loads fonts from a CDN is refused;
  an external _frame_ or _connection_ is accepted only if your policy names its
  exact origin, and a stylesheet or script never is. Most themes have a switch
  (`theme.font: false` in MkDocs Material), or you vendor the files.
- **Every referenced local file must exist.** A page referencing a stylesheet
  the build did not emit fails, rather than 404ing for a reader.

### 6. Validate

```console
freva-portal-builder smoke \
  --stage "$SMOKE/stage" \
  --copy "$SMOKE/overlay/portal=portal" \
  --copy "$WATERPARK_DOCS_ROOT/docs=content" \
  --copy "$SMOKE/docs-site=reference-docs" \
  --config portal/portal.yaml \
  --out "$SMOKE/out" \
  --result "$SMOKE/smoke.json" \
  --keep
```

`smoke` runs `validate` first and stops there if it fails, so the first run is a
diagnostics run. Read it: every finding names a file and, where the parser knows
one, a line.

### 7. Build and verify

The same command performs both once `validate` passes. To repeat either by hand
against the kept staging root:

```console
freva-portal-builder build --source-root "$SMOKE/stage" \
  --config "$SMOKE/stage/portal/portal.yaml" --out "$SMOKE/out"
freva-portal-builder verify --dir "$SMOKE/out"
```

Add `--effective-at 2026-08-18T00:00:00Z` **only** when the configuration
contains a dated announcement. The builder requires it in that case and refuses
it when nothing uses it, because an unused instant in an artifact is a false
statement about what the build depended on.

### 8. The same run in the canonical image

The container mounts the staging area **at its own absolute path**, so every
path the command prints, writes or records means the same thing inside and
outside. Mounting `$SMOKE` somewhere else and then passing host paths to the CLI
is the mistake this line exists to avoid.

```console
docker run --rm --network=none \
  -v "$SMOKE:$SMOKE" \
  -e "SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH" \
  ghcr.io/freva-org/portal-builder@sha256:<digest> \
  smoke \
    --stage "$SMOKE/stage" \
    --copy "$SMOKE/overlay/portal=portal" \
    --copy "$SMOKE/content=content" \
    --copy "$SMOKE/docs-site=reference-docs" \
    --config portal/portal.yaml \
    --out "$SMOKE/out" \
    --result "$SMOKE/smoke.json"
```

`--network=none` is not a precaution to relax when something breaks: a build
that needs the network is a defect in the image or the configuration.

Because the container cannot read the consumer repository, copy the content into
`$SMOKE` first:

```console
cp -R "$WATERPARK_DOCS_ROOT/docs" "$SMOKE/content"
```

### 9. Preview and check the artifact

```console
freva-portal-builder preview --dir "$SMOKE/out" --port 4321
```

`preview` reproduces directory indexes, the trailing-slash redirect and the
declared headers. It is not evidence about TLS, a CDN or your real canonical
URL; only `host-check` against a real deployment settles those.

Checks that need no browser, on the artifact itself:

```console
# Generated pages exist as real files.
test -f "$SMOKE/out/index.html"
test -f "$SMOKE/out/docs/index.html"
test -f "$SMOKE/out/404.html"

# Assets were copied and content-addressed.
ls "$SMOKE/out/_portal" >/dev/null

# The subsite is mounted where the configuration says.
test -f "$SMOKE/out/reference/index.html"

# Enabled components have routes; disabled ones have nothing. Rebuild with
# `enabled: false` for a component and confirm the route is gone:
test -d "$SMOKE/out/data" && echo "data browser route present"
test -d "$SMOKE/out/catalog" && echo "catalog route present"

# The recorded evidence agrees with the tree.
freva-portal-builder verify --dir "$SMOKE/out"

# The machine-readable result.
cat "$SMOKE/smoke.json"
```

Checks that **do** need a browser - JavaScript disabled, deep links, CSP
violations, island mounting, subsite frames and workers - are not claimed by
this recipe, because nothing above runs a browser. The framework's own strict
browser gate covers them:

```console
npm run test:browser:strict -w @freva-org/portal-builder
```

### 10. Negative probes, then clean up

Each of these must **fail**, and the failure is the evidence:

```console
# An output inside the trust root.
freva-portal-builder smoke --stage "$SMOKE/stage2" --out "$SMOKE/stage2/out" \
  --config portal/portal.yaml                                  # refused, nothing written

# A symlink into a disjoint repository.
ln -s "$WATERPARK_DOCS_ROOT" "$SMOKE/stage/escape"             # FP1002 on the next build

# A non-integer SOURCE_DATE_EPOCH.
SOURCE_DATE_EPOCH=2026-08-18T00:00:00Z freva-portal-builder build ...   # refused, with the git recipe as a hint

# An external subresource in the documentation subsite:
# rebuild the docs with the theme's CDN font enabled                    # FP1405, naming the URL

# A missing local resource in the documentation subsite.
rm "$SMOKE/stage/reference-docs/assets/stylesheets/"*.css              # FP1405, naming the file
```

Then:

```console
rm -rf "$SMOKE"
```

Nothing outside `$SMOKE` was written at any point, and `$WATERPARK_DOCS_ROOT`
was only ever read.

## The JSON smoke result

```json
{
  "schemaVersion": 1,
  "kind": "external-consumer-smoke",
  "result": "pass",
  "builder": {
    "name": "@freva-org/portal-builder",
    "version": "0.0.0",
    "purl": "pkg:npm/%40freva-org/portal-builder@0.0.0",
    "image": null
  },
  "inputManifestDigest": "sha256:...",
  "artifactChecksumsDigest": "sha256:...",
  "staged": [{ "source": "...", "destination": "portal", "files": 4, "refused": 0 }],
  "refusedDuringStaging": [],
  "steps": [{ "name": "validate", "command": "...", "exitStatus": 0, "durationMs": 1824 }],
  "failedChecks": []
}
```

`result` is `pass` only when every step exited 0 **and** nothing was refused
during staging; the command's exit status says the same thing. `failedChecks`
names what failed, including `staging`, and each step keeps the last 40 lines of
its output, so a CI job can attach the result and nothing else.

## What this recipe deliberately does not do

- It does not symlink one repository into another. FP-001 refuses it, and the
  refusal is the feature.
- It does not run your documentation generator. A build that can run an
  arbitrary command is not a build with a closed input set.
- It does not copy anything into this repository. A file a smoke run needs from
  a consumer belongs in the staging root, which is deleted.
- It does not claim any browser observation it did not make.
