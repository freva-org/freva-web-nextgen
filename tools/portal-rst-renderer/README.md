# `freva-portal-rst`

The reStructuredText helper the portal builder shells out to.

The builder never renders RST itself and never installs Python during a build.
It starts this helper, exchanges a handshake, and refuses to continue unless the
protocol, the package name, the helper version **and** the Docutils version all
match what the active content profile pins:

| Field      | `portal-content-v1` |
| ---------- | ------------------- |
| `protocol` | `1`                 |
| `package`  | `freva-portal-rst`  |
| `version`  | `1.0.0`             |
| `docutils` | `0.23`              |

The strictness is the point. A helper that is merely close produces HTML that
differs from the golden fixtures in ways nobody notices until a page looks wrong
in production, so a near-miss is reported as `FP1701` instead of being rendered.

## Installing it

Any one of these is enough; the builder looks for them in this order.

```bash
# 1. A pin, for a helper that lives somewhere unusual. A pin is exclusive: when
#    it is set nothing else is tried, so a typo is reported rather than quietly
#    replaced by a different helper.
export FREVA_PORTAL_RST=/opt/freva/bin/freva-portal-rst

# 2. On PATH - what the canonical builder image and CI both do.
pip install ./tools/portal-rst-renderer

# 3. A virtual environment inside this checkout. This is what the repository
#    bootstrap creates, and it is the right choice on a machine whose system
#    Python must not gain packages (macOS with Homebrew Python, for instance,
#    refuses a global install outright).
node scripts/bootstrap.mjs --rst

# 4. Nothing installed, but a python3 that already has docutils 0.23: the
#    checkout is run in place, through PYTHONPATH.
```

`node scripts/bootstrap.mjs --rst` is idempotent. It reuses a helper that is
already on `PATH`, otherwise creates `tools/portal-rst-renderer/.venv` (which is
git-ignored) and installs this package with its pinned Docutils into it. It
prints the handshake it ended up with, so a version mismatch is visible before
the test suite reports one.

## Checking it by hand

The protocol is one JSON object per line on stdin and stdout:

```bash
echo '{"op":"hello"}' | freva-portal-rst
{"protocol":"1","package":"freva-portal-rst","version":"1.0.0","docutils":"0.23"}
```

If that prints something else, the builder will refuse it, and the diagnostic
names the field that differed.

## Diagnostics you may see

- **`FP1701 No RST helper could be started`** - none of the four routes above
  found anything. The message lists every candidate that was tried.
- **`FP1701 ... handshake mismatch`** - a helper answered, but with the wrong
  version or the wrong Docutils. Delete `.venv` and bootstrap again, or check
  which `freva-portal-rst` is first on `PATH`.
