# @freva-org/ts-oidc-auth-client

## 2608.0.2

### Patch Changes

- 3577e8a: Code scanning fixes. `databrowser` no longer breaks on a link or query whose facet key is an `Object.prototype` name (`__proto__`, `constructor`, `toString`, ...). Trailing slashes, newlines and spaces are trimmed in linear time instead of with backtracking regular expressions.
- a4570b3: File checks and the reads or writes they guard go through one descriptor or one exclusive create, so they see the same file. The playground frame only loads an http(s) origin, and the worker ignores messages from a foreign origin. A callback spends its login transaction once, before reading the response. Copied ClimateClaw replies strip tags and comments until none are left.

## 2608.0.1

### Patch Changes

- a89f225: security.expectedIssuer accepts an http issuer on a loopback host, the same transport rule as every other configured URL
