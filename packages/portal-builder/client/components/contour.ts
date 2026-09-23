/**
 * The `contour` theme's backdrop: pressure isobars over a warming-stripe band.
 *
 * This file is the DRAWING and nothing else: the synthetic pressure field, the marching-squares
 * contour tracing, the isobar labels that ride a fixed line, the H/L extrema, and the stripe band
 * built from the observed global anomaly record. It draws into two canvases the portal owns and
 * knows nothing about what is on top of them.
 *
 * How strongly it reads is a custom property the theme sets, read fresh each frame, so the
 * balance is tunable without touching this file.
 *
 * The lifecycle is the part a decorative background has to get right, because nobody looks at it
 * and it runs forever:
 *
 *   - the backing store is capped at 2 device pixels per CSS pixel, so a 3x phone does not pay
 *     for a picture nobody is reading;
 *   - it stops when the document is hidden and when the landing page is scrolled out of view, and
 *     starts again when it comes back;
 *   - a visitor who asked for reduced motion gets one frame and no loop;
 *   - everything it attached is detached again by the returned disposer.
 */

interface Centre {
  x: number;
  y: number;
  s: number;
  rad: number;
  dx: number;
  dy: number;
  k: number;
  ph: number;
}

interface Anchor {
  x: number;
  y: number;
  v: number;
}

interface LabelState {
  x: number;
  y: number;
  ang: number;
  alpha: number;
  has: boolean;
}

interface Extremum {
  x: number;
  y: number;
  hi: boolean;
  v: number;
  alpha: number;
  used?: boolean;
}

interface Segment {
  x: number;
  y: number;
  ang: number;
}

/** The isobar interval, in the field's own arbitrary hectopascals. */
const INTERVAL = 5;
/** The field is sampled on this grid, in CSS pixels. */
const STEP = 16;
const MAX_DPR = 2;

/**
 * A deterministic generator. Two builds of the same site must photograph the same or a visual test
 * is a coin toss, so the seed is fixed and the picture is a function of the viewport alone.
 */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

/** The observed global anomaly record, by decade, in K against 1961-1990. */
const ANOMALY_ANCHORS: [number, number][] = [
  [1850, -0.37],
  [1860, -0.34],
  [1870, -0.32],
  [1880, -0.27],
  [1890, -0.35],
  [1900, -0.26],
  [1910, -0.42],
  [1920, -0.24],
  [1930, -0.12],
  [1940, 0.02],
  [1950, -0.14],
  [1960, -0.03],
  [1970, -0.03],
  [1980, 0.12],
  [1990, 0.26],
  [2000, 0.4],
  [2010, 0.57],
  [2020, 0.86],
  [2024, 1.03],
];

/** Anomaly in K to the stripe colour, as the reference ramps it. */
const RAMP: [number, [number, number, number]][] = [
  [-0.9, [8, 48, 107]],
  [-0.6, [20, 88, 154]],
  [-0.35, [39, 119, 180]],
  [-0.15, [130, 185, 216]],
  [0, [214, 222, 226]],
  [0.15, [240, 217, 196]],
  [0.4, [239, 162, 104]],
  [0.7, [209, 92, 52]],
  [1.2, [169, 51, 31]],
  [2, [111, 22, 17]],
];

function rampAt(anomaly: number): [number, number, number] {
  let start = RAMP[0]!;
  let end = RAMP[RAMP.length - 1]!;
  for (let i = 0; i < RAMP.length - 1; i += 1) {
    if (anomaly >= RAMP[i]![0] && anomaly <= RAMP[i + 1]![0]) {
      start = RAMP[i]!;
      end = RAMP[i + 1]!;
      break;
    }
  }
  const t = Math.max(0, Math.min(1, (anomaly - start[0]) / (end[0] - start[0] || 1)));
  return [0, 1, 2].map((c) =>
    Math.round(start[1][c as 0 | 1 | 2] + (end[1][c as 0 | 1 | 2] - start[1][c as 0 | 1 | 2]) * t),
  ) as [number, number, number];
}

/** Reads the theme's own numbers, so nothing about the balance lives here. */
function readTuning(root: HTMLElement): {
  minor: number;
  major: number;
  label: number;
  stripes: number;
  ink: string;
  inkMajor: string;
  high: string;
  low: string;
  page: string;
} {
  const style = getComputedStyle(root);
  const num = (name: string, fallback: number): number => {
    const raw = Number.parseFloat(style.getPropertyValue(name));
    return Number.isFinite(raw) ? raw : fallback;
  };
  const rgb = (name: string, fallback: string): string => {
    const raw = style.getPropertyValue(name).trim();
    return raw || fallback;
  };
  return {
    minor: num("--portal-contour-minor", 0.08),
    major: num("--portal-contour-major", 0.16),
    label: num("--portal-contour-label", 0.24),
    stripes: num("--portal-contour-stripes", 0.14),
    ink: rgb("--portal-contour-ink", "22, 32, 43"),
    inkMajor: rgb("--portal-contour-ink-major", "15, 74, 92"),
    high: rgb("--portal-contour-high", "169, 51, 31"),
    low: rgb("--portal-contour-low", "15, 74, 92"),
    page: rgb("--portal-contour-page", style.getPropertyValue("--bg").trim() || "#f7f6f3"),
  };
}

export function mountContourBackdrop(): () => void {
  const field = document.querySelector<HTMLCanvasElement>(".portal-contour");
  const band = document.querySelector<HTMLCanvasElement>(".portal-contour-stripes");
  const landing = document.querySelector<HTMLElement>(".portal-landing");
  const root = document.documentElement;
  if (!field || !landing) return () => {};

  const calm = matchMedia("(prefers-reduced-motion: reduce)");
  const random = rng(0x5eed_c047);

  // the field

  const centres: Centre[] = Array.from({ length: 4 }, (_, i) => ({
    x: 0.08 + random() * 0.9,
    y: 0.05 + random() * 0.9,
    s: (i % 2 === 0 ? 1 : -1) * (12 + random() * 12),
    rad: 0.3 + random() * 0.34,
    dx: 0.06 + random() * 0.16,
    dy: 0.05 + random() * 0.14,
    k: 0.25 + random() * 0.5,
    ph: random() * 6.28,
  }));

  const at = (nx: number, ny: number, u: number): number => {
    let v =
      1008 +
      5.5 * Math.sin(nx * 3.1 + u * 0.9) +
      4.0 * Math.cos(ny * 2.4 - u * 0.7) +
      2.5 * Math.sin((nx + ny) * 4.3 + u * 1.3);
    for (const c of centres) {
      const cx = c.x + c.dx * Math.sin(u * c.k + c.ph);
      const cy = c.y + c.dy * Math.cos(u * c.k * 0.8 + c.ph);
      const dx = nx - cx;
      const dy = (ny - cy) * 0.85;
      v += c.s * Math.exp(-(dx * dx + dy * dy) / (c.rad * c.rad));
    }
    return v;
  };

  // Each label owns one isobar value and rides that line wherever it goes.
  const anchors: Anchor[] = (
    [
      [0.13, 0.3],
      [0.35, 0.72],
      [0.6, 0.18],
      [0.82, 0.52],
      [0.48, 0.9],
      [0.24, 0.55],
    ] as [number, number][]
  ).map(([x, y], i) => ({
    x: x + (random() - 0.5) * 0.04,
    y: y + (random() - 0.5) * 0.04,
    v: [995, 1000, 1005, 1010, 1015, 1020][i]!,
  }));
  const labels: LabelState[] = anchors.map(() => ({ x: 0, y: 0, ang: 0, alpha: 0, has: false }));
  let extrema: Extremum[] = [];

  // the record

  const endYear = new Date().getUTCFullYear();
  const anchorsK = [...ANOMALY_ANCHORS];
  const [lastYear, lastValue] = anchorsK[anchorsK.length - 1]!;
  if (endYear > lastYear) anchorsK.push([endYear, lastValue + 0.021 * (endYear - lastYear)]);
  const anomalyAt = (year: number): number => {
    for (let i = 0; i < anchorsK.length - 1; i += 1) {
      const [y0, v0] = anchorsK[i]!;
      const [y1, v1] = anchorsK[i + 1]!;
      if (year >= y0 && year <= y1) {
        const t = (year - y0) / (y1 - y0);
        return v0 + (v1 - v0) * (t * t * (3 - 2 * t));
      }
    }
    return anchorsK[anchorsK.length - 1]![1];
  };
  const series: { year: number; v: number }[] = [];
  for (let year = 1850; year <= endYear; year += 1) {
    const n1 = Math.sin(year * 12.9898) * 43_758.5453;
    const n2 = Math.sin(year * 78.233) * 12_765.1234;
    const jitter = (n1 - Math.floor(n1) - 0.5) * 0.16 + (n2 - Math.floor(n2) - 0.5) * 0.09;
    series.push({ year, v: anomalyAt(year) + jitter });
  }
  const phases = series.map(() => ({ p: random() * 6.28, s: random() * 0.5 }));

  // geometry

  let dpr = 1;
  let w = 0;
  let h = 0;
  let bw = 0;
  let bh = 0;

  const resize = (): void => {
    dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    w = field.clientWidth || window.innerWidth;
    h = field.clientHeight || window.innerHeight;
    field.width = Math.round(w * dpr);
    field.height = Math.round(h * dpr);
    if (!band) return;
    const page = document.documentElement.clientWidth || w;
    band.style.width = `${page}px`;
    band.style.height = `${Math.round(Math.min(landing.offsetHeight * 0.62, 420))}px`;
    bw = band.clientWidth;
    bh = band.clientHeight;
    band.width = Math.round(bw * dpr);
    band.height = Math.round(bh * dpr);
  };

  // the strips

  const drawBand = (t: number, scroll: number, tune: ReturnType<typeof readTuning>): void => {
    if (!band || !bw || !bh) return;
    const ctx = band.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, bw, bh);

    const n = series.length;
    const cw = bw / n;
    const u = t * 200 + scroll * 0.01;
    const floorY = bh;
    const base = floorY * 0.78;
    const up = base - 12;
    const down = floorY - base;

    for (let i = 0; i < n; i += 1) {
      const phase = phases[i]!;
      const anomaly = series[i]!.v + 0.05 * Math.sin(u * (0.5 + phase.s) + phase.p);
      const [r, g, b] = rampAt(anomaly);
      const x = i * cw;
      const barH = anomaly >= 0 ? (anomaly / 1.15) * up : (anomaly / 0.55) * down;
      const yTop = barH >= 0 ? base - barH : base;

      ctx.globalAlpha = tune.stripes;
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(x, 0, cw + 0.6, floorY);

      // The same year's value, drawn once more so the record stays readable.
      ctx.globalAlpha = tune.stripes * 0.9;
      ctx.fillStyle = `rgb(${tune.ink})`;
      ctx.fillRect(x + 0.6, yTop, Math.max(0, cw - 1.2), Math.max(1, Math.abs(barH)));
    }

    // The band dissolves at both edges rather than ending on a line.
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "destination-out";
    const fade = ctx.createLinearGradient(0, 0, 0, bh);
    fade.addColorStop(0, "rgba(0,0,0,1)");
    fade.addColorStop(0.3, "rgba(0,0,0,0)");
    fade.addColorStop(0.78, "rgba(0,0,0,0)");
    fade.addColorStop(1, "rgba(0,0,0,1)");
    ctx.fillStyle = fade;
    ctx.fillRect(0, 0, bw, bh);
    ctx.globalCompositeOperation = "source-over";
  };

  // the isobars

  const segmentAt = (
    grid: Float32Array,
    cols: number,
    i: number,
    j: number,
    v: number,
  ): Segment | null => {
    const a = grid[j * cols + i]!;
    const b = grid[j * cols + i + 1]!;
    const c = grid[(j + 1) * cols + i + 1]!;
    const d = grid[(j + 1) * cols + i]!;
    const idx = (a > v ? 8 : 0) | (b > v ? 4 : 0) | (c > v ? 2 : 0) | (d > v ? 1 : 0);
    if (idx === 0 || idx === 15 || idx === 5 || idx === 10) return null;
    const x = i * STEP;
    const y = j * STEP;
    const T = (p: number, q: number): number => (v - p) / (q - p);
    const top: [number, number] = [x + STEP * T(a, b), y];
    const right: [number, number] = [x + STEP, y + STEP * T(b, c)];
    const bottom: [number, number] = [x + STEP * T(d, c), y + STEP];
    const left: [number, number] = [x, y + STEP * T(a, d)];
    let p: [number, number];
    let q: [number, number];
    switch (idx) {
      case 1:
      case 14:
        p = left;
        q = bottom;
        break;
      case 2:
      case 13:
        p = bottom;
        q = right;
        break;
      case 3:
      case 12:
        p = left;
        q = right;
        break;
      case 4:
      case 11:
        p = top;
        q = right;
        break;
      case 6:
      case 9:
        p = top;
        q = bottom;
        break;
      default:
        p = left;
        q = top;
    }
    return {
      x: (p[0] + q[0]) / 2,
      y: (p[1] + q[1]) / 2,
      ang: Math.atan2(q[1] - p[1], q[0] - p[0]),
    };
  };

  const drawField = (t: number, scroll: number, tune: ReturnType<typeof readTuning>): void => {
    const ctx = field.getContext("2d");
    if (!ctx || !w || !h) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const u = scroll * 0.0006 + t;
    const drift = scroll * 0.00014;
    const cols = Math.ceil(w / STEP) + 1;
    const rows = Math.ceil(h / STEP) + 1;
    const grid = new Float32Array(cols * rows);
    for (let j = 0; j < rows; j += 1) {
      for (let i = 0; i < cols; i += 1) {
        grid[j * cols + i] = at((i * STEP) / w, (j * STEP) / h + drift, u);
      }
    }

    let lo = Infinity;
    let hi = -Infinity;
    for (const value of grid) {
      if (value < lo) lo = value;
      if (value > hi) hi = value;
    }

    for (let v = Math.ceil(lo / INTERVAL) * INTERVAL; v <= hi; v += INTERVAL) {
      const major = Math.round(v) % 10 === 0;
      ctx.beginPath();
      ctx.lineWidth = major ? 1.6 : 0.8;
      ctx.strokeStyle = major
        ? `rgba(${tune.inkMajor},${tune.major})`
        : `rgba(${tune.ink},${tune.minor})`;
      for (let j = 0; j < rows - 1; j += 1) {
        for (let i = 0; i < cols - 1; i += 1) {
          const a = grid[j * cols + i]!;
          const b = grid[j * cols + i + 1]!;
          const c = grid[(j + 1) * cols + i + 1]!;
          const d = grid[(j + 1) * cols + i]!;
          const idx = (a > v ? 8 : 0) | (b > v ? 4 : 0) | (c > v ? 2 : 0) | (d > v ? 1 : 0);
          if (idx === 0 || idx === 15) continue;
          const x = i * STEP;
          const y = j * STEP;
          const T = (p: number, q: number): number => (v - p) / (q - p);
          const top = (): [number, number] => [x + STEP * T(a, b), y];
          const right = (): [number, number] => [x + STEP, y + STEP * T(b, c)];
          const bottom = (): [number, number] => [x + STEP * T(d, c), y + STEP];
          const left = (): [number, number] => [x, y + STEP * T(a, d)];
          let segs: [[number, number], [number, number]][];
          switch (idx) {
            case 1:
            case 14:
              segs = [[left(), bottom()]];
              break;
            case 2:
            case 13:
              segs = [[bottom(), right()]];
              break;
            case 3:
            case 12:
              segs = [[left(), right()]];
              break;
            case 4:
            case 11:
              segs = [[top(), right()]];
              break;
            case 6:
            case 9:
              segs = [[top(), bottom()]];
              break;
            case 7:
            case 8:
              segs = [[left(), top()]];
              break;
            case 5:
              segs = [
                [left(), top()],
                [bottom(), right()],
              ];
              break;
            default:
              segs = [
                [left(), bottom()],
                [top(), right()],
              ];
          }
          for (const [from, to] of segs) {
            ctx.moveTo(from[0], from[1]);
            ctx.lineTo(to[0], to[1]);
          }
        }
      }
      ctx.stroke();
    }

    // The isobar values, set into their own line.
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "400 11.5px ui-monospace, SFMono-Regular, Menlo, monospace";
    anchors.forEach((anchor, index) => {
      const state = labels[index]!;
      const i0 = Math.round((anchor.x * w) / STEP);
      const j0 = Math.round((anchor.y * h) / STEP);
      let best: Segment | null = null;
      for (let r = 0; r <= 10 && !best; r += 1) {
        for (let dj = -r; dj <= r && !best; dj += 1) {
          for (let di = -r; di <= r && !best; di += 1) {
            if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
            const i = i0 + di;
            const j = j0 + dj;
            if (i < 1 || j < 1 || i >= cols - 2 || j >= rows - 2) continue;
            const seg = segmentAt(grid, cols, i, j, anchor.v);
            if (!seg) continue;
            if (seg.x < 60 || seg.x > w - 60 || seg.y < 30 || seg.y > h - 30) continue;
            best = seg;
          }
        }
      }
      if (best) {
        if (!state.has) {
          state.x = best.x;
          state.y = best.y;
          state.ang = best.ang;
          state.has = true;
        } else {
          state.x += (best.x - state.x) * 0.06;
          state.y += (best.y - state.y) * 0.06;
          let da = best.ang - state.ang;
          while (da > Math.PI / 2) da -= Math.PI;
          while (da < -Math.PI / 2) da += Math.PI;
          state.ang += da * 0.06;
        }
        state.alpha = Math.min(1, state.alpha + 0.02);
      } else {
        state.alpha = Math.max(0, state.alpha - 0.03);
        if (state.alpha === 0) state.has = false;
      }
      if (state.alpha <= 0.01) return;
      let a = state.ang;
      if (a > Math.PI / 2) a -= Math.PI;
      else if (a < -Math.PI / 2) a += Math.PI;
      const text = String(anchor.v);
      const width = ctx.measureText(text).width + 10;
      ctx.save();
      ctx.globalAlpha = state.alpha;
      ctx.translate(state.x, state.y);
      ctx.rotate(a);
      // The label is set *into* the line: the page colour breaks the isobar, the number fills it.
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = "#000";
      ctx.fillRect(-width / 2, -8, width, 16);
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = `rgba(${anchor.v % 10 === 0 ? tune.inkMajor : tune.ink},${tune.label})`;
      ctx.fillText(text, 0, 0.5);
      ctx.restore();
    });

    // H and L, at the field's own extrema, held so they glide.
    const r = 4;
    const placed: { x: number; y: number }[] = [];
    const found: { x: number; y: number; hi: boolean; v: number }[] = [];
    for (let j = r; j < rows - r; j += 1) {
      for (let i = r; i < cols - r; i += 1) {
        const v0 = grid[j * cols + i]!;
        let isHigh = true;
        let isLow = true;
        for (let dj = -r; dj <= r && (isHigh || isLow); dj += r) {
          for (let di = -r; di <= r; di += r) {
            if (!di && !dj) continue;
            const n = grid[(j + dj) * cols + (i + di)]!;
            if (n >= v0) isHigh = false;
            if (n <= v0) isLow = false;
          }
        }
        if (!isHigh && !isLow) continue;
        const x = i * STEP;
        const y = j * STEP;
        if (x < 40 || x > w - 40 || y < 40 || y > h - 40) continue;
        if (!placed.every((p) => Math.hypot(p.x - x, p.y - y) > 130)) continue;
        placed.push({ x, y });
        found.push({ x, y, hi: isHigh, v: Math.round(v0) });
      }
    }

    const previous = extrema;
    const next: Extremum[] = [];
    for (const candidate of found) {
      let match: Extremum | null = null;
      let bestDistance = 200;
      for (const p of previous) {
        if (p.used || p.hi !== candidate.hi) continue;
        const d = Math.hypot(p.x - candidate.x, p.y - candidate.y);
        if (d < bestDistance) {
          bestDistance = d;
          match = p;
        }
      }
      if (match) {
        match.used = true;
        match.x += (candidate.x - match.x) * 0.05;
        match.y += (candidate.y - match.y) * 0.05;
        match.v += (candidate.v - match.v) * 0.05;
        match.alpha = Math.min(1, match.alpha + 0.02);
        next.push(match);
      } else {
        next.push({ ...candidate, alpha: 0 });
      }
    }
    for (const p of previous) {
      if (p.used) continue;
      p.alpha -= 0.02;
      if (p.alpha > 0) next.push(p);
    }
    for (const p of next) p.used = false;
    extrema = next;

    for (const p of extrema) {
      // `--portal-contour-label` is the whole of it: H and L are the labels the theme's number
      // is about, so nothing here scales it further.
      ctx.globalAlpha = Math.max(0, Math.min(1, p.alpha));
      ctx.fillStyle = `rgba(${p.hi ? tune.high : tune.low},${tune.label})`;
      ctx.font = "600 17px ui-serif, Georgia, serif";
      ctx.fillText(p.hi ? "H" : "L", p.x, p.y);
      ctx.font = "400 10px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.fillText(String(Math.round(p.v)), p.x, p.y + 15);
    }
    ctx.globalAlpha = 1;

    // The stripe band is punched out of the isobar field, so the two pictures never print on
    // top of each other.
    if (band) {
      const rect = band.getBoundingClientRect();
      if (rect.height > 0 && rect.bottom > 0 && rect.top < h) {
        ctx.clearRect(rect.left - 2, rect.top - 2, rect.width + 4, rect.height + 4);
      }
    }
  };

  // the loop

  let raf = 0;
  let running = false;
  let visible = true;
  let t = 0;
  let scroll = 0;
  let target = 0;

  const frame = (): void => {
    const tune = readTuning(root);
    drawField(t, scroll, tune);
    drawBand(t, scroll, tune);
  };

  const step = (): void => {
    scroll += (target - scroll) * 0.08;
    t += 0.00009;
    frame();
    raf = requestAnimationFrame(step);
  };

  const start = (): void => {
    if (running || calm.matches) return;
    running = true;
    raf = requestAnimationFrame(step);
  };
  const stop = (): void => {
    if (!running) return;
    running = false;
    cancelAnimationFrame(raf);
    raf = 0;
  };

  const settle = (): void => {
    if (calm.matches) {
      stop();
      frame();
      return;
    }
    if (visible && document.visibilityState !== "hidden") start();
    else stop();
  };

  const onResize = (): void => {
    resize();
    if (!running) frame();
  };
  const onScroll = (): void => {
    target = window.scrollY || document.documentElement.scrollTop || 0;
  };
  const onVisibility = (): void => settle();
  const onCalmChange = (): void => settle();

  window.addEventListener("resize", onResize, { passive: true });
  window.addEventListener("scroll", onScroll, { passive: true });
  document.addEventListener("visibilitychange", onVisibility);
  if (typeof calm.addEventListener === "function") calm.addEventListener("change", onCalmChange);

  let observer: IntersectionObserver | undefined;
  if (typeof IntersectionObserver === "function") {
    observer = new IntersectionObserver(
      (entries) => {
        visible = entries.some((entry) => entry.isIntersecting);
        settle();
      },
      { rootMargin: "128px" },
    );
    observer.observe(landing);
  }

  let sizes: ResizeObserver | undefined;
  if (typeof ResizeObserver === "function") {
    sizes = new ResizeObserver(() => onResize());
    sizes.observe(landing);
  }

  resize();
  onScroll();
  scroll = target;
  frame();
  root.dataset.portalContour = calm.matches ? "static" : "ready";
  settle();

  return () => {
    stop();
    window.removeEventListener("resize", onResize);
    window.removeEventListener("scroll", onScroll);
    document.removeEventListener("visibilitychange", onVisibility);
    if (typeof calm.removeEventListener === "function") {
      calm.removeEventListener("change", onCalmChange);
    }
    observer?.disconnect();
    sizes?.disconnect();
    delete root.dataset.portalContour;
  };
}
