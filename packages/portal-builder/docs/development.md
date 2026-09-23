# Developing the builder

The builder compiles against three workspace packages, so a clean checkout has
to build those first - `npm run build -w @freva-org/portal-builder` on its own
fails with `Cannot find module '@freva-org/databrowser/intent'`:

```console
npm ci
npm run build -w @freva-org/freva-client-terminal
npm run build -w @freva-org/ts-oidc-auth-client
npm run build -w @freva-org/databrowser
npm run build -w @freva-org/portal-builder
npm test      -w @freva-org/portal-builder
```

Rendering RST locally needs the pinned helper. Either use the canonical image, or
install the repository's copy:

```console
python3 -m venv .venv && .venv/bin/pip install ./tools/portal-rst-renderer
```

The builder finds it via `FREVA_PORTAL_RST`, then the `freva-portal-rst`
executable, then `tools/portal-rst-renderer/src` for local development. It never
downloads Python during a build.

Rendering diagrams needs the pinned browser; set `FREVA_PORTAL_CHROMIUM` if your
image keeps it somewhere the installed Playwright does not look.

Building a consumer that enables STAC needs prepared materials. Freva owns the recipe centrally in
`packages/stac-browser`; a deployment forks nothing and pins nothing of its own. Preparation is one
explicit, network-enabled stage, and it is **not** part of `npm run bootstrap`: a repository that
fetched and compiled a third-party application on every bootstrap would make everyone pay for a
feature almost nobody enables.

```console
npm run stac:prepare -- --out /tmp/stac-materials
```

That verifies the pinned commit, upstream's lockfile and its licence text against the recipe,
applies the reviewed patch series with `git apply --check` first and no fuzzy or three-way
matching, builds with the recorded settings, and writes a verified directory with a manifest, a
tree digest and a provenance record. It prints a cache key derived from the commit, the lockfile
digest, the ordered patch digests, the recipe version and the toolchain.

The build then consumes that exact directory, with no network and no searching:

```console
freva-portal-builder build --source-root . --config portal.yaml --out dist \
  --stac-materials /tmp/stac-materials
```

A consumer that does not enable a `stac-browser` component needs none of this - build with
`enabled: false`, offline, and the artifact contains no STAC byte at all.

## Layout

```
packages/portal-builder/
├── bin/          the executable
├── schema/       published schemas, the rendering profile, size budgets
├── src/
│   ├── config/   safe YAML, JSON Schema, the path trust anchor
│   ├── model/    the resolver and ResolvedPortalModel
│   ├── rendering/ the profile pipeline, Markdown, the RST adapter, sanitizers
│   ├── routes/   route derivation and collision detection
│   ├── components/ the closed registry, the STAC adapter, prepared materials
│   ├── themes/   the preset registry
│   ├── build/    virtual modules, the compiler run, evidence, manifests
│   ├── verify/   artifact verification, host-check, preview
│   └── cli/      the command surface and migration
├── astro/        the page templates the compiler consumes
├── client/       the browser islands
└── tests/        contracts, rendering, components, security, artifact, packaging
```

## Where to make a change

| Change                    | Where                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| A new configuration field | `schema/portal.schema.json`, `src/config/types.ts`, the resolver, a contract test                                        |
| A new landing block       | `schema/landing.schema.json`, `src/model/resolve.ts`, `astro/src/components/Blocks.astro`, accessibility and theme tests |
| A new theme preset        | `src/themes/registry.ts` plus the theme swap test                                                                        |
| A new component           | `src/components/registry.ts`, an island in `client/`, the enablement matrix                                              |
| Rendering behaviour       | `schema/portal-content-v1.profile.json` first, then the pipeline, then golden fixtures                                   |

Two rules are worth stating because they are easy to break by accident:

- **The profile file is normative.** Code reads it. Do not restate an allowlist
  in TypeScript; two copies of a security rule is one copy too many.
- **Nothing in `src/` may sort with `localeCompare`.** Its result depends on the
  machine's locale data, which would make an artifact non-reproducible for a
  reason unrelated to the site. Use `compareCodePoints` from `src/util/order.ts`.

## Tests

| Suite                | Command                              | What it settles                                                               |
| -------------------- | ------------------------------------ | ----------------------------------------------------------------------------- |
| Unit and integration | `npm test`                           | Schema, containment, services, routes, rendering, components, artifacts       |
| Enablement matrix    | included in `npm test`               | All eight combinations of the three components                                |
| Reproducibility      | included in `npm test`               | Two clean builds, compared byte for byte                                      |
| Hermeticity          | included in `npm test`               | A build in a process where the network genuinely fails                        |
| Real browser         | `npm run test:browser:strict`        | Deep links, JavaScript disabled, CSP, accessibility, islands, the subsite     |
| Package index        | `npm run test:browser:package-index` | The generated CSP against the `freva-client` profile, with a real interpreter |
| Packaging            | `npm run test:packaging`             | The real tarball, installed into a clean project                              |
| Bill of materials    | included in `npm test`               | The licence inventory and SBOM against the browser sources and the lockfile   |

Two of those deserve a note.

The **accessibility scan of the catalogue route** does not exclude the mounted application. It is
scanned with a catalogue actually loaded, and its findings are compared against
`browser-tests/fixtures/stac/upstream-a11y.mjs` — a written list of upstream's own serious and
critical findings at the pinned commit, each with the element and why the portal cannot fix it from
outside. A finding that is not on the list fails; a finding that stops appearing on the root view
fails too, so an upgrade that fixes something shrinks the list rather than leaving a stale excuse.
Outside the mount the standard is unchanged: zero serious or critical findings, including the
portal-owned introduction region directly above it.

The **bill of materials** is resolved from `package-lock.json` rather than from `node_modules`, and
covers the transitive closure of the packages that reach a reader — not just this package's direct
dependencies. Which roots those are is written down in `scripts/license-report.mjs`, because it is
a fact about the code rather than something a script can infer safely; `tests/artifact/licence-inventory.test.ts`
checks that list against what the browser sources import and what each component says it owns. The
SBOM additionally enumerates the packages compiled into the prepared STAC Browser, from upstream's
own lockfile, and refuses to enumerate one whose digest the recipe does not record.

## Versioning

The public API is the YAML schemas and their semantics, the CLI, the component,
service, theme, block and profile identifiers, and the route and artifact
contracts. The builder follows Semantic Versioning from 1.0.0; the legacy
runtime package's calendar-looking version is not reused as a compatibility
signal for a different product role.

`portal-content-v1` is immutable in accepted safe syntax, anchors and valid DOM.
New syntax or changed heading/link semantics require a new named profile.

One class of change is additive rather than new: a frontmatter key the profile
did not allow before. A document that renders today cannot contain one — it
would have been a `PC1005` error — so adding a key to `allowedKeys` changes no
existing document's output, no anchor and no DOM. It is still a change to the
profile: the digest moves, the artifact records the new one, and the key has to
be documented in `content-profile.md`'s closed list alongside the others.
`navOrder` was added under this rule. A key that changed how existing content
renders would not qualify, whatever its name. A
security correction may reject input demonstrated to be unsafe in a patch
release; it changes the profile digest, carries an advisory and a migration
diagnostic, and must not otherwise change accepted safe syntax.
