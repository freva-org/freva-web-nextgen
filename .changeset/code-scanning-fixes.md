---
"@freva-org/databrowser": patch
"@freva-org/jupyterlite-climateclaw": patch
"@freva-org/data-inspector": patch
"@freva-org/ts-oidc-auth-client": patch
"@freva-org/jupyterlite-freva-data": patch
"@freva-org/portal-builder": patch
---

Code scanning fixes. `databrowser` no longer breaks on a link or query whose facet key is an `Object.prototype` name (`__proto__`, `constructor`, `toString`, ...). Trailing slashes, newlines and spaces are trimmed in linear time instead of with backtracking regular expressions.
