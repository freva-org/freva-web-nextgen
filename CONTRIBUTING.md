# Contributing

Thanks for your interest in contributing to freva-web-nextgen.

## Setup

```bash
git clone https://github.com/freva-org/freva-web-nextgen
cd freva-web-nextgen
npm install
```

Node 22 or 24 (see `packages/ts-oidc-auth-client/.nvmrc`).

## Development workflow

```bash
cd packages/data-inspector
npm run dev
npm test
npm run typecheck
```

## Before committing

The pre-commit hook runs ESLint + Prettier automatically on staged files. To run manually:

```bash
npm run lint
npm run lint:fix
npm run format
```

## Making a change

1. Branch from `main`: `git checkout -b feat/my-change`
2. Make your changes and add/update tests (`npm test` must pass).
3. Add a changeset describing what changed:
   ```bash
   npx changeset
   ```
4. Push and open a pull request against `main`.

## Versioning

Packages use CalVer: `YYMM.MINOR.PATCH`.

- `YYMM` - the year and month of the release epoch, e.g. `2608` for August 2026.
- `MINOR` - additive, backwards-compatible changes within that epoch.
- `PATCH` - fixes within that epoch.

Changesets drives the bumps, so pick the level by the same rule you would for SemVer:
`patch` -> `PATCH`, `minor` -> `MINOR`, `major` -> a new `YYMM`. Rolling to a new epoch is a
deliberate maintainer step: set the new `YYMM.0.0` in the package's `package.json` rather
than letting a `major` changeset invent a number.

## Releasing (maintainers only)

Merging a PR never publishes. Publishing is the act of merging the release PR:

1. A PR lands carrying a changeset. CI opens or refreshes **"chore: version packages"**.
2. Merging that PR consumes the changesets and applies the new versions.
3. Only then does CI publish, package by package, in dependency order.

`scripts/publish-packages.mjs` decides the order. A package waits until every workspace package it
needs is resolvable on npm at the version it pins - including versions pinned in an `esm.sh` URL in
the source, which package.json never sees. Versions already on the registry are skipped, so a
re-run finishes a partial release instead of failing.

Bumping a version by hand is refused by CI: it would publish on the next push to main without ever
going through the release PR.

## Package structure

```
packages/
  data-inspector/        # @freva-org/data-inspector
  databrowser/           # @freva-org/databrowser
  ts-oidc-auth-client/   # @freva-org/ts-oidc-auth-client
  your-new-package/      # add future packages here
```

Each package is independently versioned and published.

## Extra release gates (`ts-oidc-auth-client`)

The auth client carries release gates beyond the shared `lint / typecheck / test / build`
pipeline. They run in CI and are wired into its `prepublishOnly`:

```bash
cd packages/ts-oidc-auth-client

npm run check:bytes          # no NUL/control bytes in anything shipped or reviewed
npm run check:mutations      # every security control must break a named test when removed
npm run manifest:refresh     # re-pin tests/src-manifest.json after an intentional src/ change
npm run browsers:install     # Playwright engines for the local matrix
npm run test:browser         # real-browser regression suites
npm run test:browser:strict  # release gate: Chromium + Firefox + WebKit, all three
```

`test:browser:strict` refuses to run on macOS rather than report a two-engine pass. Run it
on Linux CI, or locally via the Playwright Docker image printed by the refusal message.

If you edit a security control in `src/`, keep its `// MUTATION ANCHOR:` comment intact -
`scripts/mutation-check.mjs` matches those lines literally to locate what it mutates.
