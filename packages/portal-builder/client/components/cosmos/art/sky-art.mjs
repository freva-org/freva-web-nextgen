/*
 * THE SKY'S ARTWORK, SEPARATED FROM ITS RENDERER. EXPORT-TIME ONLY.
 *
 * Nothing in the shipped portal imports this file. It is run once, in a browser, by
 * `scripts/export-cosmos-art.mjs`, which writes the images it draws into
 * `client/components/cosmos/scene/proto/` for the build to publish as ordinary assets. The page
 * then loads those files; it never draws them.
 *
 * That is the whole point of the prototype. `cosmos/scene.js` draws every procedural surface into a
 * canvas on load and encodes it with `toDataURL()` - 21 of the 32 images in the shipped scene are
 * `data:` URIs, produced again from scratch on every theme switch. Pre-generating them moves that
 * work out of the visitor's browser entirely and turns each one into a cacheable, decodable file
 * that the compositor can upload once.
 *
 * WHY THE CODE IS COPIED RATHER THAN IMPORTED. `scene.js` keeps these drawings inside
 * `buildSky` and `buildLuminaries` as local closures over its own module state, and exposes
 * neither. Reaching into it would mean changing it - and the baseline this prototype is measured
 * against has to stay byte-identical to v007. So the three drawings the sky prototype needs are
 * lifted here verbatim, with their comments, and the originals are left alone. If the prototype is
 * accepted this file becomes the one copy and the originals go; if it is rejected, deleting this
 * directory and the two lines that reference it removes the prototype completely.
 *
 * WHAT IS DELIBERATELY DIFFERENT. `scene.js` flattens the star sphere, the scintillant stars and
 * the altitude mask into ONE image the size of the sky band, because it had stopped rotating. The
 * brief asks for the rotation back, so the sphere is exported as its own square disc - which is
 * exactly the `cv` canvas `buildSky` already draws before flattening it - and the altitude mask
 * comes back as a static gradient over it rather than as baked-in alpha. See `MASK_STOPS`.
 */

/** `scene.js`'s own xorshift, so a given seed draws the identical field. */
export function rngFrom(seed) {
  let s = seed >>> 0 || 1;
  return function () {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/**
 * The seed `scene.js` hands `buildSky`, and the draw order that follows it.
 *
 * Load-bearing, both of them. The stream is seeded and shared: the Milky Way's clumps, the general
 * field, the scintillant stars and the two meteors all pull from it in sequence, so a draw that is
 * added or skipped moves everything after it. The meteor draws are made here and thrown away for
 * exactly that reason - the prototype animates its comets in CSS, but the numbers still have to be
 * taken out of the stream in the same order or the star field is a different star field.
 */
export const SKY_SEED = 11311;

/**
 * The altitude mask, as gradient stops.
 *
 * `scene.js` paints these into the flattened sky with `destination-in`, removing alpha as the air
 * below thickens. A rotating disc cannot carry it - the mask is fixed to the page and the stars are
 * not - so it is applied the other way round here: a static overlay in the backdrop's own colour,
 * with alpha ramping from 0 to 1 over the same stops. Over a backdrop the stars are drawn straight
 * onto, painting the background over them at `1 - a` is the same result as removing `a` from them,
 * and it is an ordinary-alpha composite rather than a mask on a moving layer.
 */
export const MASK_STOPS = [
  [0, 0],
  [0.46, 0],
  [0.74, 0.38],
  [0.97, 1],
];

/* ====================================================================
   THE CELESTIAL SPHERE — `buildSky`'s `cv`, verbatim.
   ==================================================================== */

/**
 * Draw the star sphere into a square canvas of side `TW`.
 *
 * `R` is the sphere's radius in page pixels and `ts` the texture scale `scene.js` chooses, so the
 * disc is drawn at `TW = 2*R*ts` and displayed at `2*R` - the same upscale the shipped scene
 * already does when it calls `drawImage(cv, -R, -R, 2*R, 2*R)`.
 */
export function drawStarSphere(ctx, { R, ts, rng }) {
  const TW = Math.round(2 * R * ts);
  const Rt = R * ts;
  const cx = TW / 2;
  const cy = TW / 2;
  const c = ctx;
  const TINTS = [
    "255,247,235",
    "255,252,246",
    "244,248,255",
    "226,238,255",
    "255,238,222",
    "213,230,255",
  ];
  const dot = (x, y, s, o, tint) => {
    if (o > 0.5) {
      const g = c.createRadialGradient(x, y, 0, x, y, s * 3.0);
      g.addColorStop(0, `rgba(${tint},${o * 0.26})`);
      g.addColorStop(1, `rgba(${tint},0)`);
      c.fillStyle = g;
      c.beginPath();
      c.arc(x, y, s * 3.0, 0, 6.2832);
      c.fill();
    }
    const g2 = c.createRadialGradient(x, y, 0, x, y, s * 1.45);
    g2.addColorStop(0, `rgba(${tint},${o})`);
    g2.addColorStop(0.48, `rgba(${tint},${o * 0.6})`);
    g2.addColorStop(1, `rgba(${tint},0)`);
    c.fillStyle = g2;
    c.beginPath();
    c.arc(x, y, s * 1.45, 0, 6.2832);
    c.fill();
  };

  /* galactic band: a curved great circle with clumped star clouds and a
     warmer bulge, per the engine's `mw` construction */
  {
    const mx = cx - Rt * 0.24,
      my = cy + Rt * 0.06,
      MR = Rt * 0.72;
    const ang = (t) => -0.7 + 2.46 * t;
    for (let i = 0; i <= 190; i++) {
      const tt = i / 190,
        a = ang(tt),
        env = Math.pow(Math.sin(Math.PI * tt), 0.8);
      const px = mx + Math.cos(a) * MR,
        py = my + Math.sin(a) * MR;
      const wd = Rt * (0.034 + 0.056 * env);
      const g = c.createRadialGradient(px, py, 0, px, py, wd);
      const al = 0.0055 + 0.0095 * env;
      g.addColorStop(0, `rgba(206,220,246,${al})`);
      g.addColorStop(0.6, `rgba(176,196,236,${al * 0.4})`);
      g.addColorStop(1, "rgba(150,170,215,0)");
      c.fillStyle = g;
      c.beginPath();
      c.arc(px, py, wd, 0, 6.2832);
      c.fill();
      if (i % 3 === 0) {
        const dr = -wd * (0.22 + 0.12 * Math.sin(tt * 9));
        const dx = mx + Math.cos(a) * (MR + dr),
          dy = my + Math.sin(a) * (MR + dr);
        const dg = c.createRadialGradient(dx, dy, 0, dx, dy, wd * 0.3);
        dg.addColorStop(0, `rgba(1,2,6,${0.026 * env})`);
        dg.addColorStop(1, "rgba(1,2,6,0)");
        c.fillStyle = dg;
        c.beginPath();
        c.arc(dx, dy, wd * 0.3, 0, 6.2832);
        c.fill();
      }
    }
    const clumps = Array.from({ length: 26 }, () => ({
      t: rng(),
      sp: (rng() - 0.5) * 0.12,
      r: 0.02 + rng() * 0.05,
    }));
    for (let i = 0; i < 2600; i++) {
      const useC = rng() < 0.62,
        C = clumps[(rng() * clumps.length) | 0];
      const tt = useC ? clamp(C.t + (rng() - 0.5) * C.r * 2, 0, 1) : rng();
      const spread = useC
        ? C.sp + (rng() + rng() - 1) * 0.045
        : (rng() + rng() + rng() - 1.5) * 0.1;
      const core = 1 - Math.min(1, Math.abs(tt - 0.62) * 3.4);
      const a = ang(tt),
        rr = MR * (1 + spread);
      const warm = core * (0.4 + rng() * 0.6);
      const tint = warm > 0.55 ? "255,238,214" : "226,238,255";
      dot(
        mx + Math.cos(a) * rr,
        my + Math.sin(a) * rr,
        Math.max(0.42, (rng() * 1.25 + 0.18) * ts),
        (0.1 + rng() * 0.52) * 0.75,
        tint,
      );
    }
  }
  /* the general field: 1700 stars, few bright and many faint */
  for (let i = 0; i < 1700; i++) {
    const mag = Math.pow(rng(), 2.2);
    const rr = Math.sqrt(rng()) * Rt,
      a = rng() * 6.2832;
    dot(
      cx + Math.cos(a) * rr,
      cy + Math.sin(a) * rr,
      Math.max(0.42, (0.35 + mag * 1.9) * ts),
      0.16 + mag * 0.84,
      TINTS[(rng() * TINTS.length) | 0],
    );
  }

  /*
   * The scintillant 56, baked into the same disc and turning with it.
   *
   * `scene.js` draws these into the FLATTENED sky, after the sphere has been rotated to its frozen
   * phase, because nothing turned any more. They belong to the sphere - they are stars - so with
   * the rotation back they go into the disc, in the disc's own coordinates. They keep the frozen
   * brightness the shipped scene gives them, which is their overlay's value at t = 0; the
   * prototype does not reintroduce a twinkle system, as the brief asks.
   */
  const TWINKLE = 4;
  const TWK = [
    [0, 0.34],
    [0.38, 1],
    [0.6, 0.5],
    [1, 0.34],
  ];
  const twAt = (ph) => {
    ph = ((ph % 1) + 1) % 1;
    for (let i = 1; i < TWK.length; i++)
      if (ph <= TWK[i][0]) {
        const a = TWK[i - 1],
          b = TWK[i];
        return a[1] + (b[1] - a[1]) * ((ph - a[0]) / (b[0] - a[0] || 1));
      }
    return TWK[TWK.length - 1][1];
  };
  const groups = Array.from({ length: TWINKLE }, () => ({ pers: [], offs: [], stars: [] }));
  for (let i = 0; i < 56; i++) {
    const a = rng() * 6.2832,
      rr = R * Math.sqrt(rng()),
      s = 1.1 + rng() * 1.6;
    const per = 2.4 + rng() * 6.6,
      off = rng() * 9;
    const g = groups[clamp(Math.floor(((per - 2.4) / 6.6) * TWINKLE), 0, TWINKLE - 1)];
    g.pers.push(per);
    g.offs.push(off);
    g.stars.push({ x: R + Math.cos(a) * rr, y: R + Math.sin(a) * rr, s: s });
  }
  const mean = (v) => v.reduce((x, y) => x + y, 0) / Math.max(1, v.length);
  for (const g of groups) {
    if (!g.stars.length) continue;
    c.globalAlpha = twAt(mean(g.offs) / mean(g.pers));
    for (const st of g.stars) {
      c.shadowColor = "rgba(206,226,255,0.7)";
      c.shadowBlur = st.s * 2;
      c.fillStyle = "#f4f8ff";
      c.beginPath();
      /* the disc's own frame: `scene.js` draws these at `st.x - R` inside a context translated to
         the pole, which is the same point as `st.x * ts` inside the texture. */
      c.arc(st.x * ts, st.y * ts, (st.s / 2) * Math.max(ts, 0.5), 0, 6.2832);
      c.fill();
      c.shadowBlur = 0;
      c.shadowColor = "rgba(0,0,0,0)";
    }
  }
  c.globalAlpha = 1;

  /*
   * The two meteor draws, made and discarded.
   *
   * They come after the star field in `scene.js`'s stream. The prototype's comets are CSS, so their
   * numbers are not used here - but the draws still have to happen, in this order, or every `rng()`
   * consumer downstream of them in a future export shifts. Six values, exactly as `buildSky` pulls
   * them.
   */
  for (let i = 0; i < 2; i++) {
    rng();
    rng();
    rng();
    rng();
  }
}

/* ====================================================================
   THE MOON — `buildMoon`'s baked disc, verbatim.
   ==================================================================== */

/** Draw the moon at radius `moonR`, centred in a canvas of side `moonR * 2.1`, origin centred. */
export function drawMoon(c, { moonR }) {
  const mR = moonR;
  const d = c.createRadialGradient(-mR * 0.32, -mR * 0.28, mR * 0.08, 0, 0, mR);
  d.addColorStop(0, "#f4f7fb");
  d.addColorStop(0.55, "#dfe6ee");
  d.addColorStop(0.88, "#b9c5d3");
  d.addColorStop(1, "#93a2b4");
  c.fillStyle = d;
  c.beginPath();
  c.arc(0, 0, mR, 0, 6.283);
  c.fill();
  c.save();
  c.beginPath();
  c.arc(0, 0, mR, 0, 6.283);
  c.clip();
  const craters = [
    [0.1, 0.3, 0.26, 0.16],
    [0.46, -0.12, 0.17, 0.12],
    [-0.1, -0.42, 0.13, 0.1],
    [0.62, 0.4, 0.12, 0.14],
    [0.28, 0.66, 0.1, 0.1],
    [-0.3, 0.16, 0.085, 0.13],
    [0.8, 0.02, 0.07, 0.11],
    [0.04, -0.02, 0.055, 0.09],
    [0.4, 0.2, 0.05, 0.08],
    [0.66, -0.44, 0.06, 0.09],
    [-0.02, 0.58, 0.045, 0.08],
    [0.52, 0.02, 0.035, 0.07],
  ];
  for (const [cx3, cy3, rr3, dep] of craters) {
    const px = cx3 * mR,
      py = cy3 * mR,
      pr = rr3 * mR;
    const g = c.createRadialGradient(px - pr * 0.3, py - pr * 0.3, pr * 0.05, px, py, pr);
    g.addColorStop(0, `rgba(120,134,152,${dep * 1.5})`);
    g.addColorStop(0.72, `rgba(138,150,166,${dep})`);
    g.addColorStop(1, "rgba(150,162,178,0)");
    c.fillStyle = g;
    c.beginPath();
    c.arc(px, py, pr, 0, 6.283);
    c.fill();
    c.strokeStyle = `rgba(255,255,255,${dep * 1.1})`;
    c.lineWidth = Math.max(0.6, pr * 0.07);
    c.beginPath();
    c.arc(px, py, pr * 0.94, Math.PI * 0.95, Math.PI * 1.85);
    c.stroke();
  }
  c.strokeStyle = "rgba(255,255,255,0.045)";
  c.lineWidth = mR * 0.025;
  for (let k = 0; k < 7; k++) {
    const a = k * 0.9 + 0.4;
    c.beginPath();
    c.moveTo(0.1 * mR, 0.3 * mR);
    c.lineTo(0.1 * mR + Math.cos(a) * mR * 1.1, 0.3 * mR + Math.sin(a) * mR * 1.1);
    c.stroke();
  }
  const limb = c.createRadialGradient(0, 0, mR * 0.55, 0, 0, mR);
  limb.addColorStop(0, "rgba(40,52,68,0)");
  limb.addColorStop(1, "rgba(40,52,68,0.28)");
  c.fillStyle = limb;
  c.beginPath();
  c.arc(0, 0, mR, 0, 6.283);
  c.fill();
  c.restore();
}

/* ====================================================================
   THE SUN — `buildLuminaries`'s photosphere, verbatim.
   ==================================================================== */

/** Draw the sun's photosphere at radius `sunR`, origin centred. */
export function drawSun(c, { sunR }) {
  const d = c.createRadialGradient(-sunR * 0.15, -sunR * 0.1, sunR * 0.1, 0, 0, sunR);
  d.addColorStop(0, "#fffdf6");
  d.addColorStop(0.62, "#fff3d4");
  d.addColorStop(0.92, "#ffd894");
  d.addColorStop(1, "rgba(255,196,120,0.75)");
  c.fillStyle = d;
  c.beginPath();
  c.arc(0, 0, sunR, 0, 6.283);
  c.fill();
  c.save();
  c.beginPath();
  c.arc(0, 0, sunR, 0, 6.283);
  c.clip();
  for (let i = 0; i < 26; i++) {
    const a = i * 1.7,
      rr = sunR * (0.25 + ((i * 37) % 70) / 100);
    const gx = Math.cos(a) * rr,
      gy = Math.sin(a) * rr;
    const gg = c.createRadialGradient(gx, gy, 0, gx, gy, sunR * 0.22);
    gg.addColorStop(0, "rgba(255,255,255,0.10)");
    gg.addColorStop(1, "rgba(255,255,255,0)");
    c.fillStyle = gg;
    c.beginPath();
    c.arc(gx, gy, sunR * 0.22, 0, 6.283);
    c.fill();
  }
  c.restore();
}
