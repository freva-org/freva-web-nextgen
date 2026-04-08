# Contributing

Thanks for your interest in contributing to freva-web-nextgen.

## Setup

```bash
git clone https://github.com/freva-org/freva-web-nextgen
cd freva-web-nextgen
npm install        # installs all workspace deps + sets up husky
```

## Development workflow

```bash
cd packages/data-inspector
npm run dev        # Vite dev server
npm test           # Vitest (watch mode: npm run test:watch)
npm run typecheck  # tsc --noEmit
```

## Before committing

The pre-commit hook runs ESLint + Prettier automatically on staged files. To run manually:

```bash
npm run lint        # check
npm run lint:fix    # auto-fix
npm run format      # format all files
```

## Making a change

1. Branch from `main`: `git checkout -b feat/my-change`
2. Make your changes and add/update tests — `npm test` must pass.
3. Add a changeset describing what changed:
   ```bash
   npx changeset
   ```
4. Push and open a pull request against `main`.

## Releasing (maintainers only)

Releases are handled by Changesets via CI. Merge the auto-created "Version Packages" PR to publish to npm.

## Package structure

```
packages/
  data-inspector/      # @freva/data-inspector
  your-new-package/    # add future packages here
```

Each package is independently versioned and published.
