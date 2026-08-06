# Freva-web-nextgen

Freva-web-nextgen, framework-agnostic Web Components and utilities.

## Packages

| Package                                                            | Version                                                                                                                             | Description                                                    |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| [`@freva-org/data-inspector`](./packages/data-inspector)           | [![npm](https://img.shields.io/npm/v/@freva-org/data-inspector)](https://www.npmjs.com/package/@freva-org/data-inspector)           | NetCDF / Zarr inspection dialog Web Component                  |
| [`@freva-org/databrowser`](./packages/databrowser)                 | [![npm](https://img.shields.io/npm/v/@freva-org/databrowser)](https://www.npmjs.com/package/@freva-org/databrowser)                 | Climate-data browser for the freva-nextgen REST API            |
| [`@freva-org/ts-oidc-auth-client`](./packages/ts-oidc-auth-client) | [![npm](https://img.shields.io/npm/v/@freva-org/ts-oidc-auth-client)](https://www.npmjs.com/package/@freva-org/ts-oidc-auth-client) | OIDC browser auth client for py-oidc-auth / freva-rest servers |

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
cd packages/<name-of-package> && npm run dev
```

Node 22 or 24 is required (`packages/ts-oidc-auth-client` sets the floor).

## Contributing

1. Fork the repo and create a branch from `main`.
2. Make your changes inside the relevant `packages/*` directory.
3. Add or update tests (`npm test` must pass.)
4. Open a pull request.

## License

[BSD 3-Clause](./LICENSE)
