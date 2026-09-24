# FP-001 v1 conformance map

Where each fixed decision and each Definition-of-Done item is implemented, and
which test settles it. Paths are relative to `packages/portal-builder` unless
stated otherwise, and every path in this file exists in the repository, except
those under `packages/portal/` and `delivery/`, which this repository does not
carry yet.

This table says where the evidence lives. It is not itself the evidence. What
actually ran, with exit statuses, tool versions and artifact digests, is in
`reports/fp001-acceptance.json` at the repository root, written (never
committed) by

```console
npm run acceptance
```

Every gate in that report is `pass`, `fail` or `not-run`, and `not-run` names the
exact external input that was missing. There is no code path in the runner that
produces a `pass` without a process having exited 0.

## Fixed decisions

| ID      | Decision                                                                              | Implementation                                                                                                                                                                            | Tests                                                                                                                    |
| ------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **D1**  | Presentation and content rendering are build-time only                                | `src/rendering/**`, `astro/src/pages/[...route].astro` generates a real file per route; the browser projection in `src/artifact/runtime-projection.ts` carries endpoints and options only | `browser-tests/run.mjs` ("no settings or content API request", "JavaScript disabled"), `tests/components/matrix.test.ts` |
| **D2**  | The framework repository holds generic software and fixtures only                     | `packages/portal-builder`, `examples/minimal-portal`, `examples/full-portal`                                                                                                              | `tests/contracts/repository-boundary.test.ts`                                                                            |
| **D3**  | Consumers own their real inputs outside the framework                                 | `--source-root` is the only input anchor; `docs/consumer-guide.md`                                                                                                                        | `tests/contracts/repository-boundary.test.ts`, `tests/packaging/pack-and-install.mjs`                                    |
| **D4**  | Closed declarative YAML, validated, contained by a trusted root                       | `schema/portal.schema.json`, `src/config/yaml.ts`, `src/config/schema.ts`, `src/config/paths.ts`                                                                                          | `tests/contracts/schema.test.ts`, `tests/contracts/containment.test.ts`                                                  |
| **D5**  | Theme presets are visual-only registered entries                                      | `src/themes/registry.ts`                                                                                                                                                                  | `tests/contracts/themes.test.ts` (including the swap test)                                                               |
| **D6**  | Typed services and components; auth owns one technical route                          | `src/model/urls.ts`, `src/components/registry.ts`, `src/model/resolve.ts`                                                                                                                 | `tests/contracts/services.test.ts`, `tests/components/auth.test.ts`                                                      |
| **D7**  | Disabling removes routes, nav, init, modules, assets, services; proved from the graph | `src/artifact/runtime-projection.ts` (literal imports), `src/artifact/plugin.ts` (graph and copy recording), `src/artifact/evidence.ts`                                                   | `tests/components/matrix.test.ts` (all eight combinations)                                                               |
| **D8**  | No settings/content API, no `uiId`, no `deployment-config.json`                       | Nothing fetches; `src/model/resolve.ts` reports each retired field                                                                                                                        | `tests/contracts/migration.test.ts`, `browser-tests/run.mjs`                                                             |
| **D9**  | One named content profile with a pinned RST helper                                    | `schema/portal-content-v1.profile.json`, `src/rendering/rst/client.ts`, `tools/portal-rst-renderer`                                                                                       | `tests/rendering/*.test.ts`, `tests/rendering/rst.test.ts` (handshake)                                                   |
| **D10** | Documentation stays MkDocs/Sphinx; subsites use a closed capability profile           | `schema/subsite-policy.schema.json`, `src/model/subsites.ts`                                                                                                                              | `tests/contracts/subsites.test.ts`, `browser-tests/run.mjs`                                                              |
| **D11** | No consumer Astro components, plugins, build commands or escape hatches               | Closed schemas; the CLI accepts no arbitrary command                                                                                                                                      | `tests/contracts/schema.test.ts`, `tests/artifact/cli.test.ts`                                                           |
| **D12** | One artifact per complete input graph and one exact URL                               | `src/model/urls.ts` (`canonicalUrl` is the sole base authority), `src/artifact/manifests.ts`                                                                                              | `tests/artifact/build.test.ts`, `tests/artifact/provenance.test.ts`                                                      |
| **D13** | Repository boundaries follow ownership, not a universal rule                          | `docs/consumer-guide.md`; the builder takes a source root and a config, nothing else                                                                                                      | `tests/packaging/pack-and-install.mjs`                                                                                   |
| **D14** | Ansible is outside the build; every host satisfies the conformance contract           | `host-policy.json`, `src/verify/host-check.ts`                                                                                                                                            | `tests/artifact/host-check.test.ts`                                                                                      |

## Definition of done

| Requirement                                                                                | Where it is settled                                                                        |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Every configured route has a real HTML file                                                | `tests/components/matrix.test.ts`, `tests/artifact/build.test.ts`, `browser-tests/run.mjs` |
| Landing, identity, navigation and prose survive JavaScript and backend outages             | `browser-tests/run.mjs` (`javaScriptEnabled: false`)                                       |
| The browser makes no settings/content API request                                          | `browser-tests/run.mjs`                                                                    |
| No project content in the framework repository                                             | `tests/contracts/repository-boundary.test.ts`                                              |
| Themes swap without changing data or features                                              | `tests/contracts/themes.test.ts`                                                           |
| Disabled components leave no route, nav, initializer, module, asset, projection or request | `tests/components/matrix.test.ts`, `src/verify/verify.ts`                                  |
| Enabled auth has a real callback route; disabled auth has none                             | `tests/components/auth.test.ts`                                                            |
| Callback referrer, no-store, no third-party resources, scrubbing, log redaction            | `tests/components/auth.test.ts`, `browser-tests/run.mjs`, `host-policy.json`               |
| STAC uses only the closed generated adapter; no upstream fetch or runtime config           | `tests/components/stac-adapter.test.ts`, `tests/artifact/build.test.ts` (network-denied)   |
| STAC pins hash routing and derives route/base settings                                     | `tests/components/stac-adapter.test.ts`, `browser-tests/run.mjs`                           |
| Landing search uses the typed, URL-stable `SearchIntentV1`                                 | `tests/components/search-intent.test.ts`, `browser-tests/run.mjs`                          |
| Config/content errors fail CI with source locations                                        | `tests/contracts/*.test.ts`, `tests/rendering/*.test.ts`                                   |
| Dated announcements use the recorded `effectiveAt`                                         | `tests/contracts/announcements.test.ts`, `browser-tests/run.mjs`                           |
| Markdown and RST match the published profile                                               | `tests/rendering/markdown.test.ts`, `tests/rendering/rst.test.ts`                          |
| Internal links, assets and fragments are validated                                         | `tests/rendering/markdown.test.ts`                                                         |
| Fragments own no route; every SVG surface emits a sanitized derivative                     | `tests/rendering/fragments.test.ts`, `tests/security/svg-surfaces.test.ts`                 |
| Raw active content and path escapes fail                                                   | `tests/security/sanitizer.test.ts`, `tests/contracts/containment.test.ts`                  |
| Output/temp/backup disjoint from every input before a write                                | `tests/contracts/containment.test.ts`                                                      |
| Only `static-docs-v1` artifacts contribute active same-origin files                        | `tests/contracts/subsites.test.ts`                                                         |
| Exact pins; identical repeat builds                                                        | `tests/artifact/build.test.ts` (two clean builds compared byte for byte)                   |
| Fictional consumers build through the same schemas, with no consumer JavaScript            | `examples/`, CI "Build the fictional consumers", `tests/packaging/pack-and-install.mjs`    |
| The artifact records the complete input graph and every identity                           | `tests/artifact/build.test.ts`, `tests/artifact/provenance.test.ts`                        |
| No caller-specific absolute or temporary paths in manifests                                | `tests/artifact/build.test.ts`, `src/verify/verify.ts`                                     |
| Builder image identity includes its resolved platform                                      | `tests/artifact/provenance.test.ts`                                                        |
| Environment artifacts differ when public inputs differ                                     | `tests/artifact/provenance.test.ts`                                                        |
| PR previews are separate builds with their assigned URL                                    | `tests/artifact/provenance.test.ts`                                                        |
| Every production host passes the published conformance check                               | `src/verify/host-check.ts`, `tests/artifact/host-check.test.ts`                            |

## Version 1.5 review findings

| Finding                                  | Where                                                                                                                         |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| AR-001 output can contain an input       | `src/config/paths.ts` `assertDisjointTrees`, checked before any creation                                                      |
| AR-002 RST lines can be absent           | `src/rendering/location.ts`, `tools/portal-rst-renderer/src/freva_portal_rst/render.py`, `tests/rendering/provenance.test.ts` |
| AR-003 subsite producer data             | exact output-tree and policy digests in `src/model/subsites.ts`; no attestation sidecar invented                              |
| AR-004 callback values can leak          | `client/components/auth-callback.ts`, `host-policy.json`, `tests/components/auth.test.ts`                                     |
| AR-005 bare `www.` can become HTTP       | `src/rendering/content.ts` `resolveLink`, `tests/rendering/markdown.test.ts`                                                  |
| AR-006 STAC history/base implicit        | `src/components/stac-browser/adapter.ts` `derivePathPrefix`                                                                   |
| AR-007 preview URL vs artifact identity  | `tests/artifact/provenance.test.ts`; `preview` states its own limits                                                          |
| AR-008 empty subsite connect origins     | `schema/subsite-policy.schema.json`, `src/artifact/manifests.ts` CSP                                                          |
| AR-009 SVG coverage                      | `src/rendering/svg.ts` is the only entry point; `tests/security/svg-surfaces.test.ts`                                         |
| AR-010 landing search handoff            | `@freva-org/databrowser/intent`, `tests/components/search-intent.test.ts`                                                     |
| AR-011 OCI index ambiguity               | `schema/material-reference.schema.json`, `--builder-image`                                                                    |
| AR-012 direct prose as a page            | `src/rendering/content.ts` `discoverPages`, `tests/rendering/fragments.test.ts`                                               |
| AR-013 migration plan ends support early | `packages/portal/MAINTENANCE.md`                                                                                              |

## Version 1.5 correction findings

The second review's findings, and what settles each one now.

| Finding                                                      | Implementation                                                                                                                                                                   | Tests                                                                           |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **B1** build-layer source was untracked                      | `src/artifact/**` (renamed from the directory an unanchored ignore rule had hidden), anchored ignores in the root `.gitignore`, `scripts/source-closure.mjs`                     | `npm run closure`, the `closure` gate                                           |
| **B2** version, lockfile, script and export coherence        | `package.json` at `0.0.0` with a `major` changeset, `typecheck` covering library/tests/client/Astro, `src/types/client-env.d.ts`                                                 | `npm run typecheck`, the `compile` gate                                         |
| **B3** conformance evidence was not executable               | `scripts/acceptance.mjs` at the repository root, `reports/fp001-acceptance.json`                                                                                                 | the report itself                                                               |
| **C1** pre-write transitive input/output disjointness        | `src/model/resolve.ts` `collectDeclaredInputs`, `src/config/paths.ts` `assertDisjointTrees`                                                                                      | `tests/contracts/disjointness.test.ts`                                          |
| **C2** parsed, containment-checked subsite inventory         | `src/model/subsite-inventory.ts` (parse5 and postcss), `src/model/subsites.ts`                                                                                                   | `tests/contracts/subsite-inventory.test.ts`, `tests/contracts/subsites.test.ts` |
| **C3** raw/decoded normalization, symmetric collisions       | `src/config/paths.ts` `assertSafeSitePath`/`collisionKey`, `src/routes/derive.ts`                                                                                                | `tests/contracts/site-paths.test.ts`                                            |
| **C4** Markdown/RST profile and helper lifecycle             | `src/rendering/location.ts`, `src/rendering/lower.ts`, `src/rendering/rst/client.ts`, `schema/portal-content-v1.profile.json`                                                    | `tests/rendering/profile-parity.test.ts`, `tests/rendering/provenance.test.ts`  |
| **C5** release timestamp and canonical-image reproducibility | `src/artifact/archive.ts`, the `archive` command, `container/portal-builder/Dockerfile`, `container/portal-builder/build.sh`, `container/portal-builder/resolve-base-digests.sh` | `tests/artifact/reproducibility.test.ts`, the `reproducibility` gate            |
| **C6** STAC materials and adapter hardening                  | `schema/stac-materials.schema.json`, `src/components/stac-browser/materials.ts`, `packages/stac-browser/adapter-contract.json`                                                   | `tests/components/stac-materials.test.ts`, `tests/fixtures/stac-adapter/*.json` |
| **C7** structured artifact verification                      | `src/verify/identity.ts` (role table by JSON Pointer), `src/verify/verify.ts`                                                                                                    | `tests/artifact/manifest-identity.test.ts`, the `verification` gate             |
| **Section 5** external-consumer playground                   | `src/cli/smoke.ts`, `docs/external-consumer-playground.md`                                                                                                                       | the `pilot` gate                                                                |

## Final review findings (R1-R7)

| Finding                                                  | Implementation                                                                                                                                                                 | Tests                                                                                                                          |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| **R1** one raw-path contract, applied before any parser  | `src/config/raw-path.ts`, used by `src/config/paths.ts`, `src/model/urls.ts`, `src/verify/identity.ts`, `src/model/subsite-inventory.ts`                                       | `tests/contracts/raw-path.test.ts`                                                                                             |
| **R2** `static-docs-v1` implements its own schema        | `src/model/subsite-inventory.ts` reference classes, `src/model/subsites.ts` origin checks, `src/artifact/manifests.ts` frame/worker directives                                 | `tests/contracts/subsite-policy.test.ts`, `browser-tests/run.mjs`                                                              |
| **R3.1** bare `www.` decided from source provenance      | `src/rendering/markdown/parse.ts` `isBareWwwAutolink`                                                                                                                          | `tests/rendering/markdown.test.ts`, `tests/rendering/profile-parity.test.ts`                                                   |
| **R3.2** the RST helper is poisoned on a broken protocol | `src/rendering/rst/client.ts` `poison`, injectable timeout and candidates                                                                                                      | `tests/rendering/rst-lifecycle.test.ts`                                                                                        |
| **R3.3** RST table titles survive as `<caption>`         | `tools/portal-rst-renderer/src/freva_portal_rst/render.py`, `src/rendering/ir.ts`, `src/rendering/lower.ts`, `schema/portal-content-v1.profile.json`                           | `tests/rendering/profile-parity.test.ts`                                                                                       |
| **R3.4** machine-checked profile coverage                | the profile is the index; the suites read it rather than restating it                                                                                                          | `tests/rendering/ir-coverage.test.ts`, `tests/rendering/profile-parity.test.ts`                                                |
| **R4** the playground is truthful and distributable      | `src/cli/smoke.ts`, `docs/external-consumer-playground.md`, `package.json` `files`                                                                                             | `tests/packaging/pack-and-install.mjs`                                                                                         |
| **R5** release acceptance fails closed                   | `scripts/acceptance.mjs` required-gate set, real `npm ci`, two clean extractions, container gate                                                                               | the acceptance report itself                                                                                                   |
| **R6** the STAC chain is verified end to end             | `packages/stac-browser/scripts/dist-record.mjs`, `packages/stac-browser/scripts/build.mjs`, `packages/stac-browser/scripts/prepare-materials.mjs`, `client/components/stac.ts` | `packages/stac-browser/tests/upstream-pin.test.mjs`, `tests/components/stac-adapter-contract.test.ts`, `browser-tests/run.mjs` |
| **R7** the delivery contract is stated exactly           | `delivery/apply-correction.sh`, `delivery/baseline-cleanup.json`                                                                                                               | the delivery report                                                                                                            |
