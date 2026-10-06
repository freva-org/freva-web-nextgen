# Centre B (customisation fixture)

A fictional portal that exercises the customisation surface: a split header with side
navigation, local WOFF2 fonts (Poppins, subset, SIL Open Font License 1.1 - the licence notice
is in the fonts' own name table) with a larger type scale, a minimal footer whose funding notice
and address come from `portal-template-v1` slot templates, and a landing whose blocks are in a
different order and at different widths. See `docs/customisation.md`.

```console
freva-portal-builder build --source-root . --config portal.yaml --out ../../build/centre-b
```
