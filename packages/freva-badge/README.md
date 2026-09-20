# `@freva-org/freva-badge`

The Freva footer badge, vendored as its optimized runtime. A static mark that
opens a panel, with a bird that flies in, lands on the mark and walks along its
rim.

This package is **the badge's implementation**. Nothing outside it draws the
badge, animates it, or styles it. A host mounts it and tells it where its assets
live; everything else - the markup, the motion, the copy, the CSS - is here.

```
dist/
  freva-badge.js           the runtime; hand maintained, no build step
  freva-badge-content.js   copy, links, organisations; no logic
  freva-badge.css          all of the badge's styling, scoped under `.fb`
  assets/                  mark, story sheet, motion chunks and manifests
```

## Mounting

```js
window.FrevaBadgeOptions = { assetBase: "/site/_badge/assets/" };
// then load freva-badge-content.js, then freva-badge.js
FrevaBadge.mount(element);
```

| Option      | Meaning                                                                     |
| ----------- | --------------------------------------------------------------------------- |
| `assetBase` | Where `assets/` was published. Must end in `/`.                             |
| `quality`   | `"auto"` (default) picks 1x or 2x by display density; `"standard"` pins 1x. |
