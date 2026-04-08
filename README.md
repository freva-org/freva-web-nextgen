# freva-web-nextgen

Monorepo for the Freva web frontend — framework-agnostic Web Components and utilities built with TypeScript and Vite.

## Packages

| Package                                              | Version                                                                                                           | Description                                   |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| [`@freva/data-inspector`](./packages/data-inspector) | [![npm](https://img.shields.io/npm/v/@freva/data-inspector)](https://www.npmjs.com/package/@freva/data-inspector) | NetCDF / Zarr inspection dialog Web Component |

## Getting started

```bash
# Install dependencies (all workspaces)
npm install

# Build all packages
npm run build

# Run tests across all packages
npm test

# Type-check all packages
npm run typecheck

# Dev server (single package)
cd packages/data-inspector && npm run dev
```

## Repository structure

```
packages/
  data-inspector/   # @freva/data-inspector
  # future packages go here
```

Each package is independently versioned and published to npm.

## Contributing

1. Fork the repo and create a branch from `main`.
2. Make your changes inside the relevant `packages/*` directory.
3. Add or update tests — `npm test` must pass.
4. Open a pull request.

## License

[BSD 3-Clause](./LICENSE)
