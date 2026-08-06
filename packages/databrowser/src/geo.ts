// geo.ts - self-contained equirectangular SVG map for the bbox editor and mini-maps.
// A hand-simplified world coastline (real continent outlines) drawn as vector polygons: no
// Leaflet, no tiles, no network. Leaflet stays a lazy fallback for when drawing isn't smooth.
// All coordinates are constants, never API/user strings, and the SVG is assembled via DOM
// (no innerHTML).

import type { BBoxSelection } from "./types.js";
import { normalizeBboxLon } from "./state.js";

const NS = "http://www.w3.org/2000/svg";

export const lon2x = (lon: number, w: number): number => ((lon + 180) / 360) * w;
export const lat2y = (lat: number, h: number): number => ((90 - lat) / 180) * h;
export const x2lon = (x: number, w: number): number =>
  Math.max(-180, Math.min(180, (x / w) * 360 - 180));
export const y2lat = (y: number, h: number): number =>
  Math.max(-90, Math.min(90, 90 - (y / h) * 180));

// Simplified continent outlines as [lon, lat] rings. Deliberately low-vertex - recognisable as
// Earth, cheap to render. (Antarctica is a bottom strip; small islands omitted.)
const COASTLINES: number[][][] = [
  // North America
  [
    [-168, 66],
    [-166, 60],
    [-158, 57],
    [-152, 59],
    [-138, 58],
    [-130, 53],
    [-124, 47],
    [-124, 40],
    [-117, 32],
    [-110, 23],
    [-105, 20],
    [-97, 16],
    [-88, 15],
    [-83, 9],
    [-81, 13],
    [-84, 22],
    [-80, 25],
    [-81, 29],
    [-76, 35],
    [-70, 42],
    [-66, 45],
    [-60, 47],
    [-56, 51],
    [-64, 53],
    [-78, 52],
    [-80, 60],
    [-94, 58],
    [-95, 68],
    [-110, 68],
    [-124, 70],
    [-140, 70],
    [-156, 71],
    [-168, 66],
  ],
  // Greenland
  [
    [-46, 60],
    [-43, 64],
    [-40, 66],
    [-30, 68],
    [-22, 70],
    [-20, 76],
    [-33, 80],
    [-45, 82],
    [-58, 82],
    [-62, 78],
    [-53, 70],
    [-50, 64],
    [-46, 60],
  ],
  // South America
  [
    [-81, 8],
    [-77, 8],
    [-70, 12],
    [-62, 10],
    [-52, 5],
    [-50, 0],
    [-44, -2],
    [-40, -6],
    [-35, -8],
    [-38, -13],
    [-42, -23],
    [-48, -28],
    [-54, -34],
    [-58, -39],
    [-64, -42],
    [-66, -45],
    [-68, -50],
    [-66, -55],
    [-72, -54],
    [-74, -45],
    [-73, -37],
    [-71, -30],
    [-70, -20],
    [-76, -14],
    [-81, -6],
    [-80, 0],
    [-78, 4],
    [-81, 8],
  ],
  // Africa
  [
    [-16, 15],
    [-16, 21],
    [-10, 28],
    [-6, 36],
    [10, 37],
    [20, 33],
    [25, 32],
    [32, 31],
    [34, 28],
    [43, 12],
    [51, 12],
    [48, 5],
    [41, -2],
    [40, -10],
    [35, -18],
    [32, -26],
    [26, -34],
    [18, -35],
    [14, -23],
    [9, -1],
    [8, 4],
    [-4, 5],
    [-8, 4],
    [-13, 8],
    [-16, 15],
  ],
  // Europe
  [
    [-9, 44],
    [-9, 39],
    [-6, 36],
    [3, 42],
    [8, 44],
    [12, 45],
    [18, 40],
    [16, 45],
    [13, 45],
    [13, 54],
    [8, 58],
    [5, 61],
    [10, 64],
    [15, 68],
    [25, 71],
    [30, 68],
    [28, 60],
    [38, 60],
    [40, 50],
    [30, 46],
    [28, 41],
    [22, 40],
    [15, 40],
    [8, 44],
    [-9, 44],
  ],
  // Asia
  [
    [26, 40],
    [36, 36],
    [36, 30],
    [43, 39],
    [50, 44],
    [48, 30],
    [57, 25],
    [60, 25],
    [66, 25],
    [68, 20],
    [73, 18],
    [77, 8],
    [80, 13],
    [80, 22],
    [88, 22],
    [90, 16],
    [98, 10],
    [104, 9],
    [106, 17],
    [109, 22],
    [112, 22],
    [121, 31],
    [122, 40],
    [128, 42],
    [130, 35],
    [128, 45],
    [135, 48],
    [142, 54],
    [135, 58],
    [150, 60],
    [160, 60],
    [170, 66],
    [180, 68],
    [178, 72],
    [160, 71],
    [140, 73],
    [120, 74],
    [100, 77],
    [80, 74],
    [68, 77],
    [55, 73],
    [50, 69],
    [60, 66],
    [68, 66],
    [62, 58],
    [52, 52],
    [48, 46],
    [40, 46],
    [26, 40],
  ],
  // Australia
  [
    [114, -22],
    [113, -28],
    [116, -34],
    [123, -34],
    [131, -32],
    [138, -35],
    [141, -38],
    [147, -38],
    [150, -37],
    [153, -28],
    [153, -25],
    [146, -19],
    [142, -11],
    [136, -12],
    [130, -13],
    [124, -16],
    [122, -18],
    [114, -22],
  ],
  // Antarctica (bottom strip)
  [
    [-180, -72],
    [-140, -74],
    [-100, -74],
    [-60, -70],
    [-20, -72],
    [20, -70],
    [70, -68],
    [110, -66],
    [150, -70],
    [180, -72],
    [180, -84],
    [-180, -84],
    [-180, -72],
  ],
];

function poly(points: number[][], w: number, h: number): SVGPolygonElement {
  const p = document.createElementNS(NS, "polygon");
  p.setAttribute(
    "points",
    points.map(([lon, lat]) => `${lon2x(lon, w).toFixed(1)},${lat2y(lat, h).toFixed(1)}`).join(" "),
  );
  p.setAttribute("fill", "var(--land)");
  p.setAttribute("stroke", "color-mix(in srgb, var(--land) 60%, #000)");
  p.setAttribute("stroke-width", "0.6");
  p.setAttribute("opacity", "0.92");
  return p;
}

function line(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  width: number,
  opacity: number,
): SVGLineElement {
  const l = document.createElementNS(NS, "line");
  l.setAttribute("x1", String(x1));
  l.setAttribute("y1", String(y1));
  l.setAttribute("x2", String(x2));
  l.setAttribute("y2", String(y2));
  l.setAttribute("stroke", "var(--border-2)");
  l.setAttribute("stroke-width", String(width));
  l.setAttribute("opacity", String(opacity));
  return l;
}

/** A world map: ocean background, real simplified coastlines, graticule, and a selection rect. */
export function worldSVG(w: number, h: number): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg") as SVGSVGElement;
  svg.setAttribute("width", String(w));
  svg.setAttribute("height", String(h));
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.style.display = "block";
  svg.style.background = "var(--ocean)";

  for (const ring of COASTLINES) svg.appendChild(poly(ring, w, h));

  for (let lon = -120; lon <= 120; lon += 60)
    svg.appendChild(line(lon2x(lon, w), 0, lon2x(lon, w), h, 0.5, 0.4));
  for (let lat = -60; lat <= 60; lat += 30)
    svg.appendChild(line(0, lat2y(lat, h), w, lat2y(lat, h), 0.5, 0.4));
  svg.appendChild(line(0, lat2y(0, h), w, lat2y(0, h), 0.8, 0.85)); // equator

  // TWO rectangles: a box that crosses the antimeridian (e.g. lon 150 -> -150) is two pieces on a
  // -180…180 map, not one. The second stays empty for ordinary boxes.
  for (const id of ["selrect", "selrect2"]) {
    const rect = document.createElementNS(NS, "rect");
    rect.setAttribute("class", id); // class, not id - several mini-maps coexist; ids would collide
    rect.setAttribute("x", "0");
    rect.setAttribute("y", "0");
    rect.setAttribute("width", "0");
    rect.setAttribute("height", "0");
    rect.setAttribute("fill", "var(--accent)");
    rect.setAttribute("fill-opacity", "0.22");
    rect.setAttribute("stroke", "var(--accent)");
    rect.setAttribute("stroke-width", "1.4");
    svg.appendChild(rect);
  }
  return svg;
}

/**
 * Paint (or clear) the selection rectangle inside a worldSVG.
 *
 * Longitudes are normalised first: an index may publish a GLOBAL extent as 0…360
 * (`ENVELOPE(0, 360, 90, -90)`), which drawn literally would cover only the right-hand half of a
 * -180…180 map. Global boxes paint edge to edge; boxes that cross the antimeridian paint as two
 * rectangles instead of one wrong wide one.
 */
export function paintRect(svg: SVGSVGElement, b: BBoxSelection | null, w: number, h: number): void {
  const r = svg.querySelector(".selrect");
  const r2 = svg.querySelector(".selrect2");
  if (!r) return;
  const clear = (el: Element | null): void => {
    el?.setAttribute("width", "0");
    el?.setAttribute("height", "0");
  };
  if (!b) {
    clear(r);
    clear(r2);
    return;
  }
  const n = normalizeBboxLon(b);
  const y = lat2y(n.maxLat, h);
  const height = lat2y(n.minLat, h) - y;
  const box = (el: Element | null, lonA: number, lonB: number): void => {
    if (!el) return;
    const x = lon2x(lonA, w);
    el.setAttribute("x", String(x));
    el.setAttribute("y", String(y));
    el.setAttribute("width", String(Math.max(0, lon2x(lonB, w) - x)));
    el.setAttribute("height", String(height));
  };
  if (n.wraps) {
    box(r, n.minLon, 180); // …to the antimeridian
    box(r2, -180, n.maxLon); // …and on from the other side
    return;
  }
  box(r, n.minLon, n.maxLon); // (global -> -180…180, i.e. the full width)
  clear(r2);
}
