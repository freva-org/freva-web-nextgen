# Changesets

This directory is managed by [Changesets](https://github.com/changesets/changesets).

## Releasing a new version

1. After merging a feature/fix, run:

   ```bash
   npx changeset
   ```

   Select the package(s) affected, the bump type (`patch` / `minor` / `major`), and write a short summary.

2. Commit the generated `.md` file alongside your code.

3. When you're ready to release, run:
   ```bash
   npx changeset version   # bumps package.json versions + writes CHANGELOG
   git commit -am "chore: version packages"
   npx changeset publish   # publishes to npm and pushes git tags
   ```

The CI `publish.yml` workflow handles step 3 automatically when a PR titled "Version Packages" is merged.
