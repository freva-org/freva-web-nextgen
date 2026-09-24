// Photographing the Cosmos scene on its own, and sampling the result.
//
// Two kinds of check need this: what the SKY looks like behind the star field, and what the
// BRIGHTEST thing under a prose block is. The scene is retained DOM - layered gradients, baked
// sprites and SVG - so there is no single surface to read, and the page's own chrome and copy are
// painted over it. So the scene is photographed with everything that is not the scene made
// invisible, and the photograph is sampled. Shared by `cosmos-layout.mjs` and `cosmos-visual.mjs`,
// which ask the same question of the same drawing.

// `visibility: hidden` rather than `display: none`: it takes the ink away without changing a
// single box, so the block rectangles measured against the shot are the ones a reader has.
const HIDE_NON_SCENE = `.portal-header,.portal-footer,.portal-announcements,.portal-landing,
  .portal-overlay-root,#portal-overlay-root{visibility:hidden!important}`;

/** Photograph the viewport with the scene alone in it, as a data URL. */
export async function sceneShot(page, viewport) {
  const handle = await page.addStyleTag({ content: HIDE_NON_SCENE });
  // One frame for the style to take effect before the shot is taken.
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => done(undefined))));
  const png = await page.screenshot({
    clip: { x: 0, y: 0, width: viewport.width, height: viewport.height },
  });
  await handle.evaluate((node) => node.remove());
  return `data:image/png;base64,${png.toString("base64")}`;
}

/**
 * Decode a shot IN THE PAGE and reduce horizontal strips to their darkest or brightest pixel.
 *
 * Darkest, for the sky: stars, meteors and the Milky Way only ever ADD light, so the darkest pixel
 * across a strip is the gradient under them. Brightest, for legibility: the worst ground a piece of
 * body text can be asked to sit on is the lightest pixel behind it. Passed to `page.evaluate`
 * rather than called here - the decoding needs a browser.
 */
export const SAMPLE_PIXELS = async ([data, rows, mode]) => {
  const img = new Image();
  await new Promise((done, fail) => {
    img.onload = done;
    img.onerror = fail;
    img.src = data;
  });
  const cv = document.createElement("canvas");
  cv.width = img.naturalWidth;
  cv.height = img.naturalHeight;
  const ctx = cv.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const scale = cv.width / window.innerWidth;
  const luminance = (rgb) => {
    const [r, g, b] = rgb.map((c) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  return rows.map(({ x, y, w }) => {
    const d = ctx.getImageData(
      Math.max(0, Math.round(x * scale)),
      Math.max(0, Math.min(cv.height - 1, Math.round(y * scale))),
      Math.max(1, Math.round(w * scale)),
      1,
    ).data;
    let px = null;
    for (let i = 0; i < d.length; i += 4) {
      const p = [d[i], d[i + 1], d[i + 2]];
      if (px === null) px = p;
      else if (mode === "dark" ? luminance(p) < luminance(px) : luminance(p) > luminance(px)) {
        px = p;
      }
    }
    return px ?? [0, 0, 0];
  });
};
