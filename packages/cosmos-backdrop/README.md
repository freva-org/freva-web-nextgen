# @freva-org/cosmos-backdrop

The Cosmos backdrop: a still cross-section of an observing system - orbit, atmosphere, coast,
ocean - drawn behind a landing page and redrawn when the page's theme changes. It is what the
Waterpark landing page and the Freva portals' `cosmos` theme draw.

Framework-free and inert until asked: `mountCosmosBackdrop()` does nothing on a page without a
`.portal-cosmos` element, and fetches the scene kernel (about 100 KB) only when it finds one.

```html
<link rel="stylesheet" href="…/@freva-org/cosmos-backdrop/styles.css" />
<div class="portal-shell" data-backdrop="cosmos">
  <div class="portal-cosmos" data-portal-cosmos-assets="assets/cosmos/"></div>
  <!-- the landing -->
</div>
```

```js
import { mountCosmosBackdrop } from "@freva-org/cosmos-backdrop";
const stop = mountCosmosBackdrop(); // returns a disposer
```

- The scene follows `<html data-theme="dark|light">`: night sky or day sky, rebuilt one frame after
  the page has switched.
- `data-portal-cosmos-assets` is the directory the sky art is served under: the scene requests
  `<assets>sky/<file>`. Copy the files exported as `@freva-org/cosmos-backdrop/sky/*`
  (`MANIFEST.json`, `moon.webp`, `sky-sphere.webp`, `sun.webp`) into its `sky/` subdirectory.
- `styles.css` styles the scene's own elements. Where the scene sits - the shell, the landing's
  translucent cards, the hero veil - is the host theme's business.
- There is no animation: the scene is built once into canvases, SVG and images, so there is no
  frame loop and nothing for reduced-motion to stop.

`npm run export-art` regenerates the sky art from `src/cosmos/art/sky-art.mjs` (needs Playwright).
