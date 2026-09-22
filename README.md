# Freva-web-nextgen

Freva-web-nextgen, framework-agnostic Web Components and utilities.

## Packages

| Package                                                                | Version                                                                                                                                 | Description                                                               |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| [`@freva-org/browser-python`](./packages/browser-python)               | [![npm](https://img.shields.io/npm/v/@freva-org/browser-python)](https://www.npmjs.com/package/@freva-org/browser-python)               | Pyodide in a Web Worker, with a REPL and inline Matplotlib                |
| [`@freva-org/data-inspector`](./packages/data-inspector)               | [![npm](https://img.shields.io/npm/v/@freva-org/data-inspector)](https://www.npmjs.com/package/@freva-org/data-inspector)               | NetCDF / Zarr inspection dialog Web Component                             |
| [`@freva-org/databrowser`](./packages/databrowser)                     | [![npm](https://img.shields.io/npm/v/@freva-org/databrowser)](https://www.npmjs.com/package/@freva-org/databrowser)                     | Climate-data browser for the freva-nextgen REST API                       |
| [`@freva-org/dataset-tree`](./packages/dataset-tree)                   | [![npm](https://img.shields.io/npm/v/@freva-org/dataset-tree)](https://www.npmjs.com/package/@freva-org/dataset-tree)                   | Hierarchical browser for climate-data archives                            |
| [`@freva-org/freva-badge`](./packages/freva-badge)                     | [![npm](https://img.shields.io/npm/v/@freva-org/freva-badge)](https://www.npmjs.com/package/@freva-org/freva-badge)                     | The Freva footer badge: a mark that opens an About panel                  |
| [`@freva-org/stac-browser`](./packages/stac-browser)                   | [`ae1956e`](https://github.com/radiantearth/stac-browser/tree/ae1956e8cb2067ce27938b3ae70c00515ac0ff33)                                 | Recipe that builds Radiant Earth's STAC Browser into embeddable materials |
| [`@freva-org/freva-client-terminal`](./packages/freva-client-terminal) | [![npm](https://img.shields.io/npm/v/@freva-org/freva-client-terminal)](https://www.npmjs.com/package/@freva-org/freva-client-terminal) | Reusable terminal window for freva-client commands                        |
| [`@freva-org/ts-oidc-auth-client`](./packages/ts-oidc-auth-client)     | [![npm](https://img.shields.io/npm/v/@freva-org/ts-oidc-auth-client)](https://www.npmjs.com/package/@freva-org/ts-oidc-auth-client)     | OIDC browser auth client for py-oidc-auth / freva-rest servers            |

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
