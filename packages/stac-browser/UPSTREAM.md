# Upstream STAC Browser

Freva owns one recipe for building Radiant Earth's STAC Browser, centrally, here. This workspace
publishes nothing and is not part of any ordinary build.

**A deployment decides two things: whether the closed `stac-browser` component is enabled, and
which STAC API it points at.** It does not fork this workspace, copy these patches, keep its own
upstream pin or write its own build script. ESGF uses exactly what any other Freva deployment uses.

## Where this fits

```
validate portal configuration
        |
is stac-browser enabled?
        |-- no  --> ordinary network-disabled portal build
        `-- yes --> prepare pinned STAC materials   (isolated, network-enabled)
                         |
                    ordinary network-disabled portal build
```

Two stages, deliberately different jobs with different privileges:

| stage        | network       | what it does                                                                                                  | what it produces                                                                  |
| ------------ | ------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| preparation  | yes, isolated | fetch the pinned commit, verify it, apply the reviewed patches, install upstream's own dependency tree, build | a verified materials directory with a manifest, tree digest and provenance record |
| portal build | **no**        | read the directory it is given, verify every declared file, copy them under the component's route             | the portal artifact                                                               |

Neither the generally published npm packages nor the base builder image contains the compiled
application. They contain this recipe. Nothing here ever runs at server startup: "prepared when
requested" means deployment build time.

## The recipe

[`upstream.json`](./upstream.json) is the whole of it, and the only place any of it is written:

| what                          | why it is recorded                                                                                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `repository`, `commit`, `tag` | the commit is verified; the tag is informational, because a tag can be moved                                                                                                         |
| `lockfile`, `lockfileDigest`  | the dependency tree decides what ends up in the bundle, so a different lockfile is a different artifact even at the same commit                                                      |
| `license`, `licenseDigest`    | identity _and_ text: a relicensed upstream stops preparation rather than being copied into an artifact that then misstates its terms                                                 |
| `toolchain`                   | a different Node major produces a different bundle under the same name                                                                                                               |
| `patches.series`              | ordered, each with a digest, an owner, what it changes, whether it affects rendering or only integration, the test that requires it, and the condition under which it can be dropped |
| `patchedTree.files`           | exactly which paths the series may leave modified - anything else dirty stops the build                                                                                              |
| `build`                       | mode, install command and the environment the recorded output was produced with                                                                                                      |
| `output`                      | the shape the result must have: entry and stylesheet patterns, required and forbidden files                                                                                          |
| `adapterContract`             | the reviewed upstream option surface, for exactly this pin                                                                                                                           |
| `expected`                    | the tree digest a verified preparation produces, as a signal rather than a gate                                                                                                      |

Institution-specific values - catalogue URL, title, logo, route, labels - are **not** here and are
never patched into upstream source. They are consumer configuration, validated by the closed portal
schema and driven through the typed adapter.

## Preparing

One command. It is the only supported way, and it is not part of `npm ci`, `npm run bootstrap`, any
package build, or any test that is not about STAC:

```bash
npm run stac:prepare -- --out /tmp/stac-materials
```

It, in order: checks the toolchain and the patch digests; fetches the pinned commit into an
isolated directory and verifies the object name and the origin; verifies the upstream lockfile and
the licence text; runs `git apply --check` over the **whole ordered series before applying any of
it**, so a series that cannot land leaves the checkout untouched; applies the patches with no fuzz,
no three-way merge and no partial application; asserts the modified set is exactly what the recipe
declares, in both directions, so a patch that applied as a no-op is caught too; installs upstream's
dependencies from upstream's own lockfile; builds with the recorded settings; verifies the output
shape, the notices and the adapter contract; writes a closed `materials.json` with a digest for
every file and a tree digest; writes `PROVENANCE.json`; and asserts no `.git`, no `node_modules`
and no forbidden file reached the result.

Then hand that exact directory to the build:

```bash
freva-portal-builder build --source-root . --config portal.yaml --out dist \
  --stac-materials /tmp/stac-materials
```

Or let the deployment routine do both, which is what a deployment actually runs:

```bash
node scripts/deploy-portal.mjs --source-root . --config portal.yaml --out dist
```

### A patch that no longer applies

Stops the build, naming the pin, the failing patch, its expected digest and the command to
investigate it. It is never dropped, regenerated or bypassed to get a build through. Re-derive it
against the revision and update its digest in the same reviewed commit.

### Air-gapped and mirrored preparation

```bash
npm run stac:prepare -- --upstream /srv/mirrors/stac-browser --out /tmp/stac-materials
```

A supplied checkout is held to the same verification: it must resolve to the pinned commit and
carry the recorded lockfile and licence.

### The cache key

```bash
npm run stac:cache-key
```

Derived from the upstream commit, the upstream lockfile digest, the ordered patch digests, the
recipe version and the Node/npm major versions - everything that can change the bytes. A private CI
cache may reuse a result under a matching key. It may never reuse one whose manifest or tree digest
does not verify, and the portal build re-verifies both regardless: a key match is permission to
skip the work, never the verification.

## Build configuration

| Setting           | Value           | Why                                                                                                                                                            |
| ----------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| build script      | `build:minimal` | upstream's own no-sourcemap build. Sourcemaps of a third-party bundle roughly triple the published portal tarball (49 MB -> 17 MB) for no consumer benefit.    |
| `DYNAMIC_CONFIG`  | `true`          | upstream's supported browser-safe runtime configuration. Emits `dist/runtime-config.js`, `<base href>` and document-relative asset URLs.                       |
| `SB_pathPrefix`   | `/stac/`        | the stable internal static mount inside the portal artefact.                                                                                                   |
| `SB_historyMode`  | `hash`          | a hash route is one document, so a deep route survives a reload on a plain static file server, and it cannot collide with the portal shell's history fallback. |
| `SB_catalogTitle` | `STAC Browser`  | a neutral default. The legacy path overrides it in `runtime-config.js`; the FP-001 adapter sets it from portal YAML at build time.                             |

### The one source transformation, and why it is not a patch

`index.html` ships upstream with the runtime-configuration tags already present
but commented out:

```html
<!--RC
<base href="<%- pathPrefix %>" id="stac-browser-base">
<script defer="defer" src="./runtime-config.js"></script>
RC-->
```

Upstream's [`docs/options.md`](https://github.com/radiantearth/stac-browser/blob/v5.0.0/docs/options.md)
instructs a deployment to remove the `<!--RC` and `RC-->` markers to enable it.
`scripts/build.mjs` does exactly that, then asserts with `git diff` that the
working tree differs from the pinned commit in **that one file** and **only** by
the removal of those two marker lines. Any other difference aborts the build.

That transformation is not a patch, and it is not the whole story. There are
also nine retained framework patches, listed and justified in
[`PATCH_PROVENANCE.md`](./PATCH_PROVENANCE.md) and recorded by name and digest in
every build record and every materials manifest.

## Two consumers, two paths

The compiled tree in `dist/` is read by two different things, and they make
opposite decisions about deployment-owned configuration. Keeping that
distinction explicit is the point of this section: a reader who takes the wrong
half of it will look for a `runtime-config.js` that the portal deliberately does
not ship, or will expect the legacy path to work without one.

Both paths get their materials the same way now - from the preparation stage above, on request.
Neither is served from a builder image that carries them, because no image does.

|                            | Legacy portal path                               | **FP-001 build-time path**                                                |
| -------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------- |
| Consumer                   | `packages/portal`                                | `@freva-org/portal-builder`                                               |
| Configuration              | `dist/runtime-config.js`, written at deploy time | generated at build time by the closed adapter, bundled and content-hashed |
| `runtime-config.js`        | shipped                                          | **removed** from the prepared materials                                   |
| `index.html`               | shipped                                          | **removed**; the portal generates the route itself                        |
| Retained framework patches | nine (see `PATCH_PROVENANCE.md`)                 | the same nine                                                             |
| Entry discovery            | `<script>` tags in `index.html`                  | `EMBED.json`, recorded in the build record                                |
| What the consumer trusts   | the pin                                          | the pin **and** a verified tree digest                                    |

### The FP-001 path

`scripts/prepare-materials.mjs` verifies `dist/` against its own closed build
record - tag, commit, build mode, ordered patch list with digests, embed
descriptor, entry and stylesheet existence, licence files, and a deterministic
digest of every file in the tree - and only then copies it into `materials/`.
Two files are deliberately dropped:

- **`runtime-config.js`**, because deployment-owned STAC configuration is exactly
  what the closed adapter replaces. FP-001 generates the configuration at build
  time from validated portal YAML, bundles it and content-hashes it. There is no
  deployment-owned script in an FP-001 artifact.
- **`index.html`**, because the portal generates the component route itself, so
  the upstream document would only be a second, unused entry point into the same
  application.

`materials.json` records the upstream tag and commit, the patch series with
digests, the entry module, the stylesheets, the mount element and a digest of
every prepared file - all of it derived from the verified build record rather
than re-read from the metadata files, so the manifest cannot describe one tree
while the digests come from another.

## Trust boundary

`dist/runtime-config.js` is **executable JavaScript owned by the deployment**. It
sits at the same trust level as the web server configuration, and it belongs to
the legacy portal path only.

It must never be generated from `freva-rest` settings. Settings are
administrator-editable data served over an API; turning that data into a script
tag would let a settings write execute code in every visitor's browser. The
portal never reads, writes or proxies this file — see
[`packages/portal/docs/stac.md`](../portal/docs/stac.md).

An FP-001 artifact has no such file at all. That is not a hardening of the same
design; it is a different one, in which nothing about the STAC component is
editable after the build.

## Upgrading

Once, here, for every deployment. Never once per deployment. The weekly workflow below does it for
every stable release; by hand it is the same two steps:

```bash
node packages/stac-browser/scripts/pin.mjs --commit <40-character object name> --tag <vX.Y.Z>
npm run stac:prepare -- --out <dir>
node packages/stac-browser/scripts/pin.mjs --materials <dir>
```

The first moves commit, tag, lockfile digest, `adapterContract.upstream` and the root README's
link to upstream at the pin. Preparation then
verifies the licence and every patch digest, applies the series and builds; a patch that no longer
applies stops it. The last records the expected tree digest. A changed licence digest or patch
digest is always edited by a person.

Then: run the browser, accessibility, routing and containment suites, and regenerate the SBOM and
licence evidence.

### Who moves the pin

`.github/workflows/stac-browser-update.yml`, every Friday and on demand - the same arrangement as
`freva-web`'s `stacbrowser_update.yml`. It resolves upstream's newest stable release tag (release
candidates are skipped), and when that is not the pinned commit it:

1. moves the pin with `scripts/pin.mjs` - `commit`, `tag` and `lockfileDigest` in `upstream.json`,
   `upstream` in `adapter-contract.json`, and the pinned-commit link in the root `README.md`;
2. runs `npm run stac:prepare` at the new release, and on success records the prepared tree digest
   and file count in `expected`;
3. opens a pull request labelled `stac-browser` with the upstream commit list, and a warning when
   upstream changed a file a patch touches or the options documentation the adapter contract was
   reviewed against.

A green build opens `⬆️ Bump STAC Browser to …` with auto-merge enabled; it lands once CI is green.
A red one opens `🚨 STAC Browser Build failed: …` as a **draft** on `stac-browser-candidate/…`,
with the tail of the build log, so a maintainer can fix it forward while `main` keeps the last
green release. Every pull request that touches the recipe is built by the same workflow's
`stac-browser (build at the pin)` job before it can merge.

Two things stay with a person. A changed LICENSE is never recorded by the bot: the recipe keeps the
reviewed digest, so preparation refuses and the pull request is a draft. And a patch that no longer
applies is never dropped or regenerated; the build fails, and the draft says where.

The pull requests are opened with the `freva-bot` app token when `FREVA_BOT_APP_ID` is set. With
the plain `GITHUB_TOKEN` they still open, but GitHub runs no checks on them, so nothing auto-merges.

## Licence

STAC Browser is ISC-licensed third-party code, copyright 2018-2018 Radiant Earth
Foundation. Freva-authored code in this workspace (the three scripts and the
tests) is BSD-3-Clause like the rest of the repository.

The ISC notice must survive four hops:

```text
upstream LICENSE
  -> packages/stac-browser/LICENSES/stac-browser-ISC.txt   (scripts/build.mjs)
  -> packages/stac-browser/dist/LICENSES/                  (scripts/build.mjs)
  -> packages/portal/dist/stac/LICENSES/ and packages/portal/LICENSES/
                                                          (portal scripts/bundle-stac.mjs)
  -> the published npm tarball                             (asserted by packages/portal tests)
```
