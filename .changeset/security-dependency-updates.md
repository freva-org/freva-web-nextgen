---
"@freva-org/browser-python": patch
"@freva-org/data-inspector": patch
"@freva-org/portal-builder": patch
---

Security dependency updates. `browser-python` now depends on DOMPurify 3.4.17, which fixes GHSA-cg2g-xh64-v4q7, GHSA-mrv2-3pqr-j5jr and GHSA-c6gr-qvv4-5v3f. `data-inspector` is now built with Vite 8 and vite-plugin-dts 5; it ships the same files, and its type declarations are unchanged. `portal-builder` now requires Node 22.23.4 or later on the 22 line: Astro 7.4, which it builds with, refuses older versions, and 22.23.4 is the first 22.x release with the October 2026 Node.js security fixes. `portal-builder`'s `host-check` now also checks the deployed Content-Security-Policy: it reports an error when the root document is served without the policy `host-policy.json` records, with it only as `Content-Security-Policy-Report-Only`, or with any directive weakened or dropped, and a warning when the host is stricter. A host that sends no headers at all, such as GitHub Pages, now fails `host-check` on this point.
