// Colour arithmetic for build-time theme decisions: WCAG relative luminance and contrast, and a
// plain sRGB mix - the same mix CSS `color-mix(in srgb, ...)` performs, so a value computed here
// is the value the browser paints. Pure functions over `#rrggbb`; nothing here reads a stylesheet.

export const isHex = (value: string): boolean => /^#[0-9a-fA-F]{6}$/.test(value);

export function channels(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

export function toHex(rgb: readonly number[]): string {
  return `#${rgb
    .map((c) =>
      Math.max(0, Math.min(255, Math.round(c)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

export function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

/** `weight` of `a` and the rest of `b`: `color-mix(in srgb, a weight, b)`. */
export function mix(a: string, b: string, weight: number): string {
  const [ar, ag, ab] = channels(a);
  const [br, bg, bb] = channels(b);
  return toHex([
    ar * weight + br * (1 - weight),
    ag * weight + bg * (1 - weight),
    ab * weight + bb * (1 - weight),
  ]);
}

export function toHsl(hex: string): [number, number, number] {
  const [r, g, b] = channels(hex).map((c) => c / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === r
      ? ((g - b) / d + (g < b ? 6 : 0)) / 6
      : max === g
        ? ((b - r) / d + 2) / 6
        : ((r - g) / d + 4) / 6;
  return [h, s, l];
}

export function fromHsl(h: number, s: number, l: number): string {
  if (s === 0) {
    const v = Math.round(l * 255);
    return toHex([v, v, v]);
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number): number => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return toHex([channel(h + 1 / 3), channel(h), channel(h - 1 / 3)].map((c) => c * 255));
}
