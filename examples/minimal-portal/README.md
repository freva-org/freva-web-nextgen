# Minimal fictional consumer

A fictional site used by the framework's own tests. It contains no real project's
content, branding, endpoints or deployment settings, which is the point: the
framework repository holds fixtures, and every real consumer keeps its inputs in
the repository that owns the site.

```console
freva-portal-builder validate --source-root . --config portal.yaml
freva-portal-builder build    --source-root . --config portal.yaml --out ../../build/minimal
freva-portal-builder verify   --dir ../../build/minimal
freva-portal-builder preview  --dir ../../build/minimal
```
