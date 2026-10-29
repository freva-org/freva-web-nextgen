---
"@freva-org/browser-python": patch
"@freva-org/data-inspector": patch
"@freva-org/portal-builder": patch
---

Security updates: `browser-python` depends on DOMPurify 3.4.17. `data-inspector` builds with Vite 8. `portal-builder` requires Node 22.23.4 or later on the 22 line, and `host-check` now verifies the deployed Content-Security-Policy.
