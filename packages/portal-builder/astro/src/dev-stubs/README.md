# Check-only stubs

`astro check` needs the `virtual:portal-*` specifiers to resolve to _something_
with the right shape. A real build never sees these files: it passes an inline
configuration with `configFile: false` and maps the same specifiers onto the
modules that build actually generated.

Their only job is to let the page templates be type-checked.
