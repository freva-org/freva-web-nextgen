---
"@freva-org/browser-python": patch
"@freva-org/data-inspector": patch
"@freva-org/portal-builder": minor
---

Security updates: `browser-python` depends on DOMPurify 3.4.17. `data-inspector` builds with Vite 8. `portal-builder`'s `host-check` now verifies the deployed Content-Security-Policy (`FP1607`); a host that cannot send headers, such as GitHub Pages, needs the new `--allow-missing-csp`.
