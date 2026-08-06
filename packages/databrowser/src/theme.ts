// theme.ts - persistence. Only theme/layout/view persist, namespaced under freva.db.*.
// Initial theme rule: use the stored value if present, else default to night. We deliberately
// do NOT read prefers-color-scheme - night is the intended default and matches the product.

import type { ShellId } from "./shell.js";

const KEY_THEME = "freva.db.theme";
const KEY_LAYOUT = "freva.db.layout";
const KEY_VIEW = "freva.db.view";
const KEY_SIDEBAR = "freva.db.sidebar";

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage may be unavailable (private mode); persistence is best-effort */
  }
}

export function loadTheme(): "day" | "night" {
  return read(KEY_THEME) === "day" ? "day" : "night";
}
export function saveTheme(t: "day" | "night"): void {
  write(KEY_THEME, t);
}

export function loadLayout(): "results" | "overview" {
  return read(KEY_LAYOUT) === "overview" ? "overview" : "results";
}
export function saveLayout(l: "results" | "overview"): void {
  write(KEY_LAYOUT, l);
}

export function loadView(): "list" | "grid" {
  return read(KEY_VIEW) === "grid" ? "grid" : "list";
}
export function saveView(v: "list" | "grid"): void {
  write(KEY_VIEW, v);
}

export function loadSidebarCollapsed(fallback = false): boolean {
  const v = read(KEY_SIDEBAR);
  return v === "collapsed" ? true : v === "open" ? false : fallback;
}
export function saveSidebarCollapsed(collapsed: boolean): void {
  write(KEY_SIDEBAR, collapsed ? "collapsed" : "open");
}

const KEY_OVERVIEW = "freva.db.overview";
export interface OverviewPrefs {
  sort: Record<string, "count" | "alpha">;
  collapsed: string[];
  span: Record<string, number>;
  h?: Record<string, number>;
  order: string[];
  addOpen: boolean;
  stacked?: boolean;
  /** facets the stacked session has already accounted for - lets a NEW facet default to collapsed
   *  while a previously-expanded one stays open across reloads. */
  stackSeen?: string[];
  snapshot?: {
    collapsed: string[];
    span: Record<string, number>;
    h: Record<string, number>;
  } | null;
}
export function loadOverviewPrefs(): OverviewPrefs | null {
  const raw = read(KEY_OVERVIEW);
  if (!raw) return null;
  // Coerce a persisted record to { [string]: finite number } - drops NaN/"garbage"/non-numeric so a
  // corrupted store can't write `grid-column: span NaN` into the DOM.
  const numMap = (v: unknown): Record<string, number> => {
    const out: Record<string, number> = {};
    if (v && typeof v === "object") {
      for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
        const num = typeof n === "number" ? n : Number(n);
        if (Number.isFinite(num)) out[k] = num;
      }
    }
    return out;
  };
  const strArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  try {
    const p = JSON.parse(raw) as Partial<OverviewPrefs>;
    const snap = p.snapshot;
    return {
      sort: p.sort && typeof p.sort === "object" ? p.sort : {},
      collapsed: strArr(p.collapsed),
      h: numMap(p.h),
      span: numMap(p.span),
      order: strArr(p.order),
      addOpen: p.addOpen === true,
      stacked: p.stacked === true,
      stackSeen: strArr(p.stackSeen),
      snapshot:
        snap &&
        Array.isArray(snap.collapsed) &&
        snap.span &&
        typeof snap.span === "object" &&
        snap.h &&
        typeof snap.h === "object"
          ? { collapsed: strArr(snap.collapsed), span: numMap(snap.span), h: numMap(snap.h) }
          : null,
    };
  } catch {
    return null;
  }
}
export function saveOverviewPrefs(p: OverviewPrefs): void {
  try {
    write(KEY_OVERVIEW, JSON.stringify(p));
  } catch {
    /* storage may be unavailable/full - persistence is best-effort */
  }
}

const KEY_SHELL = "freva.db.shell";
const SHELL_SET = new Set(["bash", "zsh", "powershell", "cmd"]);
export function loadShell(): ShellId | null {
  const v = read(KEY_SHELL);
  return v && SHELL_SET.has(v) ? (v as ShellId) : null;
}
export function saveShell(id: string): void {
  write(KEY_SHELL, id);
}

// Terminal background choice - persisted so the colour survives a reload or a new
// window. Stored as a preset id, not a raw colour, so a stale/hostile value can never produce an
// unreadable (or injected) style: unknown ids fall back to the default at the call site.
const KEY_TERM = "freva.db.term.bg";
const TERM_SET = new Set(["black", "ink", "graphite", "midnight", "forest", "plum", "paper"]);
export function loadTermTheme(): string | null {
  const v = read(KEY_TERM);
  return v && TERM_SET.has(v) ? v : null;
}
export function saveTermTheme(id: string): void {
  write(KEY_TERM, id);
}

/** Terminal opacity - persisted, clamped to a readable range. */
const KEY_TERM_A = "freva.db.term.alpha";
export function loadTermAlpha(): number | null {
  const v = Number(read(KEY_TERM_A));
  return Number.isFinite(v) && v >= 0.5 && v <= 1 ? v : null;
}
export function saveTermAlpha(a: number): void {
  write(KEY_TERM_A, String(a));
}
