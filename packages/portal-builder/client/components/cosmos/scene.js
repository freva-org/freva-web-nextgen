/* ====================================================================
   cosmos/scene.js - the Cosmos backdrop, drawn once and then composited.

   WHAT THIS IS. The portal's themed cross-section of an observing system:
   orbit, atmosphere, coast, ocean and seafloor, told down the length of a
   landing page. It replaces a renderer that redrew the whole picture into
   a canvas on every animation frame.

   WHAT IS UNCHANGED. The artwork. The three-band layout budget, the
   luminary radii and placements, the four satellite passes with their own
   speeds, phases, altitudes and instrument beams, the object size
   hierarchy, the ridged-noise terrain and its three glaciated ranges, the
   cloud-parcel construction gated by a humidity field, the instrument
   bodies, the berg facets, the float packing order and the wave
   wavenumbers are all the previous renderer's, ported rather than
   reinterpreted. `geometry()` below is its allocator, and on a real
   Waterpark landing it solves to the same pixel.

   WHAT CHANGED. Every procedural drawing is executed ONCE at build time
   into its own small canvas and thereafter only ever MOVED, by a CSS
   transform on the compositor. There is no requestAnimationFrame loop, no
   interval and no periodic timer; the only setTimeout in the feature is
   the island's resize debounce. Scrolling is native document flow and
   costs this module nothing at all.

   ANIMATED PROPERTIES. Every continuously running keyframe animates
   `transform` and `opacity` and nothing else. The theme cross-fade is a
   transition that runs once on a theme change, not an animation.

   CONTENT SECURITY POLICY. The portal serves `style-src 'self'` with no
   `'unsafe-inline'`, and this module is held to it rather than widening
   it. Three consequences, each measured against the real emitted policy
   rather than assumed:

     - a `<style>` ELEMENT created at run time is refused, even an empty
       one, so its `sheet` is null and `insertRule` throws. The generated
       keyframes go into a CONSTRUCTABLE stylesheet instead, which is
       CSSOM all the way down and has no inline content to check.
     - `setAttribute("style", ...)` is refused. Nothing here uses it; the
       few SVG nodes that wanted a presentational `style` attribute set
       the property through CSSOM instead.
     - writing `element.style` IS permitted, because it is CSSOM and not
       an inline style attribute being parsed. That is what lets the port
       keep the original's per-element placement verbatim.

   The baked sprites are `data:` PNGs, which `img-src 'self' data:` -
   already the portal's baseline - permits. Nothing is fetched but the
   twelve object bodies, from this artifact's own origin.

   TYPES. This file is plain JavaScript and is not type-checked; the
   boundary the island sees is declared in `scene.d.ts`, by hand. Keep the
   two in step - the compiler will not.
   ==================================================================== */

/** Where the object bodies live. The island stamps the build's own path. */
export const CONFIG = { assetBase: "./" };

/* `ROOT_SEL` went with the night sprite filter, which was the only rule this module still
   generated against the scene root. Every other rule it makes is a keyframe. */

/*
 * ONE THEME IS BUILT, NOT TWO.
 *
 * Every procedural body used to be baked twice - once dark, once light - and
 * both copies shipped into the DOM, the one that was not being looked at held
 * at `opacity: 0` and cross-faded in when the theme changed. It was cheap to
 * write and expensive to keep: twice the images to decode and hold, twice the
 * nodes to style, twice the composited layers, and a second full scene sitting
 * invisibly behind the first for the lifetime of the page.
 *
 * The scene is built for the sky it is being looked at under, and a theme
 * change rebuilds it. A rebuild is one pass of procedural drawing - the same
 * pass the page already does once on load - and it happens when a reader
 * flips a switch, which is not a frame budget. What it buys is that the theme
 * that is not on screen is ABSENT: no image, no element, no layer, nothing to
 * pause.
 */
let NIGHT = true;
/** The one theme being built, in the shape the per-theme loops want. */
const THEMES = () => [NIGHT ? "night" : "day"];

/** One object body's URL, inside the published asset directory. */
function assetUrl(name) {
  const base = CONFIG.assetBase;
  return (base.endsWith("/") ? base : base + "/") + name;
}
/* ---- NO SPRITE ANCHOR CONTRACT, BECAUSE THERE ARE NO SPRITES ---------
   `SPR` held the anchor and attachment points for the two satellites, and `SIZE` their widths.
   Both went with the satellites. Nothing in the scene is now placed from a packaged body: the
   iceberg and the ice station are baked into a canvas from this file's own drawing code, the
   contours and the mountains are solved, and the sky is one exported texture plus a moon or a sun.
   --------------------------------------------------------------------- */

/* The seeded RNG is gone with the last caller. Every composition this renderer draws is now
   either solved from the geometry or written out as a fixed specification, so nothing depends on a
   shared stream and nothing can be moved by a draw made somewhere else. */
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => {
  const u = clamp((x - a) / (b - a), 0, 1);
  return u * u * (3 - 2 * u);
};
const smootherstep = (a, b, x) => {
  const u = clamp((x - a) / (b - a), 0, 1);
  return u * u * u * (u * (u * 6 - 15) + 10);
};
const f2 = (v) => Math.round(v * 100) / 100;
const mix = (c1, c2, k) => c1.map((v, i) => Math.round(v + (c2[i] - v) * k));
const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;

/* ---- one CONSTRUCTABLE stylesheet, rebuilt on resize -----------------
   Not a <style> element. The portal's own policy is `style-src 'self'`
   with no `'unsafe-inline'`, and a <style> element created at run time is
   refused under it - even an empty one, whose `sheet` then comes back
   null. A constructed sheet is CSSOM with no inline content to check, so
   it is not subject to the directive at all, and it is adopted and
   dropped as one object rather than being appended to the head.

   `replaceSync` is used once, with the whole body: inserting a few
   thousand rules one at a time is the slow way to say the same thing. */
let SHEET = null,
  KFN = 0,
  RULES = [];
function newSheet() {
  if (!SHEET) SHEET = new CSSStyleSheet();
  RULES = [];
  KFN = 0;
  SHEET.replaceSync("");
  if (!document.adoptedStyleSheets.includes(SHEET))
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, SHEET];
}
function addRule(t) {
  RULES.push(t);
}
/** Commit every rule generated during a build. Called once, at the end. */
function flushSheet() {
  SHEET.replaceSync(RULES.join("\n"));
}
/** Drop the sheet from the document. Called on teardown. */
function dropSheet() {
  if (!SHEET) return;
  document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== SHEET);
  RULES = [];
  SHEET = null;
}
/*
 * `kf()` AND `anim()` ARE GONE, AND SO IS EVERY CALLER.
 *
 * The sheet still exists - it carries the class rules and the per-build geometry - but it no longer
 * generates keyframes, because the scene no longer has anything to animate. There is no `.anim`
 * class, no `animationName`, no negative delay that lands a paused element on a composed phase, and
 * no `track()` sampler. A retained element here has ZERO animation objects on it, which is a
 * different claim from zero running ones: nothing is installed and paused.
 */

/* ---- stages of the story --------------------------------------------
   Every animated thing belongs to one band of the transect, and only the
   band a reader is looking at - and the one either side of it - is allowed
   to run. The marking is an attribute rather than a container, because the
   layers are z-index siblings and reparenting them to group by stage would
   reorder the drawing.
   --------------------------------------------------------------------- */
/* ---- THE SWELL IS GONE ------------------------------------------------
   `SEA_AMP`, `SEA_PERIOD`, `SEA_KF` and `SEA_HEAVE()` defined one keyframe so the water band and
   the iceberg could rise and fall together. The brief asks for a still scene with the iceberg
   aligned to the waterline in a deliberate pose, so the two now share a waterline instead of a
   period: the band is drawn at its rest position and the berg sits on it. Nothing samples, nothing
   heaves, and the two cannot drift apart because neither moves.
   --------------------------------------------------------------------- */

/**
 * The star sphere's intrinsic side, from `client/components/cosmos/scene/sky/MANIFEST.json`.
 *
 * The element is laid out at this size and scaled up by its own transform, so the number has to
 * match the exported file. `tests/artifact/cosmos-theme.test.ts` reads both and compares them.
 */
const SPHERE_TEXTURE = 1800;

/* ---- THE STAGE MARKERS ARE GONE --------------------------------------
   `ZONES`, `zone()`, the `data-z` attribute and the `.zone[data-zone]` strips existed for one
   purpose: to let an IntersectionObserver name the bands on screen so the preset's CSS could pause
   the animations in the bands that were not. With no animations there is nothing to gate, so the
   observer, the attributes, the strips and the rules they drove have all been removed rather than
   left in place doing nothing.
   --------------------------------------------------------------------- */

/* ---- DOM / SVG helpers ---------------------------------------------- */
const NS = "http://www.w3.org/2000/svg";
function el(tag, cls, parent, css) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (css) e.style.cssText = css;
  if (parent) parent.appendChild(e);
  return e;
}
function sv(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}
/*
 * An SVG layer whose user units ARE css pixels, and cannot stop being.
 *
 * THIS IS A SCROLLBAR BUG, and it is worth the paragraph. Everything else in
 * the scene is positioned in raw pixels off `w = max(320, innerWidth)`; these
 * layers carry `viewBox="0 0 w h"` and got their width from `.lyr`'s
 * `width: 100%`. Those two are the same number only while the root is as wide
 * as the window - and it is not, on every platform that puts a CLASSIC
 * scrollbar in the layout instead of floating one over it. There the root is
 * 15 px narrower, the box and the viewBox disagree, and the default
 * `preserveAspectRatio` of `xMidYMid meet` does what it is for: it scales the
 * whole drawing down to fit the width and CENTRES it vertically.
 *
 * At 1503 px that is a scale of 0.990 and a 26 px band of bare paper under
 * the seafloor - a pale strip across the foot of the page, which is how this
 * was found. At 390 px the same 15 px is 3.8 %, and the band is over two
 * hundred pixels: the contours, the seabed, the ocean and the depth axis all
 * slide up away from the vessel, the buoys and the instruments, which are
 * DOM elements and never moved. The picture comes apart.
 *
 * So the width is stated in pixels, from the same `w` the viewBox uses, and
 * `preserveAspectRatio="none"` makes the mapping axis-independent as well -
 * with both extents exact it is the identity, and it cannot become anything
 * else. A root narrower than the window now simply clips the last few pixels
 * of the composition under the scrollbar, which is what every other layer in
 * the scene already does.
 */
function svgLayer(parent, w, h, cls) {
  const s = document.createElementNS(NS, "svg");
  s.setAttribute("class", "lyr " + (cls || ""));
  s.setAttribute("width", w);
  s.setAttribute("height", h);
  s.setAttribute("viewBox", "0 0 " + w + " " + h);
  s.setAttribute("preserveAspectRatio", "none");
  s.style.width = w + "px";
  s.style.height = h + "px";
  parent.appendChild(s);
  return s;
}
function curve(pts, close) {
  if (pts.length < 2) return "";
  let d = "M" + f2(pts[0][0]) + " " + f2(pts[0][1]);
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i],
      p1 = pts[i],
      p2 = pts[i + 1],
      p3 = pts[i + 2] || p2;
    d +=
      "C" +
      f2(p1[0] + (p2[0] - p0[0]) / 6) +
      " " +
      f2(p1[1] + (p2[1] - p0[1]) / 6) +
      "," +
      f2(p2[0] - (p3[0] - p1[0]) / 6) +
      " " +
      f2(p2[1] - (p3[1] - p1[1]) / 6) +
      "," +
      f2(p2[0]) +
      " " +
      f2(p2[1]);
  }
  return close ? d + "Z" : d;
}

/* ====================================================================
   THE BAKERY
   Every procedural drawing in this file is executed once, here, into its
   own small canvas. `ox,oy` is where the drawing's own origin sits inside
   that canvas, so a baked sprite can be dropped at a scene point and line
   up exactly the way the source engine's ctx.translate() did.
   ==================================================================== */
/*
 * THE CANVAS IS THE ARTWORK NOW. It is not encoded, and nothing decodes it.
 *
 * This function used to finish with `cv.toDataURL("image/png")`: every procedural drawing in the
 * scene was rasterised, PNG-encoded, base64'd into an attribute, and then decoded again by the
 * image pipeline before it could be shown. Forty of them on the Waterpark landing page, and all
 * forty again on every theme change - measured at 435 ms of it on load and 200 ms inside
 * `toDataURL` alone on a flip, with 21 `data:` URIs left sitting in the finished document.
 *
 * None of that produced a single pixel the canvas did not already hold. A `<canvas>` that is drawn
 * once and never touched again is exactly what an `<img>` is to the compositor - one static
 * texture - so the canvas is handed to the page directly and the encode, the base64 and the decode
 * all go. The drawing itself is unchanged, down to the device-pixel scale `S`.
 *
 * WHY NOT A PRE-GENERATED FILE, for these. Because every one of them is a function of the
 * visitor's viewport: `bake` is called with sizes derived from the solved geometry, and the terrain
 * these drawings sit on is re-solved from the window's width and height. A file can only be the
 * artwork for one layout. The one drawing that is NOT geometry-dependent - the star sphere, which
 * is drawn in its own polar frame and merely scaled - is a pre-generated file, and it is the piece
 * that most deserved to be one.
 */
function bake(w, h, ox, oy, fn, S) {
  S = S || 2;
  const cv = document.createElement("canvas");
  cv.width = Math.max(1, Math.ceil(w * S));
  cv.height = Math.max(1, Math.ceil(h * S));
  const c = cv.getContext("2d");
  c.setTransform(S, 0, 0, S, 0, 0);
  c.translate(ox, oy);
  fn(c);
  return { cv: cv, w: w, h: h, ox: ox, oy: oy };
}
/* A `lo -> hi -> lo` keyframe read at one instant: what a parked breath is
   holding. `p` is the phase the animation's negative delay put it at. */
function tri(lo, hi, p) {
  p = ((p % 1) + 1) % 1;
  return lo + (hi - lo) * (p < 0.5 ? p / 0.5 : (1 - p) / 0.5);
}
/* drop a baked sprite so its origin lands on the parent's own origin */
function drop(parent, b, cls, extra) {
  /* The baked canvas itself, sized in CSS pixels so its backing store stays the `S`-times-denser
     one it was drawn at. `aria-hidden` because it is a drawing with no meaning to announce; the
     scene as a whole is decorative and the caption says so. */
  b.cv.className = cls || "";
  b.cv.style.cssText =
    `position:absolute;left:${f2(-b.ox)}px;top:${f2(-b.oy)}px;width:${f2(b.w)}px;height:${f2(b.h)}px;` +
    (extra || "");
  b.cv.setAttribute("aria-hidden", "true");
  parent.appendChild(b.cv);
  return b.cv;
}
/* `dual` went with the instruments: it was the shorthand for "bake this in the sky being looked
   at", and every remaining drawing calls `bake` directly. */

/* ====================================================================
   LAYOUT — the source engine's own three-band budget, solved together
   ==================================================================== */
let G = {};
/*
 * The allocator, unchanged from the previous renderer.
 *
 * The ONE difference is where `H` comes from. The standalone study had no
 * page to measure, so it took its story height to be 4.28 viewports. Here
 * the story is told down a real element - the Cosmos shell, which is as
 * tall as the landing that sits on it - and `H` is that element's height,
 * which is what the previous renderer measured too. Fed a real Waterpark
 * landing (1440x900, H=4751) the three bands below solve to 1658.099,
 * 1685.099, 3811 and 4725: the previous renderer's own numbers, exactly.
 */
function geometry(hostH) {
  const w = Math.max(320, window.innerWidth),
    h = Math.max(420, window.innerHeight);
  const H = Math.max(Math.round(h * 1.6), Math.round(hostH));
  const gap = h * 0.03,
    tail = 26,
    budget = H - gap - tail;
  const wantSpace = Math.max(H * 0.349, h * 1.525);
  const wantOcean = Math.max(940, h * 1.04) - tail;
  const minSpace = h * 1.1,
    minOcean = h * 0.72,
    minXsec = h * 1.6;
  let space = wantSpace,
    ocean = wantOcean,
    xsec = budget - space - ocean;
  if (xsec < minXsec) {
    const sS = Math.max(0, space - minSpace),
      sO = Math.max(0, ocean - minOcean),
      slack = sS + sO;
    if (slack > 0) {
      const take = Math.min(minXsec - xsec, slack);
      space -= (take * sS) / slack;
      ocean -= (take * sO) / slack;
      xsec = budget - space - ocean;
    }
    if (xsec < minXsec) {
      const k = budget / (minSpace + minOcean + minXsec);
      space = minSpace * k;
      ocean = minOcean * k;
      xsec = budget - space - ocean;
    }
  }
  const spaceEnd = space,
    chartTop = spaceEnd + gap,
    groundY = chartTop + xsec,
    oceanBot = groundY + ocean;
  const coastX = w * 0.5;
  /* the engine ties peak height to the VIEWPORT height; on a narrow frame
     the range also has very little width to stand in, so it is additionally
     capped against its own span — desktop is unchanged to the pixel */
  const mtnSpan = (coastX - w * 0.13) * 0.55;
  const peakH = Math.max(150, Math.min(Math.max(230, Math.min(470, h * 0.343)), mtnSpan * 1.7));
  const SZ = Math.max(0.82, Math.min(1.1, w / 1440)); // the source's gentle size response
  return {
    w,
    h,
    H,
    spaceEnd,
    chartTop,
    groundY,
    oceanBot,
    sceneH: H,
    coastX,
    peakH,
    SZ,
    shipS: 1.9 * SZ,
    buoyS: SZ,
    narrow: w < 760,
    mid: w < 1100,
  };
}

/* ---- the source engine's ridged-noise terrain, unchanged ------------ */
function ridgeRaw(x, seed) {
  const p = x + (seed || 0);
  let v = 0,
    amp = 0.5,
    fr = 3.0;
  for (let o = 0; o < 6; o++) {
    const s = Math.sin(p * fr + o * 1.7 + (seed || 0) * 3.1);
    v += (1 - Math.abs(s)) * amp;
    amp *= 0.52;
    fr *= 2.03;
  }
  return Math.pow(Math.max(0, v - 0.25), 1.35);
}
const RMAX = {};
function rN(u, seed) {
  if (RMAX[seed] === undefined) {
    let m = 0;
    for (let i = 0; i <= 512; i++) m = Math.max(m, ridgeRaw(i / 512, seed));
    RMAX[seed] = m || 1;
  }
  return ridgeRaw(u, seed) / RMAX[seed];
}

function makeTerrain() {
  const { w, groundY, coastX, peakH, oceanBot } = G;
  const seaY = groundY;
  const beachStartX = coastX - w * 0.13,
    rampEndX = coastX + w * 0.15,
    mtnEndX = beachStartX * 0.55;
  const maxDepth = 4000;
  const depthToY = (m) => seaY + (m / maxDepth) * (oceanBot - seaY);
  const floorDepth = (x) => {
    const u = clamp((x - coastX) / (w - coastX), 0, 1.6);
    const shelf = 70 + 150 * smoothstep(0, 0.2, u);
    const slope = 3150 * smoothstep(0.2, 0.46, u);
    const und = 55 * Math.sin(u * 6.5 + 1.3) + 22 * Math.sin(u * 15 + 0.4);
    return Math.min(maxDepth - 30, shelf + slope + und);
  };
  const floorY = (x) => depthToY(floorDepth(x));
  const mtnEnv = (x) => {
    const u = clamp((mtnEndX - x) / Math.max(1, mtnEndX * 0.34), 0, 1);
    return u * u * (3 - 2 * u);
  };
  const plainBase = (x) => seaY - 22 - 22 * rN((x * 2.4) / w, 0.77);
  const rangeAt = (seed, amp, stretch) => (x) =>
    plainBase(x) - amp * peakH * Math.pow(rN((x * stretch) / w, seed), 0.92) * mtnEnv(x);
  /* lit / shade / haze / snow, verbatim from the source */
  const ranges = [
    {
      f: rangeAt(0.61, 0.64, 1.9),
      lit: [150, 132, 112],
      shade: [104, 88, 72],
      haze: 0.62,
      snow: peakH * 0.26,
      step: 9,
      snowGain: 1,
    },
    {
      f: rangeAt(0.29, 0.84, 2.3),
      lit: [140, 116, 88],
      shade: [86, 66, 48],
      haze: 0.34,
      snow: peakH * 0.6,
      step: 7,
      snowGain: 2.6,
    },
    {
      f: rangeAt(0.0, 1.0, 2.7),
      lit: [124, 96, 66],
      shade: [64, 45, 29],
      haze: 0,
      snow: peakH * 0.42,
      step: 5,
      snowGain: 1,
    },
  ];
  const landY = ranges[2].f;
  const shoreY = (x) => {
    if (x <= beachStartX) return landY(x);
    if (x >= rampEndX) return floorY(x);
    const y0 = landY(beachStartX),
      y1 = floorY(rampEndX);
    return y0 + (y1 - y0) * smootherstep(beachStartX, rampEndX, x);
  };
  const bedY = (x) => (x <= rampEndX ? shoreY(x) : floorY(x));
  let xShore = coastX;
  {
    let lo = beachStartX,
      hi = rampEndX;
    for (let k = 0; k < 26; k++) {
      const m = (lo + hi) / 2;
      if (shoreY(m) < seaY) lo = m;
      else hi = m;
    }
    xShore = (lo + hi) / 2;
  }
  /* orography as the model sees it: metres, then smoothed like a real model */
  const terrScale = 2400 / Math.max(80, peakH);
  const N = 129,
    raw = new Float32Array(N),
    sm = new Float32Array(N);
  for (let i = 0; i < N; i++) raw[i] = Math.max(0, (seaY - shoreY((i / (N - 1)) * w)) * terrScale);
  for (let i = 0; i < N; i++) {
    let acc = 0,
      wt = 0;
    for (let k = -5; k <= 5; k++) {
      const j = clamp(i + k, 0, N - 1),
        g = Math.exp(-(k * k) / (2 * 2.6 * 2.6));
      acc += raw[j] * g;
      wt += g;
    }
    sm[i] = acc / wt;
  }
  const terrZ = (u) => {
    const fx = clamp(u * 128, 0, 127.999),
      i = fx | 0,
      tx = fx - i;
    return sm[i] * (1 - tx) + sm[i + 1] * tx;
  };

  /* instrument spots: flattest ground inside each third of the plain */
  const flat = (a, b) => {
    let best = (a + b) / 2,
      bs = Infinity;
    for (let x = a; x <= b; x += 5) {
      const s =
        Math.abs(shoreY(x + 7) - shoreY(x - 7)) +
        Math.abs(shoreY(x + 16) - shoreY(x - 16)) * 0.5 +
        Math.max(0, seaY - shoreY(x)) * 0.1;
      if (s < bs) {
        bs = s;
        best = x;
      }
    }
    return best;
  };
  const p0 = mtnEndX + 12,
    p1 = coastX - 30,
    span = Math.max(0, p1 - p0);
  const SLOT = 68;
  const order = ["lidar", "wx", "radar"],
    priority = ["radar", "wx", "lidar"];
  const keep = new Set(priority.slice(0, Math.max(1, Math.min(3, Math.floor(span / SLOT)))));
  const shown = order.filter((k) => keep.has(k));
  const n = Math.max(1, shown.length),
    spots = {};
  shown.forEach((k, i) => {
    spots[k] = flat(p0 + span * (i / n) + 8, p0 + span * ((i + 1) / n) - 8);
  });
  spots.sondeB =
    spots.wx != null ? spots.wx - 26 : spots.radar != null ? spots.radar - 30 : p0 + span * 0.3;

  return {
    seaY,
    beachStartX,
    rampEndX,
    mtnEndX,
    maxDepth,
    depthToY,
    floorDepth,
    floorY,
    plainBase,
    ranges,
    landY,
    shoreY,
    bedY,
    xShore,
    terrZ,
    spots,
  };
}

/* ---- ocean colour ramp, verbatim ------------------------------------ */
const TEMP_DARK = [
  [0, 8, 26, 46],
  [4, 12, 46, 70],
  [8, 18, 72, 92],
  [12, 30, 100, 110],
  [16, 58, 128, 126],
  [20, 100, 148, 124],
  [26, 146, 158, 118],
];
const TEMP_LIGHT = [
  [0, 18, 46, 84],
  [4, 22, 78, 118],
  [8, 32, 118, 148],
  [12, 54, 156, 168],
  [16, 104, 190, 186],
  [20, 168, 212, 180],
  [26, 224, 224, 172],
];
function tempColour(t, dark) {
  const S = dark ? TEMP_DARK : TEMP_LIGHT;
  if (t <= S[0][0]) return `rgb(${S[0][1]},${S[0][2]},${S[0][3]})`;
  for (let i = 1; i < S.length; i++)
    if (t <= S[i][0]) {
      const a = S[i - 1],
        b = S[i],
        f = (t - a[0]) / (b[0] - a[0]);
      return `rgb(${Math.round(lerp(a[1], b[1], f))},${Math.round(lerp(a[2], b[2], f))},${Math.round(lerp(a[3], b[3], f))})`;
    }
  const L = S[S.length - 1];
  return `rgb(${L[1]},${L[2]},${L[3]})`;
}
const HAZECOL = (d) => (d ? [22, 32, 44] : [196, 205, 216]);

/* ====================================================================
   SKY — the source engine's gradients, star field, Milky Way, limb,
   airglow, aurora and meteors, baked once and rotated as rigid sky.
   ==================================================================== */
function buildSky(root) {
  const { w, spaceEnd, chartTop } = G;

  /* backdrop: the sky band's gradient runs into the cross-section's own
     paper colour, exactly as the engine composites them, so the two bands
     meet with no seam of any kind */
  const stopsN = [
    [0, "#010205"],
    [0.3, "#03050c"],
    [0.52, "#070d18"],
    [0.72, "#0f1c2c"],
    [0.86, "#16222e"],
    [0.95, "#111a24"],
    [1, "rgb(10,16,23)"],
  ];
  const stopsD = [
    [0, "#0c1830"],
    [0.3, "#12244a"],
    [0.52, "#1d3766"],
    [0.72, "#2f5688"],
    [0.86, "#4a7aa8"],
    [0.95, "#8fb0c6"],
    [1, "rgb(223,230,238)"],
  ];
  const mkBack = (cls, stops, paper) => {
    /* Pinned to the root's bottom rather than given a height, for the reason
       the basement in `buildEarth` is: the page can grow after the story has
       been solved, and the paper colour has to grow with it. */
    const d = el("div", "lyr " + cls, root, `bottom:0;z-index:0;background:${paper}`);
    el(
      "div",
      "lyr",
      d,
      `height:${f2(chartTop)}px;background:linear-gradient(180deg,` +
        stops.map((s) => s[1] + " " + (s[0] * 100).toFixed(1) + "%").join(",") +
        `)`,
    );
  };
  if (NIGHT) mkBack("", stopsN, "rgb(10,16,23)");
  else mkBack("", stopsD, "rgb(223,230,238)");

  const band = el("div", "lyr clip", root, `height:${f2(chartTop)}px;z-index:1`);

  /* ---- celestial sphere ------------------------------------------- */
  const poleX = w * 0.84,
    poleY = spaceEnd * 0.19;
  const R =
    Math.max(
      Math.hypot(poleX, poleY),
      Math.hypot(w - poleX, poleY),
      Math.hypot(poleX, spaceEnd - poleY),
      Math.hypot(w - poleX, spaceEnd - poleY),
    ) * 1.02;
  /* celestial transmission: the engine fades the background as the air
     below thickens — mild at night, gone before the troposphere by day */
  /* the sky's own transmission by day, as an opacity on the one image that
     is built rather than as a pair of rules over two that are */
  const CEL_OP = NIGHT ? 1 : 0.13;

  /* ----------------------------------------------------------------------
     THE SKY IS ONE PICTURE NOW, AND IT DOES NOT TURN.

     It used to be a `2R x 2R` box - four thousand pixels on a side, sixteen
     megapixels of it - rotating once every 1,600 seconds inside a masked
     layer, with four more overlays of the same size dealt across it for the
     scintillation. Five composited surfaces, sixty-seven of the seventy
     megapixels this scene ever asked a compositor to keep in motion, to
     turn the sky by a fifth of a degree a minute and make fifty-six
     one-pixel dots breathe.

     A reader does not see either of those. What they see is the sky, and
     the sky is now exactly what it looked like at the moment the page
     loaded: the sphere frozen at the phase its 420-second negative delay
     put it at, the fifty-six stars frozen at the opacity their four
     overlays held at that same instant, the altitude mask painted in
     rather than left to the compositor, all of it flattened into ONE image
     the size of the sky band - `w` by `chartTop`, under three megapixels -
     that is placed once and never touched again.

     The composition behind it is untouched. Every `rng()` draw the field
     made is still made, in the same order, including the two per star that
     only ever chose a twinkle rate: the stream is seeded, and a draw that
     stops being made moves the meteors and re-cuts the aurora. They now
     choose which of the four frozen brightnesses a star is baked at, which
     is what the grouping was for in the first place.
     ---------------------------------------------------------------------- */
  /* The frozen phase is gone: the sphere's own `animation-delay: -420s` on a 1600 s turn is where
     that number lives now, so the page still opens on the phase it always opened on. */

  /* ---- THE SPHERE IS NOT DRAWN HERE. IT IS A FILE, AND ONLY A FILE. ----
     `scripts/export-cosmos-art.mjs` ran the star field and the galactic band once, from
     `art/sky-art.mjs`, and committed `sky/sky-sphere.webp`. Drawing them again on every mount and
     every theme rebuild - 1,700 stars, 2,600 band points and 56 scintillant stars, into an 1800 px
     canvas that was then explicitly discarded - was work with no pixel to show for it. It is gone:
     no canvas is allocated, no gradient is filled, and the seeded `rng()` stream that fed it is no
     longer consumed here either.

     WHAT DEPENDED ON THAT STREAM. The two comets took their length, angle and position from the
     draws that followed the star field, so removing the field would have moved them. They no longer
     ask: their specifications below are FIXED, and they are the approved prototype's own, so the
     comets are where the reviewed sky put them and nothing downstream can drift them again.
     ---------------------------------------------------------------------------------------- */
  /*
   * THE ELEMENT IS THE TEXTURE'S SIZE, AND A TRANSFORM DOES THE REST.
   *
   * The sphere covers the whole band while it turns about a pole near the top right, so at 1440 CSS
   * px it is 3,890 px across. Laid out at that size it becomes a composited layer of the same
   * dimensions; laid out at the texture's own 1,800 px and scaled by the transform that already
   * carries the rotation, it is a 1,800 px box and the compositor samples up from it. That is the
   * arrangement the reviewed prototype settled on and defaulted to, and this had reverted it.
   *
   * The pole, the period and the opening phase are unchanged: the element is still centred on
   * `poleX, poleY`, the turn is still 1,600 s, and the negative 420 s delay still opens the page on
   * the phase it always opened on. `scale` precedes `rotate` in the keyframe so the rotation is
   * about the element's own centre either way.
   */
  const SIDE = SPHERE_TEXTURE;
  const K = (2 * R) / SIDE;
  /*
   * AND IT NO LONGER TURNS.
   *
   * The rotation was a 1,600-second turn about a pole near the top right, opened on a phase by a
   * negative 420-second delay. The still scene keeps the pose that delay produced - the sky the
   * page has always opened on - and states it as a static transform instead of as frame zero of an
   * animation that has been paused. `scale` precedes `rotate` for the same reason it did in the
   * keyframe: the rotation is about the element's own centre either way.
   */
  const OPEN_TURN = f2((420 / 1600) * 360);
  const sphere = el(
    "img",
    "lyr cel",
    band,
    `left:${f2(poleX - SIDE / 2)}px;top:${f2(poleY - SIDE / 2)}px;` +
      `width:${f2(SIDE)}px;height:${f2(SIDE)}px;` +
      `opacity:${CEL_OP};transform-origin:50% 50%;` +
      `transform:scale(${f2(K)}) rotate(${OPEN_TURN}deg)`,
  );
  sphere.src = assetUrl("sky/sky-sphere.webp");
  sphere.alt = "";
  sphere.decoding = "async";

  /* the extinction, over the stars and under everything else in the band */
  {
    /*
     * THE LAST STOP IS THE PAPER THE BAND ENDS ON, and that is the fix.
     *
     * The overlay ramps to fully opaque at 97% and then has to hold that colour to 100%, where the
     * sky band meets the cross-section below it. It was repeating its own 97% value instead - a
     * mid-blue by day, a slate at night - against a paper of `rgb(223,230,238)` and `rgb(10,16,23)`
     * respectively. That is a colour step exactly at the junction: a seam by construction, whether
     * or not a given screenshot happened to show it.
     *
     * The ramp's own stops are still the backdrop gradient's, sampled at the same four places, so
     * the extinction itself is unchanged. Only the endpoint moves, onto the colour the band
     * actually finishes on.
     */
    const paper = NIGHT ? "10,16,23" : "223,230,238";
    const stops = NIGHT
      ? [
          [0, "1,2,5", 0],
          [0.46, "3,5,12", 0],
          [0.74, "15,28,44", 0.38],
          [0.97, paper, 1],
          [1, paper, 1],
        ]
      : [
          [0, "12,24,48", 0],
          [0.46, "29,55,102", 0],
          [0.74, "47,86,136", 0.38],
          [0.97, paper, 1],
          [1, paper, 1],
        ];
    el(
      "div",
      "lyr",
      band,
      `height:${f2(chartTop)}px;z-index:2;background:linear-gradient(180deg,` +
        stops.map(([t, col, a]) => `rgba(${col},${a}) ${(t * 100).toFixed(1)}%`).join(",") +
        `)`,
    );
  }

  /* ---- THE COMETS ARE GONE ------------------------------------------
     Two streaks, night only, each visible for under two per cent of a 46- and a 65-second cycle
     and invisible for the rest of it - so for almost all of their life they were a composited
     layer holding a fully transparent gradient and an animation the compositor still had to tick.
     The trails, their fixed specifications, their keyframes and the `NIGHT` branch that drew them
     are all removed; nothing replaces them.
     ------------------------------------------------------------------ */

  /* ---- the aurora is gone ------------------------------------------
     Three baked curtains drifting on a shared 282-second activity
     envelope, inside a `mix-blend-mode: screen` wrapper. They were the
     three largest animated surfaces left in the scene - 0.39, 0.36 and
     0.34 megapixels, more than the whole rest of the orbit stage put
     together - and they were blended, which is the one compositing job a
     moving layer cannot be cheap at.

     Removed entirely, as reviewed: the curtains, their drift, the
     envelope, the baked ray textures, the blend wrapper and every line of
     code and keyframe that existed only for them. Nothing replaces them.

     What is left of the aurora's band is the thin atmospheric limb and its
     airglow, below - a static green line at night and a pale one by day,
     drawn in SVG and never animated. It was always a separate object.

     THE SEEDED STREAM IS NOT DISTURBED. The curtains' `rng()` draws came
     after the star field's and the meteors' and before nothing at all -
     the limb is deterministic and this `rng` never leaves `buildSky` - so
     the sky above is drawn exactly as it was. */

  /* ---- atmospheric limb + airglow ---------------------------------- */
  {
    const limbY = spaceEnd * 0.915,
      Rc = w * 2.6,
      cxE = w * 0.5,
      cyE = limbY + Rc;
    const limbAt = (x) => cyE - Math.sqrt(Math.max(0, Rc * Rc - (x - cxE) * (x - cxE)));
    const svg = svgLayer(band, w, chartTop, "");
    svg.style.zIndex = 3;
    const pts = [];
    for (let i = 0; i <= 44; i++) {
      const x = -w * 0.06 + w * 1.12 * (i / 44);
      pts.push([x, limbAt(x)]);
    }
    const d = curve(pts);
    const defs = sv("defs", {}, svg);
    const glow = (cls, col, k) => {
      /* `style` as an ATTRIBUTE is refused by `style-src 'self'`; the same
         declaration set through CSSOM is not. */
      /* ORDINARY ALPHA. The reference blends this `screen`; the reviewed sky does not blend, and a
         blended layer over a changing backdrop cannot be swapped for a transparent one and still be
         promised as identical. The stroke opacities are the reference's, unchanged. */
      const g = sv("g", { class: cls }, svg);
      [
        [32, 0.024 * k],
        [16, 0.042 * k],
        [6.5, 0.062 * k],
        [2.2, 0.1 * k],
        [1, 0.16 * k],
      ].forEach(([lw, o]) =>
        sv(
          "path",
          {
            d,
            fill: "none",
            stroke: col,
            "stroke-width": lw,
            "stroke-opacity": o.toFixed(3),
            "stroke-linecap": "round",
          },
          g,
        ),
      );
    };
    if (NIGHT) glow("", "rgb(126,230,198)", 0.85);
    else glow("", "rgb(176,216,255)", 1.2);
    const wedge = (cls, c1, c2, a) => {
      const id = "lg" + KFN++;
      const lg = sv("linearGradient", { id, x1: "0", y1: "0", x2: "0", y2: "1" }, defs);
      sv("stop", { offset: "0", "stop-color": c1, "stop-opacity": "0" }, lg);
      sv("stop", { offset: "0.42", "stop-color": c1, "stop-opacity": a }, lg);
      sv("stop", { offset: "1", "stop-color": c2, "stop-opacity": "0" }, lg);
      sv(
        "path",
        {
          class: cls,
          d: d + `L${f2(w * 1.06)} ${f2(chartTop)} L${f2(-w * 0.06)} ${f2(chartTop)} Z`,
          fill: `url(#${id})`,
        },
        svg,
      );
      /* ordinary alpha, as above */
    };
    if (NIGHT) wedge("", "rgb(46,128,140)", "rgb(14,30,44)", ".22");
    else wedge("", "rgb(160,206,250)", "rgb(210,226,242)", ".34");
  }
  return band;
}

/* ====================================================================
   LUMINARIES — the source engine's own Sun and Moon, at its own radii
   and its own places in the frame.
     sunR  = min(w, spaceEnd) * 0.125
     sunX  = -sunR * 0.40          sunY = spaceEnd*0.10 - sunR*0.42
     moonR = sunR * 0.52
     moonX = w * 0.17              moonY = spaceEnd * 0.115
   ==================================================================== */
function buildLuminaries(band) {
  const { w, spaceEnd } = G;
  const sunR = Math.min(w, spaceEnd) * 0.125;
  const sunX = -sunR * 0.4,
    sunY = spaceEnd * 0.1 - sunR * 0.42;
  const moonR = sunR * 0.52,
    moonX = w * 0.17,
    moonY = spaceEnd * 0.115;

  if (NIGHT) {
    buildMoon(band, moonR, moonX, moonY);
    return;
  }

  /* ---------- SUN ---------- */
  const sw = el("div", "lyr", band, `height:0;z-index:4`);
  const sunHolder = el(
    "div",
    "",
    sw,
    `position:absolute;left:${f2(sunX)}px;top:${f2(sunY)}px;width:0;height:0`,
  );
  /* scattering halo: a wide soft field, baked at low resolution because
     it is nothing but a gradient */
  const CR = sunR * 5.2;
  el(
    "div",
    "",
    sunHolder,
    `position:absolute;left:${f2(-CR)}px;top:${f2(-CR)}px;width:${f2(CR * 2)}px;height:${f2(CR * 2)}px;` +
      /* the engine's corona runs from r = 0.9*sunR to r = 5.2*sunR, so its
       stops are remapped onto CSS's centre-relative offsets */
      `border-radius:50%;background:radial-gradient(circle,` +
      `rgba(255,236,196,.26) ${f2((100 * 0.9) / 5.2)}%,` +
      `rgba(255,214,150,.10) ${f2((100 * (0.9 + 0.22 * 4.3)) / 5.2)}%,` +
      `rgba(255,196,128,.035) ${f2((100 * (0.9 + 0.55 * 4.3)) / 5.2)}%,` +
      `rgba(255,192,124,.014) ${f2((100 * (0.9 + 0.74 * 4.3)) / 5.2)}%,` +
      `rgba(255,190,120,.004) ${f2((100 * (0.9 + 0.88 * 4.3)) / 5.2)}%,` +
      `rgba(255,190,120,0) 100%)`,
  );
  /* THE PHOTOSPHERE IS A FILE, and it is the one the owner reviewed.
     `sky/sun.webp` is this exact drawing, exported once by `scripts/export-cosmos-art.mjs` and
     scaled to whatever `sunR` the layout solves. A disc of soft gradients scales without anyone
     being able to tell, which is why this one and the moon are files while the terrain is not. */
  {
    const im = el(
      "img",
      "",
      sunHolder,
      `position:absolute;left:${f2(-sunR * 1.1)}px;top:${f2(-sunR * 1.1)}px;` +
        `width:${f2(sunR * 2.2)}px;height:${f2(sunR * 2.2)}px`,
    );
    im.src = assetUrl("sky/sun.webp");
    im.alt = "";
    im.decoding = "async";
  }
  /* A 1.2 per cent scale over 41 seconds, on the photosphere. Parked. */
  /* THE LENS-FLARE GHOSTS ARE GONE.
     Four blended discs on a line from the sun to the centre of the frame, on a 37-second breath.
     They are not one of the retained subjects, they were not in the sky the owner reviewed, and
     they are a `mix-blend-mode: screen` layer - so they go with the beams below rather than
     returning unannounced. */
  el(
    "div",
    "lbl",
    sw,
    `left:${f2(sunX + sunR * 0.9)}px;top:${f2(sunY + sunR + 14)}px`,
  ).textContent = "SUN";
}

/* ---------- MOON ---------- */
function buildMoon(band, moonR, moonX, moonY) {
  const mw = el("div", "lyr", band, `height:0;z-index:4`);
  const mh = el(
    "div",
    "",
    mw,
    `position:absolute;left:${f2(moonX)}px;top:${f2(moonY)}px;width:0;height:0`,
  );
  const MR = moonR * 2.8;
  const halo = el(
    "div",
    "",
    mh,
    `position:absolute;left:${f2(-MR)}px;top:${f2(-MR)}px;width:${f2(MR * 2)}px;height:${f2(MR * 2)}px;` +
      `border-radius:50%;background:radial-gradient(circle,` +
      `rgba(186,206,232,.13) ${f2((100 * 0.95) / 2.8)}%,` +
      `rgba(170,192,222,.045) ${f2((100 * (0.95 + 0.3 * 1.85)) / 2.8)}%,` +
      `rgba(170,192,222,.016) ${f2((100 * (0.95 + 0.62 * 1.85)) / 2.8)}%,` +
      `rgba(170,192,222,.004) ${f2((100 * (0.95 + 0.85 * 1.85)) / 2.8)}%,` +
      `rgba(170,192,222,0) 100%)`,
  );
  /* The halo held a 47-second breath between 0.85 and 1 across a 524 px
     disc. Fifteen per cent of opacity over three quarters of a minute on a
     gradient that is already a soft field is not something a reader reads;
     the layer it needed is. Parked at the phase it opened on. */
  halo.style.opacity = f2(tri(0.85, 1, 15 / 47));
  /* THE MOON IS A FILE, for the same reason as the sun: `sky/moon.webp` is this drawing,
     exported once and scaled to the solved `moonR`. */
  {
    const im = el(
      "img",
      "",
      mh,
      `position:absolute;left:${f2(-moonR * 1.05)}px;top:${f2(-moonR * 1.05)}px;` +
        `width:${f2(moonR * 2.1)}px;height:${f2(moonR * 2.1)}px`,
    );
    im.src = assetUrl("sky/moon.webp");
    im.alt = "";
    im.decoding = "async";
  }
  el("div", "lbl", mw, `left:${f2(moonX)}px;top:${f2(moonY + moonR + 12)}px`).textContent = "MOON";
}

/* ====================================================================
   THE SATELLITES ARE GONE, AND WITH THEM THE ORBIT STAGE'S ONLY CONTENTS.

   Two passes remained of the engine's four: an imager crossing left to right over 196 seconds and
   a scatterometer crossing the other way over 262. Both are removed - the bodies, their labels,
   the `pass()` builder, the `body()` sprite placer, the `SPR` anchor contract and the `SIZE`
   hierarchy that sized them. `buildOrbit` drew nothing else, so the function is gone too rather
   than left as an empty layer with a z-index.

   THE CONSEQUENCE FOR THE PACKAGE. `SPR` was the registry `sceneBodies()` reported, so the scene
   now draws NO object bodies at all: the ten sprite files the artifact used to publish are named
   by nothing and are no longer built into it, and the WebP sources have been deleted from the
   repository rather than left for a future reader to wonder about. What the scene still loads is
   the sky art - the star sphere, the moon and the sun - which is retained artwork, not a subject.
   ==================================================================== */

/* ====================================================================
   ATMOSPHERIC CROSS-SECTION/* ====================================================================
   ATMOSPHERIC CROSS-SECTION
   Log-pressure coordinate, 50 hPa to the ground, exactly as the source.
   The contours are traced ONCE from a fixed synthetic state and never
   recomputed. Omega / vertical-velocity contours are deliberately absent.
   ==================================================================== */
const ATM = {
  PTOP: 50,
  P0: 1000,
  HS: 7600,
  zOf: (p) => 7.6 * Math.log(1000 / p) /* km */,
  pOf: (z) => 1000 * Math.exp(-z / 7.6),
  uFront: (z) => 0.3 + 0.028 * z,
  _tab: null,
  theta: function (u, z) {
    if (!this._tab) {
      this._tab = new Float32Array(481);
      let th = 288;
      const lr = (zz) => 4.0 + 9.5 * smoothstep(9.0, 13.4, zz);
      for (let i = 1; i <= 480; i++) {
        const z0 = (i - 1) * 0.05,
          z1 = i * 0.05;
        th += 0.05 * 0.5 * (lr(z0) + lr(z1));
        this._tab[i] = th;
      }
      this._tab[0] = 288;
    }
    const fi = clamp(z / 0.05, 0, 480),
      i0 = Math.floor(fi),
      i1 = Math.min(480, i0 + 1);
    const base = lerp(this._tab[i0], this._tab[i1], fi - i0);
    const uf = this.uFront(z);
    const front = -19.5 * smoothstep(uf - 0.135, uf + 0.135, u) * Math.exp(-z / 8.5);
    const wave =
      3.2 * Math.sin(u * 4.6 + 0.62) * Math.exp(-z / 7.0) +
      1.6 * Math.sin(u * 8.3 + 2.4) * Math.exp(-z / 5.0);
    const oro =
      2.2 * Math.sin(u * 13.5 + 1.4) * Math.exp(-z / 2.9) * (1 - smoothstep(0.28, 0.52, u));
    const lid = 3.0 * smoothstep(12.4, 15.0, z) * Math.sin(u * 3.1 + 1.9);
    return base + front + wave + oro + lid;
  },
  zTrop: (u) =>
    11.3 -
    2.0 * smoothstep(0.3, 0.74, u) +
    0.42 * Math.sin(u * 4.1 + 0.3) +
    0.5 * smoothstep(0.8, 0.96, u),
  wind: function (u, z) {
    const uf = this.uFront(z);
    return (
      5.5 +
      54 * Math.exp(-Math.pow((z - 10.6) / 4.0, 2)) * Math.exp(-Math.pow((u - uf) / 0.235, 2)) +
      2.4 * z * Math.exp(-z / 10.5)
    );
  },
  /* relative humidity: a frontal band, a boundary-layer deck, a cirrus
     shield and orographic cloud over the range — the field the cloud
     parcels are gated by, as in the source */
  rh: function (u, z) {
    const uf = this.uFront(z);
    const frontal =
      92 * Math.exp(-Math.pow((u - uf) / 0.17, 2)) * Math.exp(-Math.pow((z - 5.2) / 5.2, 2));
    const bl =
      80 * Math.exp(-Math.pow((z - 0.85) / 1.15, 2)) * (0.55 + 0.45 * Math.sin(u * 7.3 + 1.2));
    const cirrus =
      78 * Math.exp(-Math.pow((z - 9.8) / 2.0, 2)) * (0.5 + 0.5 * Math.sin(u * 3.1 + 0.4));
    const oro =
      72 * Math.exp(-Math.pow((z - 2.7) / 1.7, 2)) * Math.exp(-Math.pow((u - 0.2) / 0.13, 2));
    let rh = Math.max(frontal, bl, cirrus, oro) + 8 * Math.sin(u * 11 + z * 1.7);
    if (z > 11.6) rh *= Math.exp(-(z - 11.6) / 1.3);
    return rh;
  },
};

function buildAtmosphere(root, terr) {
  const { w, chartTop, groundY } = G;
  const chartH = groundY - chartTop;
  const LT = Math.log(ATM.PTOP),
    LB = Math.log(1000),
    LSPAN = LB - LT;
  const yOf = (p) => chartTop + ((Math.log(p) - LT) / LSPAN) * chartH;
  G.yOf = yOf;
  G.chartH = chartH;
  const zTerr = (u) => terr.terrZ(u) / 1000; /* metres -> km */

  const svg = svgLayer(root, w, groundY + 4, "");
  svg.style.zIndex = 8;
  const gGrid = sv("g", {}, svg),
    gTh = sv("g", {}, svg),
    gTrop = sv("g", {}, svg);

  /* ---- 1. pressure grid, faintest and furthest back ---------------- */
  const levels = [1000, 900, 850, 700, 500, 400, 300, 250, 200, 150, 100, 70, 50];
  THEMES().forEach((th) => {
    const dark = th === "night";
    const paper = dark ? "10,16,23" : "223,230,238";
    const g = sv("g", { class: "" }, gGrid);
    levels.forEach((p) => {
      const y = yOf(p);
      sv(
        "line",
        {
          x1: 0,
          y1: f2(y + 0.5),
          x2: w,
          y2: f2(y + 0.5),
          stroke: dark ? "rgba(180,200,212,0.11)" : "rgba(22,32,43,0.09)",
          "stroke-width": 1,
          "stroke-dasharray": "2 5",
        },
        g,
      );
      /* below 500 hPa the left margin is inside the mountains, so those
         levels are labelled against the right-hand edge instead */
      const txt = p + " hPa",
        tw = txt.length * 6 + 10;
      const onRight = p > 500,
        bx = onRight ? w - tw - 10 : 10;
      sv(
        "rect",
        { x: f2(bx), y: f2(y - 7), width: f2(tw), height: 14, fill: `rgba(${paper},0.86)` },
        g,
      );
      const t2 = sv(
        "text",
        {
          x: f2(bx + 5),
          y: f2(y + 3.5),
          "font-size": 10,
          fill: dark ? "rgba(150,170,182,0.95)" : "rgba(105,110,112,0.95)",
          "font-family": "'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,monospace",
        },
        g,
      );
      t2.textContent = txt;
    });
  });

  /* ---- 2. potential temperature: the primary structure -------------- */
  const NX = 124,
    TH_MIN = 250,
    TH_MAX = 520,
    TH_DI = 5;
  const runs = [];
  for (let V = TH_MIN; V <= TH_MAX; V += TH_DI) {
    let run = [];
    for (let i = 0; i <= NX; i++) {
      const u = i / NX;
      let lo = 0,
        hi = 23.2,
        ok = true;
      if (ATM.theta(u, lo) > V || ATM.theta(u, hi) < V) ok = false;
      let z = 0;
      if (ok) {
        for (let k = 0; k < 28; k++) {
          const m = (lo + hi) / 2;
          if (ATM.theta(u, m) < V) lo = m;
          else hi = m;
        }
        z = (lo + hi) / 2;
      }
      if (ok && z < zTerr(u) + 0.02) ok = false;
      if (!ok) {
        if (run.length > 2) runs.push({ V, pts: run });
        run = [];
        continue;
      }
      run.push([u * w, yOf(ATM.pOf(z))]);
    }
    if (run.length > 2) runs.push({ V, pts: run });
  }
  THEMES().forEach((th) => {
    const dark = th === "night";
    const g = sv("g", { fill: "none", "stroke-linejoin": "round", "stroke-linecap": "round" }, gTh);
    runs.forEach((o) => {
      const major = o.V % 20 === 0;
      sv(
        "path",
        {
          d: curve(o.pts),
          stroke: major
            ? dark
              ? "rgba(206,140,116,0.5)"
              : "rgba(150,58,38,0.52)"
            : dark
              ? "rgba(200,134,110,0.22)"
              : "rgba(150,58,38,0.26)",
          "stroke-width": major ? 1.1 : 0.75,
        },
        g,
      );
    });
  });

  /* ---- 3. one restrained tropopause ------------------------------- */
  {
    const pts = [];
    for (let i = 0; i <= NX; i++) {
      const u = i / NX;
      pts.push([u * w, yOf(ATM.pOf(ATM.zTrop(u)))]);
    }
    const d = curve(pts);
    THEMES().forEach((th) => {
      sv(
        "path",
        {
          d,
          fill: "none",
          stroke: th === "night" ? "rgba(200,190,230,0.55)" : "rgba(62,48,90,0.5)",
          "stroke-width": 1.1,
          "stroke-linecap": "round",
          "stroke-dasharray": "12 8",
        },
        gTrop,
      );
    });
  }

  /* ---- 4. THE WIND BARBS ARE GONE -----------------------------------
     A lattice of station-model wind marks at nine pressure levels and up to six columns, drawn
     twice across so it could wrap, gathered into three strips that each drifted a full window
     width. Those three strips were the largest animated surfaces left in the scene - 3.4, 2.7 and
     1.9 megapixels - and the measurement the owner supplied put stopping them at 300.49 to 89.46
     browser CPU ms/s at the coast once the other motion was already still.

     Removed entirely: the lattice, the three strips and their keyframes, the `barb()` station-model
     glyph builder, the pressure-level list and the column solver. `ATM.wind` remains because the
     potential-temperature and pressure contours above still read it.

     Nothing replaces them. The cross-section keeps its pressure grid, its isentropes and its
     tropopause, all of which are traced once and never move.
     ------------------------------------------------------------------ */
}

/* ====================================================================
   CLOUDS — REMOVED, as the simplified brief requires. The parcel
   construction, the RH field sampling that placed them, their baked
   artwork and their holders are all gone; nothing replaces them.
   ==================================================================== */

/* The ranges' shared haze gradient went with the cloud parcels that were
   the only caller left. */

function buildMountains(root, terr) {
  const { w, groundY, coastX, peakH, sceneH } = G;
  const seaY = groundY;
  const TOP = groundY - peakH - 40,
    BOT = groundY + 300,
    CH = BOT - TOP;
  const lyr = el("div", "lyr", root, `top:${f2(TOP)}px;height:${f2(CH)}px;z-index:14`);
  const holder = el("div", "", lyr, `position:absolute;left:0;top:0;width:0;height:0`);

  const paint = (c, dark) => {
    const hazeCol = HAZECOL(dark);
    c.translate(0, -TOP);
    for (const R of terr.ranges) {
      const isFront = R === terr.ranges[terr.ranges.length - 1];
      c.beginPath();
      c.moveTo(0, BOT);
      if (isFront) {
        for (let x = 0; x <= w; x += 6) c.lineTo(x, terr.shoreY(x));
        c.lineTo(w, BOT);
      } else {
        const endX = terr.xShore;
        for (let x = 0; x <= endX; x += R.step) c.lineTo(x, Math.min(R.f(x), terr.plainBase(x)));
        c.lineTo(endX, BOT);
      }
      c.closePath();
      const lit = mix(R.lit, hazeCol, R.haze),
        shade = mix(R.shade, hazeCol, R.haze);
      const g = c.createLinearGradient(0, groundY - 300, 0, sceneH);
      g.addColorStop(0, rgb(lit));
      g.addColorStop(0.42, rgb(mix(lit, shade, 0.55)));
      g.addColorStop(1, rgb(mix(shade, dark ? [12, 18, 25] : [46, 30, 18], 0.6)));
      c.fillStyle = g;
      c.fill();

      c.save();
      c.clip();
      const S = 3;
      /*  The engine runs these fills to the bottom of the document, where
          they read as a broad tint on the whole land body. Here the land
          continues into an SVG below the texture, so each run is faded out
          over its own depth instead — same shading, no visible seam. */
      const shadeRun = (sign, col, depth) => {
        let run = null;
        const flush = () => {
          if (!run || run.pts.length < 2) {
            run = null;
            return;
          }
          const y0 = Math.min.apply(
            null,
            run.pts.map((q) => q[1]),
          );
          c.beginPath();
          c.moveTo(run.pts[0][0], run.pts[0][1]);
          for (let i = 1; i < run.pts.length; i++) c.lineTo(run.pts[i][0], run.pts[i][1]);
          for (let i = run.pts.length - 1; i >= 0; i--)
            c.lineTo(run.pts[i][0], run.pts[i][1] + depth);
          c.closePath();
          const gr = c.createLinearGradient(0, y0, 0, y0 + depth);
          gr.addColorStop(0, col(run.k));
          gr.addColorStop(0.42, col(run.k));
          gr.addColorStop(1, col(0));
          c.fillStyle = gr;
          c.fill();
          run = null;
        };
        for (let x = 0; x <= coastX; x += S) {
          const y0 = R.f(x),
            y1 = R.f(x + S),
            slope = (y1 - y0) / S;
          const k = clamp(slope * 1.1, -1, 1) * sign;
          if (k > 0.04) {
            if (!run) run = { pts: [], k: 0 };
            run.pts.push([x, y0]);
            run.k = Math.max(run.k, k);
          } else flush();
        }
        flush();
      };
      shadeRun(1, (k) => `rgba(20,12,6,${k > 0 ? 0.035 + k * 0.125 : 0})`, 250);
      shadeRun(-1, (k) => `rgba(255,236,206,${k * 0.09})`, 150);

      /* glacier caps: thicker snow with blue ice beneath */
      let cap = null;
      const flushCap = () => {
        if (!cap || cap.pts.length < 2) {
          cap = null;
          return;
        }
        c.beginPath();
        c.moveTo(cap.pts[0][0], cap.pts[0][1]);
        for (let i = 1; i < cap.pts.length; i++) c.lineTo(cap.pts[i][0], cap.pts[i][1]);
        for (let i = cap.pts.length - 1; i >= 0; i--) c.lineTo(cap.pts[i][0], cap.pts[i][2]);
        c.closePath();
        c.fillStyle = `rgba(250,251,252,${cap.a * 0.85})`;
        c.fill();
        cap = null;
      };
      for (let x = 0; x <= coastX; x += S) {
        const y = R.f(x),
          alt = seaY - y;
        if (alt < R.snow) {
          flushCap();
          continue;
        }
        const depth = Math.min(1, (alt - R.snow) / 70);
        const slope = Math.abs((R.f(x + S) - y) / S);
        const a = Math.min(
          1,
          depth * (1 - R.haze * 0.8) * Math.max(0.2, 1 - slope * 0.8) * (R.snowGain || 1),
        );
        if (!cap) cap = { pts: [], a: 0 };
        cap.pts.push([x, y, y + 6 + depth * 34]);
        cap.a = Math.max(cap.a, a);
      }
      flushCap();
      c.strokeStyle = `rgba(150,190,215,${0.22 * (1 - R.haze)})`;
      c.lineWidth = 1;
      for (let x = 0; x <= coastX; x += S * 3) {
        const y = R.f(x),
          alt = seaY - y;
        if (alt < R.snow + 20) continue;
        c.beginPath();
        c.moveTo(x, y + 8);
        c.lineTo(x + 4, y + 20);
        c.stroke();
      }
      c.restore();

      c.strokeStyle = `rgba(255,240,214,${0.16 * (1 - R.haze)})`;
      c.lineWidth = 1.2;
      c.beginPath();
      const edgeF = isFront ? terr.shoreY : R.f;
      const strokeEnd = isFront ? terr.xShore : coastX;
      for (let x = 0; x <= strokeEnd; x += R.step)
        x === 0 ? c.moveTo(x, edgeF(x)) : c.lineTo(x, edgeF(x));
      c.stroke();

      if (R.haze > 0) {
        const vh = c.createLinearGradient(0, groundY - 190, 0, groundY + 20);
        vh.addColorStop(0, `rgba(${hazeCol.join(",")},0)`);
        vh.addColorStop(0.75, `rgba(${hazeCol.join(",")},${0.13 * R.haze})`);
        vh.addColorStop(1, `rgba(${hazeCol.join(",")},${0.2 * R.haze})`);
        c.fillStyle = vh;
        c.fillRect(0, groundY - 190, terr.beachStartX, 210);
      }
    }
  };
  drop(
    holder,
    bake(w, CH, 0, 0, (c) => paint(c, NIGHT), 1),
    "",
  );
  return { TOP, BOT };
}

/* ====================================================================
   THE SOLID EARTH below the ranges and under the sea, continuing the
   range's own colour downward so the two meet without a seam.
   ==================================================================== */
function buildEarth(root, terr) {
  const { w, groundY, sceneH } = G;
  const svg = svgLayer(root, w, sceneH, "");
  svg.style.zIndex = 13;
  const defs = sv("defs", {}, svg);
  const bed = [];
  for (let i = 0; i <= 320; i++) {
    const x = -w * 0.02 + w * 1.04 * (i / 320);
    bed.push([x, terr.bedY(x)]);
  }
  const dBed = curve(bed) + `L${f2(w * 1.04)} ${f2(sceneH)} L${f2(-w * 0.02)} ${f2(sceneH)} Z`;
  THEMES().forEach((th) => {
    const dark = th === "night";
    const P = terr.ranges[2];
    const g = sv("g", { class: "" }, svg);
    const id = th + "earth";
    const lg = sv(
      "linearGradient",
      {
        id,
        x1: "0",
        y1: f2(groundY - 300),
        x2: "0",
        y2: f2(sceneH),
        gradientUnits: "userSpaceOnUse",
      },
      defs,
    );
    const hz = HAZECOL(dark);
    const lit = mix(P.lit, hz, P.haze),
      shade = mix(P.shade, hz, P.haze);
    sv("stop", { offset: "0", "stop-color": rgb(lit) }, lg);
    sv("stop", { offset: "0.42", "stop-color": rgb(mix(lit, shade, 0.55)) }, lg);
    sv(
      "stop",
      { offset: "1", "stop-color": rgb(mix(shade, dark ? [12, 18, 25] : [46, 30, 18], 0.6)) },
      lg,
    );
    sv("path", { d: dBed, fill: `url(#${id})` }, g);
    /* sediment bedding, following the surface it was laid down on */
    const cid = "bc" + th;
    const cp = sv("clipPath", { id: cid }, defs);
    sv("path", { d: dBed }, cp);
    const sg = sv("g", { "clip-path": `url(#${cid})` }, g);
    for (let i = 1; i <= 10; i++) {
      const off = i * ((sceneH - groundY) * 0.055) + i * i * 3.0;
      const p = bed.map((pt) => [
        pt[0],
        pt[1] + off + 11 * Math.sin(pt[0] * 0.0082 + i * 1.3) + 5 * Math.sin(pt[0] * 0.02 + i),
      ]);
      sv(
        "path",
        {
          d: curve(p),
          fill: "none",
          stroke: dark ? "rgba(206,186,156,0.13)" : "rgba(84,66,44,0.15)",
          "stroke-width": i % 3 === 1 ? 1.1 : 0.75,
          "stroke-opacity": f2(Math.max(0.3, 1 - i * 0.06)),
        },
        sg,
      );
    }
    /* the crisp seafloor edge the engine draws over the continuous coast */
    const edge = [];
    for (let x = terr.xShore; x <= w; x += 6) edge.push([x, terr.bedY(x)]);
    sv(
      "path",
      {
        d: curve(edge),
        fill: "none",
        stroke: dark ? "rgba(150,182,204,0.42)" : "rgba(26,42,56,0.5)",
        "stroke-width": 1.2,
      },
      g,
    );

    /* ------------------------------------------------------------------
       THE BASEMENT: the solid earth, continued to the bottom of whatever
       the scene root turns out to be.

       The story is solved ONCE, against the host's height at the moment it
       is built, and a change of height deliberately never re-solves it - a
       background that re-composes itself because a widget in front of it
       opened is the two of them wired together by a number neither meant to
       share. But the page can still GROW after that: a live dataset tree's
       listing arrives, an image settles, a panel opens. The root stretches
       with it, every layer inside it has a pixel height, and the run below
       the last of them showed the shell's own fallback gradient - measured
       at 1,428 px of empty sky under the seafloor on a Waterpark landing
       that grew by that much after mounting.

       Continuing the ground is not a patch over that, it is what is
       actually down there: the seabed at maximum depth sits about seven
       pixels above `oceanBot` and the story ends twenty-six below it, so
       at the bottom edge the whole width is already solid earth. This
       carries the earth gradient's own final colour on, and because it is
       pinned to the root's BOTTOM rather than given a height it fills
       whatever the page becomes without anything being rebuilt.

       IT KEEPS THE BEDDING. A slab of one colour is a different kind of
       emptiness from a slab of sky, and at night the earth's final tone is
       nearly black, so without the bedding planes carrying on this read as
       a void again. They continue at the spacing the deepest of the drawn
       ones had - the drawn set widens with depth, and by the tenth it is
       about an eighth of the ocean band apart - and the tone darkens by
       only a little over the first two screens, because the gradient above
       it has already spent most of its range.
       ------------------------------------------------------------------ */
    const floor0 = mix(shade, dark ? [12, 18, 25] : [46, 30, 18], 0.6);
    const floor1 = mix(floor0, dark ? [8, 10, 14] : [30, 20, 12], 0.25);
    const bedGap = Math.max(64, Math.round((sceneH - groundY) * 0.12));
    const bedInk = dark ? "rgba(206,186,156,0.10)" : "rgba(84,66,44,0.12)";
    el(
      "div",
      "lyr",
      root,
      `top:${f2(sceneH - 1)}px;bottom:0;z-index:13;` +
        `background-image:repeating-linear-gradient(180deg,` +
        `rgba(0,0,0,0) 0,rgba(0,0,0,0) ${bedGap - 1}px,${bedInk} ${bedGap - 1}px,${bedInk} ${bedGap}px),` +
        `linear-gradient(180deg,${rgb(floor0)} 0px,${rgb(floor1)} 1200px)`,
    );
  });
}

/* ====================================================================
   SANDY STRAND + SWASH — a thin sediment veneer over the beach and the
   inner shelf, with a foam tongue running up and back down it.
   ==================================================================== */
function buildStrand(root, terr) {
  const { w, groundY, coastX } = G;
  const bx0 = terr.beachStartX - w * 0.03,
    bx1 = Math.min(w - 2, coastX + (w - coastX) * 0.44);
  const thick = (x) => {
    const fade =
      x < terr.beachStartX
        ? Math.max(0, 1 - (terr.beachStartX - x) / (w * 0.05))
        : Math.max(0, 1 - (x - terr.rampEndX) / (bx1 - terr.rampEndX || 1));
    return 11 * clamp(fade, 0, 1);
  };
  const TOP = Math.min(terr.bedY(bx0), groundY) - 26,
    BOT = terr.bedY(bx1) + 30;
  const LEFT = bx0 - 12,
    CWID = bx1 - bx0 + 24;
  const lyr = el("div", "lyr", root, `top:${f2(TOP)}px;height:${f2(BOT - TOP)}px;z-index:16`);
  const holder = el("div", "", lyr, `position:absolute;left:${f2(LEFT)}px;top:0;width:0;height:0`);
  const paint = (c, dark) => {
    c.translate(-LEFT, -TOP);
    c.beginPath();
    c.moveTo(bx0, terr.bedY(bx0));
    for (let x = bx0; x <= bx1; x += 3) c.lineTo(x, terr.bedY(x));
    c.lineTo(bx1, terr.bedY(bx1) + thick(bx1));
    for (let x = bx1; x >= bx0; x -= 3) c.lineTo(x, terr.bedY(x) + thick(x));
    c.closePath();
    const span = Math.max(1, bx1 - bx0);
    const f0 = clamp((terr.xShore - w * 0.05 - bx0) / span, 0, 1);
    const f1 = clamp(Math.max(f0 + 0.002, (terr.xShore - bx0) / span), 0, 1);
    const dry = dark ? "178,160,120" : "246,232,192";
    const wet = dark ? "120,106,76" : "184,172,136";
    const sg = c.createLinearGradient(bx0, 0, bx1, 0);
    sg.addColorStop(0, `rgba(${dry},0.98)`);
    sg.addColorStop(f0, `rgba(${dry},0.98)`);
    sg.addColorStop(f1, `rgba(${wet},0.97)`);
    sg.addColorStop(1, `rgba(${wet},0.97)`);
    c.fillStyle = sg;
    c.fill();
    c.strokeStyle = dark ? "rgba(70,62,46,0.42)" : "rgba(150,136,100,0.5)";
    c.lineWidth = 0.9;
    c.beginPath();
    for (let x = bx0; x <= bx1; x += 3) {
      const yy = terr.bedY(x) + thick(x);
      x === bx0 ? c.moveTo(x, yy) : c.lineTo(x, yy);
    }
    c.stroke();
    c.strokeStyle = dark ? "rgba(206,188,144,0.6)" : "rgba(255,246,220,0.85)";
    c.lineWidth = 1.1;
    c.beginPath();
    for (let x = bx0; x <= bx1; x += 3)
      x === bx0 ? c.moveTo(x, terr.bedY(x)) : c.lineTo(x, terr.bedY(x));
    c.stroke();
  };
  drop(
    holder,
    bake(CWID, BOT - TOP, 0, 0, (c) => paint(c, NIGHT), 1.25),
    "",
  );

  /* The swash is gone. A foam tongue ran up the sand and back down on a
     9.8-second cycle, animating its own opacity as well as its position -
     the only animated element on the beach, and not one of the three sea
     waves, which are untouched. */
}

/* ====================================================================
   THE LAND'S INSTRUMENTS ARE GONE, and this builder with them. The weather
   station, the C-band radar and its radome, and the aerosol lidar were all
   it ever drew, and none is a retained subject. The `surface` stage is
   still named and still observed - `buildZones` draws its strip - and what
   is left of the land is its contours and its ranges, which are static and
   are drawn by `buildEarth` and `buildMountains`.
   ==================================================================== */

/* ====================================================================
   OCEAN — water column, thermal structure, restrained isopycnals, and
   a surface built from three wave periods that loop independently.
   ==================================================================== */
const OCN = {
  Tsurf: (u) => 13.6 + 4.6 * u,
  Tdeep: 2.6,
  mld: (u) => 44 + 32 * Math.sin(u * 4.1 + 0.6),
  scale: (u) => 205 + 265 * u,
  T: function (u, d) {
    const m = this.mld(u),
      ts = this.Tsurf(u);
    return d <= m ? ts : this.Tdeep + (ts - this.Tdeep) * Math.exp(-(d - m) / this.scale(u));
  },
  depthOf: function (u, V) {
    const ts = this.Tsurf(u);
    if (V >= ts || V <= this.Tdeep + 0.05) return null;
    return this.mld(u) + this.scale(u) * Math.log((ts - this.Tdeep) / (V - this.Tdeep));
  },
  /* in-section current: an eastward surface flow over a weaker westward
     undercurrent — the field the drifting markers sample */
};

function buildOcean(root, terr) {
  const { w, groundY, oceanBot, sceneH, coastX } = G;
  const x0 = terr.xShore,
    span = Math.max(1, w - x0);
  const uOf = (x) => clamp((x - coastX) / (w - coastX), 0, 1);
  const svg = svgLayer(root, w, sceneH, "");
  svg.style.zIndex = 15;
  const defs = sv("defs", {}, svg);
  const bedp = [];
  for (let i = 0; i <= 150; i++) {
    const x = x0 + span * (i / 150);
    bedp.push([x, terr.bedY(x)]);
  }
  const dWater =
    "M" +
    f2(x0) +
    " " +
    f2(groundY) +
    "L" +
    f2(w + 4) +
    " " +
    f2(groundY) +
    "L" +
    f2(w + 4) +
    " " +
    f2(terr.bedY(w)) +
    curve(bedp.slice().reverse()).replace(/^M[^C]*/, "") +
    "Z";
  const cp = sv("clipPath", { id: "wclip" }, defs);
  sv("path", { d: dWater }, cp);
  /* NO separate sediment body here. The engine draws one, and then the
     front range — which fills from the SEABED down across the whole width
     — paints straight over it, so the solid earth reads as one continuous
     mass from the summits to the abyssal plain. Measured against the
     source: land (77,58,40) inshore, (84,63,43) under the seabed. Drawing
     the sediment on top put a hard vertical colour step at the waterline.
     Only the crisp seabed edge, which the engine draws separately over the
     continuous coast, is kept. */
  THEMES().forEach((th) => {
    const dark = th === "night";
    const g = sv("g", { class: "" }, svg);
    const edge = [];
    for (let x = terr.xShore; x <= w; x += 6) edge.push([x, terr.bedY(x)]);
    sv(
      "path",
      {
        d: curve(edge),
        fill: "none",
        stroke: dark ? "rgba(120,150,170,0.4)" : "rgba(40,60,75,0.5)",
        "stroke-width": 1.2,
      },
      g,
    );
  });
  const wg = sv("g", { "clip-path": "url(#wclip)" }, svg);

  THEMES().forEach((th) => {
    const dark = th === "night";
    const g = sv("g", { class: "" }, wg);
    const gid = th + "water";
    const lg = sv(
      "linearGradient",
      {
        id: gid,
        x1: "0",
        y1: f2(groundY),
        x2: "0",
        y2: f2(oceanBot),
        gradientUnits: "userSpaceOnUse",
      },
      defs,
    );
    for (let i = 0; i <= 14; i++)
      sv(
        "stop",
        {
          offset: (i / 14).toFixed(3),
          "stop-color": tempColour(OCN.T(0.55, (i / 14) * terr.maxDepth), dark),
        },
        lg,
      );
    sv(
      "rect",
      {
        x: f2(x0 - 2),
        y: f2(groundY),
        width: f2(span + 8),
        height: f2(oceanBot - groundY + 6),
        fill: `url(#${gid})`,
      },
      g,
    );
    const cgid = th + "coast";
    const cg = sv(
      "linearGradient",
      {
        id: cgid,
        x1: f2(x0),
        y1: "0",
        x2: f2(x0 + span * 0.55),
        y2: "0",
        gradientUnits: "userSpaceOnUse",
      },
      defs,
    );
    sv(
      "stop",
      { offset: "0", "stop-color": dark ? "#04121d" : "#0d4a68", "stop-opacity": ".40" },
      cg,
    );
    sv(
      "stop",
      { offset: "1", "stop-color": dark ? "#04121d" : "#0d4a68", "stop-opacity": "0" },
      cg,
    );
    sv(
      "rect",
      {
        x: f2(x0 - 2),
        y: f2(groundY),
        width: f2(span + 8),
        height: f2(oceanBot - groundY + 6),
        fill: `url(#${cgid})`,
      },
      g,
    );
    /* isotherms and three dashed isopycnals, traced once */
    const isoG = sv("g", { fill: "none", "stroke-linecap": "round" }, g);
    const trace = (V, dy) => {
      const pts = [];
      for (let i = 0; i <= 90; i++) {
        const x = x0 + span * (i / 90),
          d = OCN.depthOf(uOf(x), V);
        if (d === null) continue;
        const y = terr.depthToY(d) + (dy || 0);
        if (y > terr.bedY(x) - 3) continue;
        pts.push([x, y]);
      }
      return pts.length > 3 ? curve(pts) : null;
    };
    [16, 14, 12, 10, 8, 6, 4].forEach((V) => {
      const d = trace(V);
      if (!d) return;
      sv(
        "path",
        {
          d,
          stroke: dark ? "rgba(150,206,214,0.34)" : "rgba(8,62,84,0.40)",
          "stroke-width": V % 4 === 0 ? 1.0 : 0.7,
        },
        isoG,
      );
    });
    /* potential-density contours: the engine's amber, heavy every 1.0 */
    [
      [27.0, true],
      [26.6, false],
      [26.2, false],
      [25.8, false],
    ].forEach(([S0, heavy]) => {
      const Tv = OCN.Tdeep + (27.85 - S0) / 0.205;
      const pts = [];
      for (let i = 0; i <= 90; i++) {
        const x = x0 + span * (i / 90),
          d = OCN.depthOf(uOf(x), Tv);
        if (d === null) continue;
        const y = terr.depthToY(d);
        if (y > terr.bedY(x) - 10 || y < groundY + 6) continue;
        pts.push([x, y]);
      }
      if (pts.length < 4) return;
      sv(
        "path",
        {
          d: curve(pts),
          fill: "none",
          "stroke-linecap": "butt",
          "stroke-linejoin": "round",
          stroke: heavy
            ? dark
              ? "rgba(248,232,190,0.78)"
              : "rgba(250,244,226,0.86)"
            : dark
              ? "rgba(238,222,186,0.34)"
              : "rgba(244,240,224,0.42)",
          "stroke-width": heavy ? 1.25 : 0.85,
        },
        isoG,
      );
      if (heavy) {
        const q = pts[Math.round(pts.length * 0.62)];
        if (q && q[0] > x0 + 40 && q[0] < w - 46) {
          sv(
            "rect",
            {
              x: f2(q[0] - 2),
              y: f2(q[1] - 7),
              width: 26,
              height: 14,
              fill: dark ? "rgba(6,22,36,0.55)" : "rgba(10,40,64,0.42)",
            },
            isoG,
          );
          const t3 = sv(
            "text",
            {
              x: f2(q[0] + 1),
              y: f2(q[1] + 3.5),
              "font-size": 9,
              fill: dark ? "rgba(252,240,208,0.95)" : "rgba(255,250,236,0.96)",
              "font-family": "'IBM Plex Mono',ui-monospace,monospace",
            },
            isoG,
          );
          t3.textContent = S0.toFixed(1);
        }
      }
    });
    /* depth axis: dashed every 250 m across the section, labelled every
       500 m against the right-hand edge, where the water is deep */
    const ax = sv("g", {}, g);
    for (let m = 250; m <= 4000; m += 250) {
      const y = terr.depthToY(m);
      if (y > oceanBot) continue;
      const major = m % 1000 === 0,
        mid = m % 500 === 0;
      sv(
        "line",
        {
          x1: f2(x0),
          y1: f2(y + 0.5),
          x2: f2(w),
          y2: f2(y + 0.5),
          stroke: major
            ? "rgba(232,244,252,0.30)"
            : mid
              ? "rgba(232,244,252,0.16)"
              : "rgba(232,244,252,0.08)",
          "stroke-width": major ? 1 : 0.7,
          "stroke-dasharray": "2 5",
        },
        ax,
      );
      if (!mid) continue;
      const txt = m + " m",
        tw = txt.length * (major ? 6.6 : 5.7) + 12,
        rx = w - 14;
      sv(
        "rect",
        {
          x: f2(rx - tw),
          y: f2(y - 8),
          width: f2(tw),
          height: 16,
          fill: major ? "rgba(9,28,44,0.34)" : "rgba(9,28,44,0.22)",
        },
        ax,
      );
      sv(
        "line",
        {
          x1: f2(rx),
          y1: f2(y - 8),
          x2: f2(rx),
          y2: f2(y + 8),
          stroke: major ? "rgba(120,210,225,0.7)" : "rgba(120,210,225,0.38)",
          "stroke-width": 1,
        },
        ax,
      );
      const t4 = sv(
        "text",
        {
          x: f2(rx - 6),
          y: f2(y + 3.5),
          "text-anchor": "end",
          "font-size": major ? 11 : 9.5,
          "font-weight": major ? 500 : 400,
          fill: major ? "rgba(240,250,255,0.98)" : "rgba(216,236,246,0.92)",
          "font-family": "'IBM Plex Mono',ui-monospace,monospace",
        },
        ax,
      );
      t4.textContent = txt;
    }
  });

  /* ---- the light shafts are gone -----------------------------------
     Seven sun shafts through the mixed layer, baked into one sheet and
     swayed as one on a 19-second cycle. The sheet was 810 x 169 px - the
     largest animated surface left below the waterline - drawn at fourteen
     per cent alpha at night and clipped to the water, which is to say it
     was barely visible and expensive in exactly the proportion that makes
     a thing not worth keeping. Removed with its artwork, its holder, its
     sway and the seeded shaft geometry that fed it. ------------------- */

  /* ---- the sea surface: ONE band, and it heaves rather than travels ----
     The brief asks for a thin surface band and the iceberg to move up and down TOGETHER, so the
     three horizontally-scrolling wave periods become one band with a vertical heave, and the berg
     is given the identical keyframe.

     WHAT IS KEPT. The band is still drawn from the engine's own three wavenumbers - 0.022, 0.075
     and 0.18 rad/px - summed into a single profile instead of three sliding strips, with the same
     foam highlight, the same shadow three pixels under it and the same crest glints. So the water
     still looks like that water; it is one surface rather than three, and it no longer slides.

     WHY THE BAND AND NOT THE OCEAN. The heave is on a strip `SURF_H` tall pinned at the waterline,
     which is the only thing that has to move. The ocean body, its isotherms, its depth axis and
     the seabed are a separate static layer and are not touched - moving the water column to move
     its surface is exactly the full-height animated wrapper the brief rules out.

     CONTACT WITH THE ICE. The waterline is now a POSITION rather than a shared period: the band is
     drawn at its rest height and `buildFloats` stands the berg on the same `groundY`, so the two
     are aligned by construction instead of by sharing a keyframe. ---------------------------- */
  const waveTop = groundY - 16,
    waveH = 34;
  /*
   * NO CLEARANCE FOR A SWELL THAT IS NOT THERE.
   *
   * The clip box used to be `SEA_AMP` taller at each edge and the strip inset by that much, so the
   * band could rise and fall inside it without its ends appearing. Still, the box is the band.
   */
  const wl = el(
    "div",
    "lyr clip",
    root,
    `left:${f2(x0)}px;top:${f2(waveTop)}px;width:${f2(span)}px;` +
      `height:${f2(waveH)}px;z-index:16`,
  );
  {
    const strip = el(
      "div",
      "",
      wl,
      `position:absolute;left:0;top:0;width:${f2(span)}px;height:${f2(waveH)}px`,
    );
    const s = svgLayer(strip, span, waveH, "");
    s.style.cssText = `position:absolute;left:0;top:0;width:${f2(span)}px;height:${f2(waveH)}px`;
    const PROFILE = [
      [285.6, 4.6],
      [83.8, 2.4],
      [34.9, 1.1],
    ];
    const yAt = (x) =>
      16 + PROFILE.reduce((a, [period, amp]) => a + amp * Math.sin((2 * Math.PI * x) / period), 0);
    const pts = [];
    const n = Math.max(90, Math.round(span / 4));
    for (let j = 0; j <= n; j++) {
      const x = span * (j / n);
      pts.push([x, yAt(x)]);
    }
    const d = curve(pts);
    THEMES().forEach((th) => {
      const dark = th === "night";
      const g = sv("g", { class: "" }, s);
      sv(
        "path",
        {
          d: d + `L${f2(span)} ${waveH} L0 ${waveH} Z`,
          fill: dark ? "rgba(10,40,58,0.34)" : "rgba(120,178,196,0.28)",
        },
        g,
      );
      sv(
        "path",
        {
          d,
          fill: "none",
          stroke: dark ? "rgba(176,214,228,0.62)" : "rgba(255,255,255,0.62)",
          "stroke-width": 1.5,
          "stroke-linecap": "round",
        },
        g,
      );
      /* the engine's foam highlight, its shadow three pixels under it, and crest glints */
      sv(
        "path",
        {
          d,
          fill: "none",
          transform: "translate(0,-0.5)",
          stroke: dark ? "rgba(184,222,242,0.5)" : "rgba(255,255,255,0.7)",
          "stroke-width": 1.4,
        },
        g,
      );
      sv(
        "path",
        {
          d,
          fill: "none",
          transform: "translate(0,3)",
          stroke: dark ? "rgba(70,120,150,0.3)" : "rgba(90,132,162,0.32)",
          "stroke-width": 1.1,
        },
        g,
      );
      const glint = sv("g", { fill: dark ? "rgba(200,232,248,0.5)" : "rgba(255,255,255,0.7)" }, g);
      for (let gx = 0; gx < span; gx += 46) {
        if (Math.sin((2 * Math.PI * gx) / 285.6) <= 0.6) continue;
        sv("rect", { x: f2(gx), y: f2(yAt(gx) - 0.5), width: 7, height: 1.2 }, glint);
      }
    });
  }
  /* The current markers are gone - see the note where `buildCurrents` was. */
}

/* ====================================================================
   THE CURRENT MARKERS ARE GONE

   Fifteen arrows sampled the in-section flow at their own depths and
   drifted with it, gathered into a handful of sets so that one animation
   carried several arrows. Three sets survived into v005; each animated a
   translation AND an opacity fade over its life, on a composited layer,
   and between them they were most of what was still moving below the
   waterline.

   Removed entirely: the sets, their baked arrow sheets, the sampling that
   placed them and the `arrow()` builder that drew them. The ocean's own
   contours, its thermocline and its depth axis are untouched - they never
   moved. Nothing replaces them.
   ==================================================================== */

/* ====================================================================
   SURFACE OBJECTS — the engine's own packing: the vessel and the ice
   station's berg always win a slot, and the optional ones drop out when
   the ocean is too narrow rather than everything shrinking to confetti.
   ==================================================================== */
function buildFloats(root, terr) {
  const { w, groundY, SZ, shipS, buoyS, sceneH } = G;
  const lyr = el("div", "lyr", root, `height:${f2(sceneH)}px;z-index:19`);
  const bergScl = { L: 1.4 * SZ, S: 0.82 * SZ, T: 0.6 * SZ };
  const bergHW = (sc) => 34 * sc * 1.75;
  const GAP = 20,
    leftEdge = terr.xShore + 34,
    rightEdge = w - 6;
  const available = Math.max(80, rightEdge - leftEdge);
  const candidates = [
    /*
     * THE ICE STATION IS ACCEPTED FIRST, and that is the one number changed here.
     *
     * The solver takes candidates in priority order and stops when the next one will not fit. The
     * source put the vessel first, which was right when the vessel was drawn - but it is not, and a
     * float that is solved for and never built still reserves its width. On a 390 px viewport the
     * ocean is 222 px wide, the vessel's half-width alone is 78, and the berg was refused for room
     * taken by a ship nobody can see. The iceberg is a retained subject; it must not be the thing
     * that drops out on a phone.
     *
     * Swapping the two priorities is enough, and it is enough precisely because it changes nothing
     * else: the candidate list, every half-width, the gap and the spacing maths are the source's.
     * Where all six fit - every desktop width - the accepted SET is the same set, `floats` is sorted
     * by `u` afterwards, and the ice station lands on the same x it always did. Where they do not,
     * the vessel is refused instead of the ice.
     */
    { k: "bergL", u: 0.8, hw: bergHW(bergScl.L), pri: 0 },
    { k: "ship", u: 0.0, hw: 50 * shipS, pri: 1 },
    { k: "buoyA", u: 0.3, hw: 13 * buoyS, pri: 2 },
    { k: "bergS", u: 0.55, hw: bergHW(bergScl.S), pri: 3 },
    { k: "buoyB", u: 0.42, hw: 13 * buoyS, pri: 4 },
    { k: "bergT", u: 1.0, hw: bergHW(bergScl.T), pri: 5 },
  ];
  const width = (l) => l.reduce((a, o) => a + 2 * o.hw, 0) + Math.max(0, l.length - 1) * GAP;
  let floats = [];
  for (const c of candidates.slice().sort((a, b) => a.pri - b.pri)) {
    const test = floats.concat([c]);
    if (width(test) <= available) floats = test;
  }
  floats.sort((a, b) => a.u - b.u);
  const extra = Math.max(0, available - width(floats));
  const uSpan = floats.length > 1 ? floats[floats.length - 1].u - floats[0].u || 1 : 1;
  let cursor = leftEdge + extra * 0.12 + (floats[0] ? floats[0].hw : 0);
  if (floats[0]) floats[0].x = cursor;
  for (let i = 1; i < floats.length; i++) {
    cursor +=
      floats[i - 1].hw +
      GAP +
      (extra * 0.88 * (floats[i].u - floats[i - 1].u)) / uSpan +
      floats[i].hw;
    floats[i].x = cursor;
  }
  const at = (k) => {
    const o = floats.find((f) => f.k === k);
    return o ? o.x : null;
  };
  /*
   * THE PACKING IS SOLVED FOR SIX AND BUILT FOR THREE.
   *
   * Four of the six floats are gone - the unlabelled second buoy and the two
   * decorative bergs - but the candidate list, the priority order and the
   * spacing solver above are untouched, deliberately. That solver distributes
   * the leftover width across whatever it accepted, so dropping entries from
   * it would re-space the ones that stay: the vessel, the labelled buoy and
   * the ice station would all slide, and the vessel's position is one of the
   * things this round was told to keep. So the solve is the same solve, and
   * what changed is that three of its answers are no longer drawn.
   */

  /*
   * THE BUOY AND THE RESEARCH VESSEL ARE GONE.
   *
   * Neither is a retained subject, so both are removed outright rather than stilled: the buoy's
   * body, its mooring line, its lamp and its bob; the vessel's hull, its label and its heave. The
   * packing solver above is untouched - it still solves the same slots in the same order - so the
   * ICE STATION stands exactly where it stood when the floats were laid out together. Removing a
   * candidate from the solver would have re-spaced it, which is the one thing that would move the
   * only float that stays.
   */

  /* ---------- icebergs ---------- */
  const srand = (s) => {
    const x = Math.sin(s * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  };
  const berg = (cx, scl, station, seed, tag) => {
    if (cx == null) return;
    const topH = 48 * scl,
      halfTop = 34 * scl,
      keelH = topH * 2.3;
    const jag = (k) => srand(seed * 3.1 + k * 1.7);
    /* sail profile: fracture facets, not a smooth hump */
    const topPts = [];
    let peakX = 0,
      peakY = 0;
    {
      const n = 9;
      let hh = topH * (0.1 + 0.1 * jag(0));
      for (let k = 0; k <= n; k++) {
        const u = k / n,
          fx = -halfTop + u * halfTop * 2;
        const summit = -0.35 + 0.7 * jag(1);
        const env = Math.pow(Math.max(0, 1 - Math.abs(u * 2 - 1 - summit) / 1.15), 0.75);
        const target = topH * (0.22 + 0.78 * env) * (0.8 + 0.26 * jag(k + 10));
        if (jag(k + 20) > 0.72) topPts.push([fx, -hh]);
        hh = Math.max(topH * 0.12, target);
        topPts.push([fx, -hh]);
        if (hh > peakY) {
          peakY = hh;
          peakX = fx;
        }
      }
    }
    const ramL = -halfTop * (1.2 + 0.35 * jag(31)),
      ramR = halfTop * (1.15 + 0.4 * jag(32)),
      ramD = topH * 0.16;
    const keelL = [
      [-halfTop * (1.26 + 0.34 * jag(1)), keelH * 0.2],
      [-halfTop * (1.42 + 0.3 * jag(2)), keelH * 0.34],
      [-halfTop * (1.02 + 0.34 * jag(3)), keelH * 0.62],
      [-halfTop * (0.96 + 0.2 * jag(11)), keelH * 0.78],
      [-halfTop * (0.4 + 0.26 * jag(4)), keelH * 0.95],
      [halfTop * (0.16 + 0.26 * jag(5)), keelH * 1.0],
      [halfTop * (0.7 + 0.3 * jag(12)), keelH * 0.9],
      [halfTop * (0.82 + 0.4 * jag(6)), keelH * 0.7],
      [halfTop * (1.3 + 0.36 * jag(7)), keelH * 0.44],
      [halfTop * (1.14 + 0.3 * jag(8)), keelH * 0.22],
    ];
    const CW = halfTop * 5.6,
      CH = topH * 1.6 + keelH * 1.06;
    const OX = CW / 2,
      OY = topH * 1.45;

    const paint = (c, dark) => {
      const keelPath = () => {
        c.beginPath();
        c.moveTo(-halfTop * 0.98, 0);
        c.lineTo(ramL, ramD * 0.5);
        for (const [px, py] of keelL) c.lineTo(px, py);
        c.lineTo(ramR, ramD * 0.5);
        c.lineTo(halfTop * 1.02, 0);
        c.closePath();
      };
      /* submerged mass */
      keelPath();
      const uw = c.createLinearGradient(0, 0, 0, keelH);
      if (dark) {
        uw.addColorStop(0, "rgba(176,232,246,0.78)");
        uw.addColorStop(0.3, "rgba(132,206,232,0.60)");
        uw.addColorStop(0.7, "rgba(96,170,200,0.42)");
        uw.addColorStop(1, "rgba(74,140,172,0.24)");
      } else {
        uw.addColorStop(0, "rgba(214,246,254,0.90)");
        uw.addColorStop(0.3, "rgba(168,228,246,0.72)");
        uw.addColorStop(0.7, "rgba(124,196,226,0.50)");
        uw.addColorStop(1, "rgba(98,170,204,0.30)");
      }
      c.fillStyle = uw;
      c.fill();
      c.save();
      keelPath();
      c.clip();
      c.strokeStyle = dark ? "rgba(212,244,252,0.20)" : "rgba(255,255,255,0.34)";
      c.lineWidth = 1.1;
      for (let k = 0; k < 4; k++) {
        const y0 = keelH * (0.12 + 0.22 * k + 0.06 * jag(k + 50));
        c.beginPath();
        c.moveTo(-halfTop * 2, y0);
        c.lineTo(halfTop * 2, y0 + keelH * (0.05 + 0.06 * jag(k + 55)));
        c.stroke();
      }
      c.restore();
      const eg = c.createLinearGradient(0, 0, 0, keelH);
      eg.addColorStop(0, dark ? "rgba(212,246,254,0.72)" : "rgba(246,254,255,0.88)");
      eg.addColorStop(0.35, dark ? "rgba(190,232,246,0.34)" : "rgba(226,248,254,0.44)");
      eg.addColorStop(1, "rgba(200,236,250,0)");
      keelPath();
      c.strokeStyle = eg;
      c.lineWidth = 1.3;
      c.stroke();
      /* sail */
      const topPath = () => {
        c.beginPath();
        c.moveTo(-halfTop, 0);
        for (const [px, py] of topPts) c.lineTo(px, py);
        c.lineTo(halfTop, 0);
        c.closePath();
      };
      topPath();
      const tg = c.createLinearGradient(0, -topH, 0, 3);
      tg.addColorStop(0, "#ffffff");
      tg.addColorStop(0.5, dark ? "#e6f4fb" : "#f6fcfe");
      tg.addColorStop(1, dark ? "#b7dbe9" : "#d2ebf4");
      c.fillStyle = tg;
      c.fill();
      c.save();
      topPath();
      c.clip();
      const LX = -0.55,
        LY = -0.835;
      for (let k = 0; k < topPts.length - 1; k++) {
        const A = topPts[k],
          B = topPts[k + 1];
        const ex = B[0] - A[0],
          ey = B[1] - A[1],
          len = Math.hypot(ex, ey) || 1e-6;
        let nx = ey / len,
          ny = -ex / len;
        if (ny > 0) {
          nx = -nx;
          ny = -ny;
        }
        const diff = Math.max(0, nx * LX + ny * LY);
        const vertical = Math.abs(ex) < len * 0.25;
        const lit = vertical ? 0.1 + 0.2 * diff : 0.18 + 0.82 * diff;
        const r2 = 150 + 105 * lit,
          g2 = 190 + 65 * lit,
          b2 = 214 + 41 * lit;
        c.fillStyle = `rgba(${r2 | 0},${g2 | 0},${b2 | 0},${(0.3 + 0.55 * (1 - lit)).toFixed(3)})`;
        c.beginPath();
        c.moveTo(A[0], A[1]);
        c.lineTo(B[0], B[1]);
        c.lineTo(B[0], topH * 0.25);
        c.lineTo(A[0], topH * 0.25);
        c.closePath();
        c.fill();
        if (!vertical && diff > 0.72) {
          const spec = Math.pow((diff - 0.72) / 0.28, 1.4);
          c.strokeStyle = `rgba(255,255,255,${(0.3 + 0.55 * spec).toFixed(3)})`;
          c.lineWidth = 1.0 + 1.6 * spec;
          c.beginPath();
          c.moveTo(A[0], A[1] + 0.4);
          c.lineTo(B[0], B[1] + 0.4);
          c.stroke();
        }
      }
      const sg2 = c.createLinearGradient(0, -topH * 0.55, 0, 2);
      sg2.addColorStop(0, "rgba(120,206,236,0)");
      sg2.addColorStop(0.55, dark ? "rgba(108,200,234,0.20)" : "rgba(126,214,240,0.26)");
      sg2.addColorStop(1, dark ? "rgba(126,222,246,0.46)" : "rgba(150,232,250,0.52)");
      c.fillStyle = sg2;
      c.fillRect(-halfTop * 1.2, -topH * 0.55, halfTop * 2.4, topH * 0.6);
      c.lineWidth = 0.75;
      for (let k = 0; k < 3; k++) {
        const y0 = -topH * (0.26 + 0.2 * k + 0.05 * jag(k + 90));
        c.strokeStyle = `rgba(255,255,255,${((dark ? 0.16 : 0.32) * (1 - k * 0.22)).toFixed(3)})`;
        c.beginPath();
        c.moveTo(-halfTop * 1.2, y0);
        c.lineTo(halfTop * 1.2, y0 + topH * 0.055);
        c.stroke();
      }
      c.strokeStyle = dark ? "rgba(110,176,212,0.55)" : "rgba(118,186,222,0.62)";
      c.lineWidth = 1.0;
      for (let k = 0; k < 3; k++) {
        const px = -halfTop * 0.55 + k * halfTop * 0.55 + jag(k + 60) * 6;
        const h0 = -topH * (0.25 + 0.5 * jag(k + 70));
        c.beginPath();
        c.moveTo(px, h0);
        c.lineTo(px + 2.5 - 4 * jag(k + 75), h0 * 0.45);
        c.lineTo(px + 1, 0);
        c.stroke();
      }
      c.restore();
      topPath();
      c.strokeStyle = dark ? "rgba(158,208,232,0.70)" : "rgba(142,194,222,0.66)";
      c.lineWidth = 1.0;
      c.stroke();
      c.lineCap = "round";
      for (let k = 0; k < topPts.length - 1; k++) {
        const A = topPts[k],
          B = topPts[k + 1];
        if (B[0] > peakX) continue;
        c.strokeStyle = "rgba(255,255,255,0.85)";
        c.lineWidth = 1.5;
        c.beginPath();
        c.moveTo(A[0], A[1]);
        c.lineTo(B[0], B[1]);
        c.stroke();
      }
      c.lineCap = "butt";
      /* contact shading in the water under the ram */
      const ao = c.createLinearGradient(0, 0, 0, topH * 0.55);
      ao.addColorStop(0, dark ? "rgba(6,22,34,0.28)" : "rgba(12,50,74,0.22)");
      ao.addColorStop(1, "rgba(10,40,60,0)");
      c.fillStyle = ao;
      c.beginPath();
      c.moveTo(ramL * 1.05, 1);
      c.lineTo(ramR * 1.05, 1);
      c.lineTo(ramR * 0.7, topH * 0.55);
      c.lineTo(ramL * 0.7, topH * 0.55);
      c.closePath();
      c.fill();
      /* waterline: wave-cut notch, melt lip, foam collar */
      c.fillStyle = dark ? "rgba(96,150,180,0.42)" : "rgba(120,176,208,0.40)";
      c.fillRect(-halfTop * 1.02, -2.6, halfTop * 2.04, 2.6);
      c.fillStyle = dark ? "rgba(224,248,255,0.75)" : "rgba(255,255,255,0.92)";
      c.fillRect(-halfTop * 1.02, -3.4, halfTop * 2.04, 1.3);
      c.fillStyle = dark ? "rgba(186,228,244,0.34)" : "rgba(226,246,255,0.55)";
      c.beginPath();
      c.ellipse(0, 1.0, halfTop * 1.35, 2.6, 0, 0, 6.283);
      c.fill();
      /* growlers calved off alongside */
      for (let k = 0; k < 3; k++) {
        const gx = (k === 1 ? -1 : 1) * halfTop * (1.5 + 0.9 * jag(k + 80));
        const gs = topH * (0.05 + 0.05 * jag(k + 85));
        c.save();
        c.translate(gx, 0);
        c.beginPath();
        c.moveTo(-gs * 1.6, 0);
        c.lineTo(-gs * 0.6, -gs);
        c.lineTo(gs * 0.5, -gs * 0.7);
        c.lineTo(gs * 1.5, 0);
        c.closePath();
        c.fillStyle = dark ? "rgba(226,246,254,0.82)" : "rgba(250,254,255,0.92)";
        c.fill();
        c.strokeStyle = "rgba(150,200,224,0.58)";
        c.lineWidth = 0.6;
        c.stroke();
        c.fillStyle = dark ? "rgba(150,206,232,0.34)" : "rgba(186,226,244,0.42)";
        c.beginPath();
        c.ellipse(0, gs * 0.3, gs * 1.5, gs * 0.42, 0, 0, 6.283);
        c.fill();
        c.restore();
      }
      /* ice station: an elevated field module, never a cottage */
      if (station) {
        let sx0 = peakX + halfTop * 0.3,
          bench = -peakY * 0.62,
          flat = 1e9;
        for (let k = 0; k < topPts.length - 1; k++) {
          const a4 = topPts[k],
            b4 = topPts[k + 1],
            wSeg = Math.abs(b4[0] - a4[0]);
          if (wSeg < halfTop * 0.22) continue;
          const slope = Math.abs(b4[1] - a4[1]) / wSeg;
          if (slope < flat) {
            flat = slope;
            sx0 = (a4[0] + b4[0]) / 2;
            bench = (a4[1] + b4[1]) / 2;
          }
        }
        c.save();
        c.translate(sx0, bench + 0.5);
        const SS = Math.max(0.72, scl * 0.6);
        c.scale(SS, SS);
        const ink = "rgba(26,34,42,0.92)";
        c.strokeStyle = ink;
        c.lineWidth = 1.1;
        c.beginPath();
        c.moveTo(-8, 7);
        c.lineTo(-6.5, 2);
        c.moveTo(-1, 7);
        c.lineTo(-1, 2);
        c.moveTo(7, 7);
        c.lineTo(5.5, 2);
        c.stroke();
        c.lineWidth = 1.4;
        c.beginPath();
        c.moveTo(-9.5, 7.2);
        c.lineTo(-4, 7.2);
        c.moveTo(3.5, 7.2);
        c.lineTo(9, 7.2);
        c.stroke();
        const bg = c.createLinearGradient(-10, -6, 10, 3);
        bg.addColorStop(0, "#b8483a");
        bg.addColorStop(0.55, "#96382d");
        bg.addColorStop(1, "#6f2a22");
        c.fillStyle = bg;
        c.fillRect(-10, -5, 20, 7.4);
        c.fillStyle = "rgba(255,255,255,0.16)";
        c.fillRect(-10, -5, 20, 1.1);
        c.strokeStyle = ink;
        c.lineWidth = 0.8;
        c.strokeRect(-10, -5, 20, 7.4);
        c.fillStyle = "#4a545c";
        c.fillRect(-10.8, -6.4, 21.6, 1.5);
        c.fillStyle = dark ? "rgba(255,226,160,0.95)" : "rgba(196,222,236,0.9)";
        for (let k = 0; k < 4; k++) c.fillRect(-7.6 + k * 4.2, -3.2, 2.6, 2.2);
        c.fillStyle = "#3d2420";
        c.fillRect(6.2, -2.4, 2.6, 4.8);
        c.strokeStyle = ink;
        c.lineWidth = 0.7;
        c.beginPath();
        c.moveTo(8.8, 2.4);
        c.lineTo(11.5, 6.6);
        c.stroke();
        c.save();
        c.translate(-4.5, -7.2);
        c.rotate(-0.42);
        c.fillStyle = "#16233c";
        c.fillRect(-4.4, -0.9, 8.8, 1.8);
        c.strokeStyle = "rgba(190,210,228,0.7)";
        c.lineWidth = 0.4;
        for (let k = -3; k <= 3; k += 2) {
          c.beginPath();
          c.moveTo(k, -0.9);
          c.lineTo(k, 0.9);
          c.stroke();
        }
        c.restore();
        c.strokeStyle = "rgba(198,214,226,0.95)";
        c.lineWidth = 1.0;
        c.beginPath();
        c.moveTo(4.6, -6.4);
        c.lineTo(4.6, -17.5);
        c.stroke();
        c.lineWidth = 0.7;
        c.beginPath();
        c.moveTo(1.6, -14.6);
        c.lineTo(7.6, -14.6);
        c.stroke();
        c.restore();
      }
    };
    /* ONE BERG, STILL, AT THE WATERLINE.
       The rock went, then the drift, and now the heave. The berg is placed at `groundY` - the same
       line the surface band above is drawn at - so it sits in the water rather than beside it, and
       it stays there because neither of them moves.

       AND ONE ELEMENT, not three. The split existed because a heave keyframe is a whole transform
       and would have thrown the berg's position away, so the position needed an element of its own
       outside the moving one. With no keyframe there is nothing to separate: the place and the
       drawing are the same box, which is one fewer element and one fewer promoted layer per berg.

       A PLAIN `translate`, not `translate3d`. The 3D form was there to promote a moving layer; a
       still element does not need promoting, and asking for a layer that never changes is memory
       the compositor holds for nothing. */
    const wrap = el("div", "obj", lyr, `transform:translate(${f2(cx)}px,${f2(groundY)}px)`);
    const holder = el("div", "", wrap, "position:absolute;left:0;top:0;width:0;height:0");
    drop(
      holder,
      bake(CW, CH, OX, OY, (c) => paint(c, NIGHT), 2),
      "",
    );
    if (tag) el("div", "lbl", wrap, `left:0;top:${f2(-topH - 16)}px`).textContent = tag;
  };
  /* The ice station only. `bergS` and `bergT` carried no label and no
     station hut - two more lumps of the same ice, each with its own
     composited layer and its own running track. */
  berg(at("bergL"), bergScl.L, true, 1.7, "ICE STATION");
}

/* ====================================================================
   AIRCRAFT — REMOVED. Neither the research transect nor its contrail is
   one of the retained subjects, and nothing else depends on them.
   ==================================================================== */

/* ====================================================================
   RADIOSONDES — REMOVED. The launch, the ascent, the burst, the canopy
   and the descent are gone with the balloon train that flew them; the
   sonde sprites are no longer named and are no longer published.
   ==================================================================== */

/* ====================================================================
   THE STAGE SENTINELS

   One empty, invisible strip per stage, spanning that stage's own range of
   the story. The island observes them with an IntersectionObserver and
   names the live ones on the root; the stylesheet does the rest. Nothing
   here polls a scroll position, and nothing asks for an animation frame:
   an IntersectionObserver reports a crossing when the compositor already
   knows about it.

   They are a pixel wide and draw nothing. A stage's own boundaries are the
   geometry's, except at the coast, where the interesting things - the
   instruments, the waves, the vessel and its buoys - sit in a band AROUND
   the waterline rather than above or below it.
   ==================================================================== */
/* ====================================================================
   `buildZones` IS GONE.

   It laid five invisible strips across the scene and tagged them `data-zone`, so the island's
   IntersectionObserver could report which bands were on screen and the preset's CSS could run the
   animations in those and pause the rest. With nothing to pause, the strips were five elements
   that existed to be observed by an observer that has itself been removed.
   ==================================================================== */

/* ====================================================================
   THE STANDING PROVENANCE CAPTION/* ====================================================================
   THE STANDING PROVENANCE CAPTION

   The fields in this drawing are synthetic. They are built from closed
   analytic expressions in this file - a frontal potential-temperature
   structure, a humidity field, a thermocline - and not from any model
   run, any reanalysis or any measurement. A picture of contoured
   isentropes over a coastline with instruments on it looks exactly like
   an analysis, so the drawing says that it is not one, in the drawing.

   The previous renderer painted this sentence onto the canvas. It is an
   element here, for the same reason everything else is.
   ==================================================================== */
const PROVENANCE = "SYNTHETIC CROSS-SECTION · ILLUSTRATIVE, NOT AN ANALYSIS";

function buildCaption(root) {
  const { w, chartTop, groundY } = G;
  const y = Math.round(chartTop + (groundY - chartTop) * 0.035);
  const c = el("div", "cap", root, `left:0;top:${f2(y)}px;width:${f2(w)}px`);
  c.textContent = PROVENANCE;
}

/* ====================================================================
   ASSEMBLY
   ==================================================================== */

/** The scene root currently built, so a rebuild can be refused re-entrantly. */
let BUILDING = false;

/**
 * Draw the whole scene into `host`, once.
 *
 * Everything below this call is inert until the element is removed: the
 * only things still running are compositor-side CSS animations.
 */
/**
 * Draw the whole scene into `host`.
 *
 * `keepGeom` redraws against the geometry already solved instead of solving
 * again. It is for the one rebuild that is not about shape: a theme change
 * draws a different sky, and re-solving there would re-read a page height
 * that the reader's own scrolling may have changed since load and move the
 * coastline under them for no reason they could name.
 */
function buildScene(host, keepGeom) {
  if (BUILDING) return;
  BUILDING = true;
  try {
    newSheet();
    for (const k in RMAX) delete RMAX[k];
    ATM._tab = null;
    host.textContent = "";
    /* The sky the scene is being built for. The island writes `data-sky`
       before it asks for a build and before every rebuild, so this is read
       once per build and is constant for the whole of it. */
    NIGHT = host.dataset.sky !== "day";
    if (!keepGeom || !G.sceneH) G = geometry(host.clientHeight);

    /*
     * NO ASSET MAP. The scene draws no packaged bodies, so there is nothing to resolve to a URL
     * per build: the only files it loads are the sky's own, and `buildSky` and `buildLuminaries`
     * name those directly through `assetUrl`.
     */

    /*
     * EACH BUILDER HAS ITS OWN SEEDED STREAM, which is why the removed ones could go without
     * moving anything that stayed. `rngFrom` is called once per builder, so deleting one shifts no
     * draw in the sky, the ocean or the floats.
     */
    const terr = makeTerrain();
    const band = buildSky(host);
    buildLuminaries(band);
    buildAtmosphere(host, terr);
    buildEarth(host, terr);
    buildMountains(host, terr);
    buildStrand(host, terr);
    buildOcean(host, terr);
    buildFloats(host, terr);
    buildCaption(host);

    flushSheet();
  } finally {
    BUILDING = false;
  }
}

/**
 * Mount the scene on `host` and hand back the handle the island drives.
 *
 * The handle is deliberately small: build, rebuild, teardown, and a
 * read-only view of where the bands landed. There is no loop to start or
 * stop, no frame counter, no render mode and no measurement API - the
 * scene either exists or it does not.
 */
export function mountCosmosScene(host) {
  buildScene(host);
  let live = true;
  return {
    /**
     * Redraw. Re-solves the geometry unless `keepGeometry` is set, which is
     * how a theme change draws the other sky without moving anything.
     */
    rebuild(keepGeometry) {
      if (live) buildScene(host, keepGeometry);
    },
    /** Band geometry of the scene as built, in host coordinates. */
    get geom() {
      return {
        w: G.w,
        h: G.h,
        H: G.sceneH,
        spaceEnd: G.spaceEnd,
        chartTop: G.chartTop,
        groundY: G.groundY,
        seaY: G.groundY,
        oceanBot: G.oceanBot,
        coastX: G.coastX,
      };
    },
    /** Remove every element and rule this module created. */
    destroy() {
      if (!live) return;
      live = false;
      host.textContent = "";
      dropSheet();
    },
  };
}

/**
 * The object bodies the scene draws, by file name. Used by the packager.
 *
 * EMPTY, AND THAT IS THE ANSWER RATHER THAN AN OMISSION. The scene draws no packaged bodies: the
 * satellites were the last two, and the sky art is not a body - it is the backdrop, published by
 * `SKY_ART` in `src/model/cosmos-scene.ts` and named by this file through `assetUrl` directly. The
 * function is kept because the packager asks every renderer the same question and a renderer that
 * answers "none" is a different thing from a renderer that cannot be asked.
 */
export function sceneBodies() {
  return [];
}
