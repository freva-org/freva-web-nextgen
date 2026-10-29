# Security policy

## Reporting a vulnerability

Please report security issues **privately**, not in a public issue or pull request.

Use GitHub's private vulnerability reporting: open the repository's **Security** tab and choose
**Report a vulnerability**. The report is visible only to the maintainers, and the fix can be
prepared in a private advisory before anything is published.

A useful report says:

- which package and version is affected (for example `@freva-org/browser-python@2610.1.0`), or
  which commit, if it is unreleased;
- what an attacker can do, and what they need first (a crafted notebook, a malicious STAC
  catalogue, a logged-in user, ...);
- how to reproduce it, ideally with the smallest example you have.

Maintainers will acknowledge the report, keep you updated in the advisory, and credit you in it
unless you prefer otherwise.

## Supported versions

Fixes are released as new versions of the affected packages. Only the most recent release of each
`@freva-org/*` package receives security fixes; please upgrade before reporting an issue in an
older one.

## Out of scope here

- **STAC Browser itself.** This repository builds a pinned upstream release
  ([radiantearth/stac-browser](https://github.com/radiantearth/stac-browser)); report issues in
  its code upstream. Issues in how Freva builds, patches or embeds it belong here.
- **A specific Freva deployment.** Report problems with an instance you use to the organisation
  that operates it.

## How this repository checks itself

Every pull request and every push to `main` runs, in the `CI` workflow that releases depend on:
an `npm audit` of the workspace lockfile (high and above fails), dependency review of new
dependencies, CodeQL for JavaScript/TypeScript, Python and the workflows, gitleaks over the new
commits, zizmor over the workflow files, and a scan of the canonical container image once its
base images are pinned. The pinned STAC Browser lockfile is audited and reported, but cannot be
changed here.
