# Full fictional consumer

A fictional site that exercises every part of the FP-001 v1 contract. It contains
no real project's content, branding, endpoints or deployment settings.

```console
freva-portal-builder validate --source-root . --config portal.yaml --effective-at 2026-01-07T12:00:00Z
freva-portal-builder build    --source-root . --config portal.yaml --out ../../build/full --effective-at 2026-01-07T12:00:00Z
freva-portal-builder verify   --dir ../../build/full
```

The site's canonical URL has a non-root path (`/site/`), so the artifact also
demonstrates that the document root is mounted at that path exactly once.
