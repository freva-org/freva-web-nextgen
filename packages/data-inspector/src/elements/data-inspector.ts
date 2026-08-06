/**
 * <data-inspector> - NetCDF / Zarr file inspection dialog.
 *
 * Self-contained: ships its own modal chrome CSS (injected once into <head>)
 * and inline SVG icons, so hosts do not need external Bootstrap / Font Awesome
 * for this component's own markup.
 *
 * ── Attributes ─────────────────────────────────────────────────────────────
 *   open              Boolean - controls visibility
 *   file              String, or JSON-encoded string[] for aggregation mode
 *   status            "ready" | "loading" | "error"
 *   error             Error message string (rendered as text, never HTML)
 *   zarr-url          Presigned Zarr URL
 *   zarr-status-code  Number (backend status code from ZarrPoller)
 *   is-aggregation    Boolean
 *
 * ── JS-only properties ─────────────────────────────────────────────────────
 *   output            string | null  (trusted xarray-repr HTML; too large for an attribute)
 *
 * ── Events fired ───────────────────────────────────────────────────────────
 *   inspector-close   -
 *   inspector-submit  CustomEvent<{ file, aggregationConfig }>
 *
 * Rendering model: the static chrome, the metadata output container and the
 * GridLook iframe are built ONCE per open session; subsequent state changes
 * patch only the deltas. The output container and iframe are never recreated,
 * so scroll position, expand/collapse state and in-progress 3D rendering
 * survive re-renders.
 */

import type { AggregationConfigValues } from "../types";
import { NcDumpDialogState } from "../types";

const DEFAULT_AGG_CONFIG: AggregationConfigValues = {
  aggregate: "auto",
  join: null,
  compat: null,
  data_vars: null,
  coords: null,
  dim: "",
  group_by: "",
  reload: false,
  access_pattern: "map",
  chunk_size: 16.0,
  map_primary_chunksize: 1,
  timeout: 120,
};

const GRIDLOOK_BASE = "https://gridlook.pages.dev/";

/**
 * Build the GridLook viewer URL for a Zarr URL.
 *
 * GridLook reads `location.hash` verbatim as the store URL and does NOT decode
 * it, so the Zarr URL is placed in the fragment RAW (not percent-encoded);
 * encoding it makes GridLook fetch a mangled URL. The URL is never interpolated
 * into HTML - it is assigned via the iframe `src` property and shown via
 * `textContent` - so a raw value cannot inject markup or attributes.
 */
function gridlookUrl(zarrUrl: string): string {
  return `${GRIDLOOK_BASE}#${zarrUrl}`;
}

/** Copy text using the async Clipboard API, falling back to execCommand. */
function copyText(text: string): Promise<void> {
  const nav = navigator as Navigator & {
    clipboard?: { writeText?: (s: string) => Promise<void> };
  };
  if (nav.clipboard?.writeText) return nav.clipboard.writeText(text);
  return new Promise<void>((resolve, reject) => {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      resolve();
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

// ── Inline SVG icons (no Font Awesome dependency) ─────────────────────────────

function ico(inner: string, mr = false): string {
  return `<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" style="vertical-align:-0.14em;flex-shrink:0${mr ? ";margin-right:.5em" : ""}">${inner}</svg>`;
}

const IC = {
  info: `<circle cx="12" cy="12" r="9"/><path d="M12 11.5v5"/><circle cx="12" cy="7.8" r="0.6" fill="currentColor" stroke="none"/>`,
  layers: `<path d="M12 3 3 8l9 5 9-5-9-5Z"/><path d="m3 13 9 5 9-5"/>`,
  load: `<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 4v4h-4"/>`,
  chevronDown: `<path d="m6 9 6 6 6-6"/>`,
  ban: `<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>`,
  link: `<path d="M9.5 13.5a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 1 0-5.7-5.7l-1 1"/><path d="M14.5 10.5a4 4 0 0 0-5.7 0l-2.8 2.8a4 4 0 1 0 5.7 5.7l1-1"/>`,
  copy: `<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>`,
  check: `<path d="M20 6 9 17l-5-5"/>`,
  database: `<ellipse cx="12" cy="5.5" rx="8" ry="3"/><path d="M4 5.5v13c0 1.66 3.58 3 8 3s8-1.34 8-3v-13"/><path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3"/>`,
  cube: `<path d="M12 3 3 7.5v9L12 21l9-4.5v-9L12 3Z"/><path d="m3 7.5 9 4.5 9-4.5"/><path d="M12 12v9"/>`,
  external: `<path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M19 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4"/>`,
  refresh: `<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 4v4h-4"/>`,
  compress: `<path d="M9 5v4H5"/><path d="m4 4 5 5"/><path d="M15 5v4h4"/><path d="m20 4-5 5"/><path d="M9 19v-4H5"/><path d="m4 20 5-5"/><path d="M15 19v-4h4"/><path d="m20 20-5-5"/>`,
  alert: `<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5"/><circle cx="12" cy="16.3" r="0.6" fill="currentColor" stroke="none"/>`,
} as const;

// ── Chrome stylesheet (shipped, injected once) ────────────────────────────────
//
// Theming: the chrome is driven by host-adjustable CSS custom properties
//   --di-bg --di-fg --di-muted --di-border --di-surface --di-accent
// A host sets any of these (on the <data-inspector> element, or on any
// ancestor - e.g. scoped to its own dark-scheme selector) and the element
// follows. These public knobs are resolved into internal --_di-* variables so
// that `prefers-color-scheme: dark` can supply *fallback defaults* WITHOUT
// blocking a host override: the media query only changes the default passed to
// `var(--di-*, …)`, so an explicit host value always wins. Light is the base
// default. Error colors stay semantic (red) and are intentionally not themed.

const CHROME_CSS = `
data-inspector{
  --_di-bg:var(--di-bg,#fff);
  --_di-fg:var(--di-fg,#1f2937);
  --_di-muted:var(--di-muted,#6b7280);
  --_di-border:var(--di-border,#e5e7eb);
  --_di-surface:var(--di-surface,#f3f4f6);
  --_di-accent:var(--di-accent,#3b82f6);
}
@media (prefers-color-scheme:dark){
  data-inspector{
    --_di-bg:var(--di-bg,#1e293b);
    --_di-fg:var(--di-fg,#e5e7eb);
    --_di-muted:var(--di-muted,#94a3b8);
    --_di-border:var(--di-border,#475569);
    --_di-surface:var(--di-surface,#334155);
    --_di-accent:var(--di-accent,#3b82f6);
  }
}
.di-backdrop{position:fixed;inset:0;z-index:1050;display:flex;align-items:center;justify-content:center;padding:12px;background:rgba(15,23,42,.55);}
.di-modal{display:flex;flex-direction:column;width:min(1100px,96vw);max-height:95vh;overflow:hidden;background:var(--_di-bg);color:var(--_di-fg);border-radius:12px;box-shadow:0 20px 50px rgba(0,0,0,.25);font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:14px;line-height:1.5;}
.di-header{flex-shrink:0;border-bottom:1px solid var(--_di-border);padding:16px 16px 12px;}
.di-header-row{display:flex;justify-content:space-between;align-items:flex-start;gap:8px;}
.di-header-main{flex:1;min-width:0;}
.di-title{margin:0 0 12px;font-size:clamp(16px,4vw,20px);font-weight:600;display:flex;align-items:center;gap:8px;}
.di-title-ico{color:var(--_di-accent);display:inline-flex;align-items:center;font-size:16px;}
.di-close{flex-shrink:0;width:32px;height:32px;font-size:28px;line-height:1;background:transparent;border:none;border-radius:6px;color:var(--_di-muted);cursor:pointer;}
.di-close:hover{background:var(--_di-surface);color:var(--_di-fg);}
.di-muted{color:var(--_di-muted);}
.di-center{text-align:center;padding:24px 12px;}
.di-file-list{margin-bottom:12px;padding:10px;background:var(--_di-surface);border-radius:6px;max-height:120px;overflow-y:auto;}
.di-file-list-label{font-size:12px;color:var(--_di-muted);margin-bottom:6px;font-weight:500;}
.di-file-list ul{font-size:11px;margin:0;padding-left:20px;}
.di-file-list li{color:var(--_di-fg);word-break:break-all;}
.di-pathbar{margin-bottom:8px;}
.di-pathbar-label{display:block;font-size:12px;color:var(--_di-muted);margin-bottom:4px;font-weight:500;}
.di-pathbar-row{display:flex;gap:6px;flex-wrap:wrap;}
.di-input{flex:1 1 200px;min-width:0;font-size:13px;padding:6px 10px;border:1px solid var(--_di-border);border-radius:6px;color:var(--_di-fg);background:var(--_di-bg);}
.di-input:focus{outline:2px solid var(--_di-accent);outline-offset:0;border-color:var(--_di-accent);}
.di-dropdown-wrap{position:relative;flex-shrink:0;display:inline-flex;}
.di-btn{display:inline-flex;align-items:center;justify-content:center;font-size:13px;font-weight:500;border-radius:6px;border:1px solid transparent;padding:6px 12px;cursor:pointer;white-space:nowrap;background:var(--_di-bg);color:var(--_di-fg);}
.di-btn:disabled{opacity:.5;cursor:not-allowed;}
.di-btn-primary{background:var(--_di-accent);border-color:var(--_di-accent);color:#fff;}
.di-btn-primary:hover:not(:disabled){filter:brightness(.93);}
.di-btn-secondary{background:var(--_di-surface);border-color:var(--_di-surface);color:var(--_di-fg);}
.di-btn-outline{background:var(--_di-bg);border-color:var(--_di-border);color:var(--_di-fg);}
.di-btn-split{padding:6px 9px;border-top-left-radius:0;border-bottom-left-radius:0;border-left-color:rgba(255,255,255,.4);}
.di-btn-group{display:inline-flex;}
.di-btn-group>.di-btn:first-child{border-top-right-radius:0;border-bottom-right-radius:0;}
.di-menu{position:absolute;top:100%;right:0;z-index:1060;min-width:210px;margin-top:2px;padding:6px 0;background:var(--_di-bg);border:1px solid var(--_di-border);border-radius:8px;box-shadow:0 10px 25px rgba(0,0,0,.12);list-style:none;}
.di-menu-item{display:flex;align-items:center;width:100%;padding:8px 14px;font-size:13px;background:none;border:none;color:var(--_di-fg);cursor:pointer;text-align:left;}
.di-menu-item:hover{background:var(--_di-surface);}
.di-zarr-row{display:flex;align-items:center;flex-wrap:wrap;gap:6px;padding:8px 10px;background:var(--_di-surface);border-radius:6px;font-size:11px;margin-bottom:8px;}
.di-zarr-inner{display:flex;align-items:center;gap:6px;flex:1 1 100%;min-width:0;}
.di-code{flex:1;min-width:0;background:var(--_di-bg);padding:4px 8px;border-radius:4px;font-size:10px;color:var(--_di-fg);border:1px solid var(--_di-border);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}
.di-tabs{display:flex;gap:2px;border-bottom:2px solid var(--_di-border);}
.di-tab{padding:12px 16px;font-size:14px;font-weight:500;background:transparent;border:none;border-bottom:3px solid transparent;color:var(--_di-muted);cursor:pointer;transition:all .15s ease;display:inline-flex;align-items:center;}
.di-tab:disabled{opacity:.5;cursor:not-allowed;}
.di-tab-active{font-weight:600;background:var(--_di-surface);border-bottom-color:var(--_di-accent);color:var(--_di-fg);}
.di-body{flex:1;overflow-y:auto;overflow-x:hidden;padding:16px 12px;max-height:calc(95vh - 200px);}
.di-error{border-radius:8px;background:#fee2e2;border:1px solid #fecaca;color:#991b1b;font-size:13px;padding:12px;margin-bottom:16px;}
.di-error-row{display:flex;align-items:flex-start;gap:10px;}
.di-error-ico{font-size:18px;margin-top:1px;flex-shrink:0;}
.di-error-body{flex:1;min-width:0;}
.di-error-title{display:block;margin-bottom:6px;}
.di-error-msg{word-wrap:break-word;overflow-wrap:anywhere;white-space:pre-wrap;}
.di-btn-danger{background:#dc2626;border-color:#dc2626;color:#fff;font-size:12px;padding:6px 12px;margin-top:8px;}
.di-metadata{display:flex;justify-content:flex-start;width:100%;overflow-x:auto;}
.di-metadata>*{width:100%;min-width:0;}
.di-metadata dd,.di-metadata .xr-attrs td,.di-metadata .xr-var-attrs td{overflow-wrap:anywhere;word-break:break-word;}
.di-gridlook-bar{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:12px;background:var(--_di-surface);border-radius:8px;font-size:12px;margin-bottom:16px;border:1px solid var(--_di-border);}
.di-gridlook-inner{display:flex;align-items:center;gap:6px;flex:1 1 100%;min-width:0;}
.di-gridlook-ico{color:var(--_di-accent);flex-shrink:0;display:inline-flex;}
.di-gridlook-label{color:var(--_di-accent);font-weight:600;flex-shrink:0;}
.di-gridlook-code{flex:1;min-width:0;background:var(--_di-bg);padding:6px 10px;border-radius:4px;font-size:11px;color:var(--_di-fg);border:1px solid var(--_di-border);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}
.di-gridlook-btn{background:var(--_di-bg);border:1px solid var(--_di-accent);color:var(--_di-accent);font-size:12px;padding:6px 12px;flex-shrink:0;}
.di-gridlook-btn-primary{background:var(--_di-accent);border-color:var(--_di-accent);color:#fff;}
.di-gridlook-frame{width:100%;height:calc(95vh - 280px);min-height:500px;background:var(--_di-surface);border-radius:8px;overflow:hidden;border:1px solid var(--_di-border);}
.di-gridlook-frame iframe{width:100%;height:100%;border:none;display:block;}
.di-agg-form{padding:16px;overflow-y:auto;}
.di-agg-form h5{margin:0 0 12px;font-size:1.05rem;font-weight:600;}
.di-agg-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px;}
.di-empty-ico{font-size:40px;color:var(--_di-border);margin-bottom:12px;display:block;}
.di-empty-text{color:var(--_di-muted);font-size:13px;padding:0 12px;}
[hidden]{display:none!important;}
`;

let chromeInjected = false;
function injectChromeCss(): void {
  if (chromeInjected) return;
  if (typeof document === "undefined") return;
  chromeInjected = true;
  const style = document.createElement("style");
  style.setAttribute("data-data-inspector", "1");
  style.textContent = CHROME_CSS;
  document.head.appendChild(style);
}

export class DataInspectorElement extends HTMLElement {
  // ── Internal state ────────────────────────────────────────────────────────
  private _pathInput = "";
  private _copied = false;
  private _gridlookCopied = false;
  private _activeTab: "metadata" | "gridlook" = "metadata";
  private _dropdownOpen = false;
  private _aggregationConfig: AggregationConfigValues = { ...DEFAULT_AGG_CONFIG };
  private _output: string | null = null;

  // ── Render bookkeeping ────────────────────────────────────────────────────
  private _built = false;
  private _builtMode = false;
  private _domOutput: string | null | undefined = undefined;
  private _domIframeUrl: string | undefined = undefined;
  private _domFileKey: string | undefined = undefined;
  private _copyTimer: ReturnType<typeof setTimeout> | null = null;
  private _gridlookTimer: ReturnType<typeof setTimeout> | null = null;
  private _restoreFocusTo: Element | null = null;

  // ── Observed attributes ───────────────────────────────────────────────────
  static get observedAttributes(): string[] {
    return ["open", "file", "status", "error", "zarr-url", "zarr-status-code", "is-aggregation"];
  }

  // ── Attribute accessors ───────────────────────────────────────────────────
  get open(): boolean {
    return this.hasAttribute("open");
  }
  set open(v: boolean) {
    v ? this.setAttribute("open", "") : this.removeAttribute("open");
  }

  get file(): string | string[] | null {
    const a = this.getAttribute("file");
    if (!a) return null;
    try {
      return JSON.parse(a) as string[];
    } catch {
      return a;
    }
  }
  set file(v: string | string[] | null) {
    if (v === null) this.removeAttribute("file");
    else this.setAttribute("file", Array.isArray(v) ? JSON.stringify(v) : v);
  }

  get status(): string {
    return this.getAttribute("status") ?? NcDumpDialogState.READY;
  }
  set status(v: string) {
    this.setAttribute("status", v);
  }

  /** Trusted xarray-repr HTML string. Setting triggers re-render. */
  get output(): string | null {
    return this._output;
  }
  set output(v: string | null) {
    this._output = v;
    if (this.isConnected) this._render();
  }

  get error(): string | null {
    return this.getAttribute("error");
  }
  set error(v: string | null) {
    if (v === null) this.removeAttribute("error");
    else this.setAttribute("error", v);
  }

  get zarrUrl(): string | null {
    return this.getAttribute("zarr-url");
  }
  set zarrUrl(v: string | null) {
    v === null ? this.removeAttribute("zarr-url") : this.setAttribute("zarr-url", v);
  }

  get zarrStatusCode(): number | null {
    const v = this.getAttribute("zarr-status-code");
    return v === null ? null : parseInt(v, 10);
  }
  set zarrStatusCode(v: number | null) {
    v === null
      ? this.removeAttribute("zarr-status-code")
      : this.setAttribute("zarr-status-code", String(v));
  }

  get isAggregation(): boolean {
    return this.hasAttribute("is-aggregation");
  }
  set isAggregation(v: boolean) {
    v ? this.setAttribute("is-aggregation", "") : this.removeAttribute("is-aggregation");
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  connectedCallback(): void {
    const f = this.file;
    if (f && !Array.isArray(f)) this._pathInput = f;

    if (this.open) this._restoreFocusTo = document.activeElement;
    this._render();
    document.addEventListener("mousedown", this._onOutsideClick);
  }

  disconnectedCallback(): void {
    document.removeEventListener("mousedown", this._onOutsideClick);
    this._clearTimers();
  }

  attributeChangedCallback(name: string, oldVal: string | null, val: string | null): void {
    if (name === "open" && val !== null) {
      // Opened: remember what to restore focus to, reset to metadata tab,
      // clear transient flags, auto-submit in single-file mode.
      if (this._restoreFocusTo === null) this._restoreFocusTo = document.activeElement;
      this._activeTab = "metadata";
      this._copied = false;
      this._gridlookCopied = false;
      const f = this.file;
      if (
        f &&
        this._output === null &&
        this.status === NcDumpDialogState.READY &&
        !this.isAggregation
      ) {
        this._emit("inspector-submit", { file: f, aggregationConfig: null });
      }
    }

    if (name === "file") {
      if (val && !val.startsWith("[")) this._pathInput = val;
      // A genuine file change invalidates everything derived from the old file.
      if (oldVal !== null && oldVal !== val) {
        this._output = null;
        this._domOutput = undefined;
        this._activeTab = "metadata";
        this._copied = false;
        this._gridlookCopied = false;
        if (this.hasAttribute("error")) this.removeAttribute("error");
        if (this.hasAttribute("zarr-url")) this.removeAttribute("zarr-url");
      }
    }

    // Entering the error state returns to the metadata tab so the error banner
    // is shown on its own (no stale metadata / 3D viewer behind it).
    if (name === "status" && val === NcDumpDialogState.ERROR) {
      this._activeTab = "metadata";
    }

    // zarr-status-code only needs to reach the loading-steps children.
    if (name === "zarr-status-code" && this.isConnected && this._built) {
      const code = val ?? "3";
      this.querySelector("#nc-pre-steps")?.setAttribute("status-code", code);
      this.querySelector("#nc-body-steps")?.setAttribute("status-code", code);
      return;
    }

    if (this.isConnected) this._render();
  }

  // ── Event helpers ─────────────────────────────────────────────────────────
  private _emit(name: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true, detail }));
  }

  private _onOutsideClick = (e: MouseEvent): void => {
    const wrap = this.querySelector("#nc-dropdown-wrap");
    if (wrap && !wrap.contains(e.target as Node) && this._dropdownOpen) {
      this._dropdownOpen = false;
      this._syncDropdown();
    }
  };

  private _clearTimers(): void {
    if (this._copyTimer !== null) {
      clearTimeout(this._copyTimer);
      this._copyTimer = null;
    }
    if (this._gridlookTimer !== null) {
      clearTimeout(this._gridlookTimer);
      this._gridlookTimer = null;
    }
  }

  // ── Action handlers ───────────────────────────────────────────────────────
  private _handleInspect(): void {
    if (this.isAggregation) {
      this._emit("inspector-submit", {
        file: this.file,
        aggregationConfig: this._aggregationConfig,
      });
    } else if (this._pathInput.trim()) {
      this._emit("inspector-submit", { file: this._pathInput.trim(), aggregationConfig: null });
    }
  }

  private _handleInspectReload(): void {
    this._dropdownOpen = false;
    this._syncDropdown();
    if (this._pathInput.trim()) {
      this._emit("inspector-submit", {
        file: this._pathInput.trim(),
        aggregationConfig: { reload: true },
      });
    }
  }

  private _copy(text: string, which: "zarr" | "gridlook"): void {
    copyText(text)
      .then(() => {
        if (which === "zarr") this._copied = true;
        else this._gridlookCopied = true;
        if (this.open) this._update();
        const reset = (): void => {
          if (which === "zarr") this._copied = false;
          else this._gridlookCopied = false;
          if (this.isConnected && this.open) this._update();
        };
        const t = setTimeout(reset, 2000);
        if (which === "zarr") this._copyTimer = t;
        else this._gridlookTimer = t;
      })
      .catch(() => {
        /* clipboard unavailable; no feedback */
      });
  }

  // ── Render orchestration ──────────────────────────────────────────────────
  private _render(): void {
    if (!this.open) {
      this._teardown();
      return;
    }
    if (!this._built || this._builtMode !== this.isAggregation) this._build();
    this._update();
  }

  private _teardown(): void {
    this._clearTimers();
    this.innerHTML = "";
    this._built = false;
    this._domOutput = undefined;
    this._domIframeUrl = undefined;
    this._domFileKey = undefined;
    const restore = this._restoreFocusTo as HTMLElement | null;
    this._restoreFocusTo = null;
    if (restore && restore.isConnected && typeof restore.focus === "function") {
      restore.focus();
    }
  }

  private _q<T extends Element = HTMLElement>(sel: string): T | null {
    return this.querySelector<T>(sel);
  }

  private _toggle(el: Element | null, show: boolean): void {
    if (el) (el as HTMLElement).hidden = !show;
  }

  private _setCopyBtn(sel: string, copied: boolean, baseTitle: string): void {
    const btn = this._q(sel);
    if (!btn) return;
    btn.setAttribute("title", copied ? "Copied!" : baseTitle);
    btn.innerHTML = ico(copied ? IC.check : IC.copy);
  }

  // ── Build the static skeleton (once per open session / mode) ───────────────
  private _build(): void {
    injectChromeCss();
    const agg = this.isAggregation;
    this._builtMode = agg;
    this._domOutput = undefined;
    this._domIframeUrl = undefined;
    this._domFileKey = undefined;

    const header = `
      <div class="di-header">
        <div class="di-header-row">
          <div class="di-header-main">
            <h1 class="di-title">
              <span class="di-title-ico">${ico(agg ? IC.layers : IC.info)}</span>
              <span id="nc-title">${agg ? "Aggregate Files" : "File Inspector"}</span>
            </h1>
            ${
              agg
                ? `<div id="nc-file-list-wrap" class="di-file-list" hidden>
                     <div id="nc-file-list-label" class="di-file-list-label"></div>
                     <ul id="nc-file-list"></ul>
                   </div>`
                : this._pathBarHtml()
            }
            <div id="nc-zarr-row" class="di-zarr-row" hidden>
              <div class="di-zarr-inner">
                <span class="di-muted" style="display:inline-flex;flex-shrink:0">${ico(IC.link)}</span>
                <span class="di-muted" style="font-weight:500;flex-shrink:0">Zarr:</span>
                <code id="nc-zarr-url" class="di-code"></code>
                <button id="nc-copy-zarr" class="di-btn di-btn-outline" title="Copy Zarr URL">${ico(IC.copy)}</button>
              </div>
            </div>
          </div>
          <button id="nc-close-btn" class="di-close" aria-label="Close">&times;</button>
        </div>
      </div>`;

    const aggForm = agg
      ? `<div id="nc-agg-form" class="di-agg-form" hidden>
           <h5>Aggregation Configuration</h5>
           <aggregation-config id="nc-agg-config"></aggregation-config>
           <div class="di-agg-actions">
             <button id="nc-cancel-btn" class="di-btn di-btn-secondary">Cancel</button>
             <button id="nc-aggregate-btn" class="di-btn di-btn-primary">${ico(IC.compress, true)}Aggregate Files</button>
           </div>
         </div>`
      : "";

    const preLoading = `
      <div id="nc-pre-loading" class="di-center" hidden>
        <zarr-loading-steps id="nc-pre-steps" status-code="3"${agg ? " is-aggregation" : ""}></zarr-loading-steps>
        <p id="nc-pre-loading-text" class="di-muted" style="margin-top:12px;font-size:13px;"></p>
      </div>`;

    const tabsWrap = `
      <div id="nc-tabs-wrap" hidden>
        <div class="di-tabs" role="tablist" aria-label="Inspector views">
          <button id="nc-tab-metadata" data-tab="metadata" class="nc-tab-btn di-tab" role="tab" aria-controls="nc-metadata" aria-selected="true">${ico(IC.database, true)}Metadata</button>
          <button id="nc-tab-gridlook" data-tab="gridlook" class="nc-tab-btn di-tab" role="tab" aria-controls="nc-gridlook" aria-selected="false">${ico(IC.cube, true)}3D Viewer</button>
        </div>
        <div id="nc-body" class="di-body">
          <div id="nc-error" class="di-error" hidden>
            <div class="di-error-row">
              <span class="di-error-ico">${ico(IC.alert)}</span>
              <div class="di-error-body">
                <strong class="di-error-title">Error loading metadata</strong>
                <div id="nc-error-msg" class="di-error-msg"></div>
                <button id="nc-retry-btn" class="di-btn di-btn-danger">${ico(IC.refresh, true)}Retry</button>
              </div>
            </div>
          </div>

          <div id="nc-loading" class="di-center" hidden>
            <zarr-loading-steps id="nc-body-steps" status-code="3"${agg ? " is-aggregation" : ""}></zarr-loading-steps>
            <p id="nc-loading-text" class="di-muted" style="margin-top:12px;font-size:13px;"></p>
          </div>

          <div id="nc-metadata" class="di-metadata" role="tabpanel" aria-labelledby="nc-tab-metadata" tabindex="0" hidden>
            <div id="nc-metadata-inner"></div>
          </div>

          <div id="nc-gridlook" role="tabpanel" aria-labelledby="nc-tab-gridlook" tabindex="0" hidden>
            <div class="di-gridlook-bar">
              <div class="di-gridlook-inner">
                <span class="di-gridlook-ico">${ico(IC.external)}</span>
                <span class="di-gridlook-label">GridLook URL:</span>
                <code id="nc-gridlook-url" class="di-gridlook-code"></code>
                <button id="nc-copy-gridlook" class="di-btn di-gridlook-btn" title="Copy link">${ico(IC.copy)}</button>
                <button id="nc-refresh-gridlook" class="di-btn di-gridlook-btn" title="Refresh GridLook viewer">${ico(IC.refresh)}</button>
                <button id="nc-open-gridlook" class="di-btn di-gridlook-btn-primary" title="Open in new tab">${ico(IC.external, true)}Open in New Tab</button>
              </div>
            </div>
            <div id="nc-gridlook-frame" class="di-gridlook-frame"></div>
          </div>

          <div id="nc-empty-body" class="di-center" hidden>
            <span class="di-empty-ico">${ico(IC.database)}</span>
            <p id="nc-empty-body-text" class="di-empty-text"></p>
          </div>
        </div>
      </div>`;

    const emptyMain = `
      <div id="nc-empty-main" class="di-center" hidden>
        <span class="di-empty-ico">${ico(IC.database)}</span>
        <p id="nc-empty-main-text" class="di-empty-text"></p>
      </div>`;

    this.innerHTML = `
      <div id="nc-backdrop" class="di-backdrop">
        <div class="di-modal" role="dialog" aria-modal="true" aria-labelledby="nc-title" tabindex="-1">
          ${header}
          ${aggForm}
          ${preLoading}
          ${tabsWrap}
          ${emptyMain}
        </div>
      </div>`;

    // Aggregation config: set initial-config via the DOM API (no HTML parsing
    // of the JSON, so config string values cannot inject markup).
    this._q("#nc-agg-config")?.setAttribute(
      "initial-config",
      JSON.stringify(this._aggregationConfig),
    );

    // Create the GridLook iframe on first use and keep it for the life of the
    // session. It is never recreated by `_update`, so its browsing context
    // (camera, loaded data, in-progress WebGL render) survives re-renders.

    this._built = true;
    this._attach();
    this._initialFocus();
  }

  private _ensureIframe(): HTMLIFrameElement | null {
    const existing = this._q<HTMLIFrameElement>("#nc-gridlook-iframe");
    if (existing) return existing;
    const frame = this._q("#nc-gridlook-frame");
    if (!frame) return null;
    const iframe = document.createElement("iframe");
    iframe.id = "nc-gridlook-iframe";
    iframe.title = "GridLook 3D Viewer";
    iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-popups allow-downloads");
    iframe.setAttribute("referrerpolicy", "no-referrer");
    iframe.setAttribute("loading", "lazy");
    try {
      frame.appendChild(iframe);
    } catch {
      /* iframe page loading may be disabled (e.g. test env) */
    }
    return iframe;
  }

  /** Assign an iframe src defensively (never let a load error abort a render). */
  private _setIframeSrc(iframe: HTMLIFrameElement, url: string): void {
    try {
      iframe.src = url;
    } catch {
      /* iframe page loading may be disabled (e.g. test env) */
    }
  }

  private _pathBarHtml(): string {
    return `
      <div class="di-pathbar">
        <label class="di-pathbar-label" for="nc-path-input">File path:</label>
        <div class="di-pathbar-row">
          <input id="nc-path-input" type="text" class="di-input" placeholder="/path/to/data.nc" />
          <div id="nc-dropdown-wrap" class="di-dropdown-wrap di-btn-group">
            <button id="nc-load-btn" class="di-btn di-btn-primary">${ico(IC.load, true)}Load</button>
            <button id="nc-load-toggle" class="di-btn di-btn-primary di-btn-split" title="More load options">${ico(IC.chevronDown)}</button>
            <ul id="nc-dropdown-menu" class="di-menu" hidden>
              <li>
                <button id="nc-reload-btn" class="di-menu-item">${ico(IC.ban, true)}Force Reload (bypass cache)</button>
              </li>
            </ul>
          </div>
        </div>
      </div>`;
  }

  // ── Attach listeners once (nodes persist across updates) ───────────────────
  private _attach(): void {
    this._q("#nc-backdrop")?.addEventListener("click", (e) => {
      if (e.target === e.currentTarget) this._emit("inspector-close", null);
    });
    this._q("#nc-backdrop")?.addEventListener("keydown", (e) =>
      this._onKeydown(e as KeyboardEvent),
    );
    this._q("#nc-close-btn")?.addEventListener("click", () => this._emit("inspector-close", null));
    this._q("#nc-cancel-btn")?.addEventListener("click", () => this._emit("inspector-close", null));
    this._q("#nc-load-btn")?.addEventListener("click", () => this._handleInspect());
    this._q("#nc-aggregate-btn")?.addEventListener("click", () => this._handleInspect());
    this._q("#nc-retry-btn")?.addEventListener("click", () => this._handleInspect());

    const pathInput = this._q<HTMLInputElement>("#nc-path-input");
    if (pathInput) {
      pathInput.value = this._pathInput;
      pathInput.addEventListener("input", (e) => {
        this._pathInput = (e.target as HTMLInputElement).value;
      });
      pathInput.addEventListener("keypress", (e) => {
        if ((e as KeyboardEvent).key === "Enter") this._handleInspect();
      });
    }

    this._q("#nc-load-toggle")?.addEventListener("click", () => {
      this._dropdownOpen = !this._dropdownOpen;
      this._syncDropdown();
    });
    this._q("#nc-reload-btn")?.addEventListener("click", () => this._handleInspectReload());

    this._q("#nc-copy-zarr")?.addEventListener("click", () => {
      const url = this.zarrUrl;
      if (url) this._copy(url, "zarr");
    });
    this._q("#nc-copy-gridlook")?.addEventListener("click", () => {
      const url = this.zarrUrl;
      if (url) this._copy(gridlookUrl(url), "gridlook");
    });
    this._q("#nc-refresh-gridlook")?.addEventListener("click", () => {
      // Force a real reload. Setting src="" then back to the same URL in one
      // tick is unreliable (can stick on about:blank). Instead drop the frame,
      // reset the cache, and let the render path re-create it from the known
      // zarrUrl - guaranteeing a fresh load and a recoverable sync.
      if (!this.zarrUrl) return;
      this._q("#nc-gridlook-iframe")?.remove();
      this._domIframeUrl = undefined;
      this._update();
    });
    this._q("#nc-open-gridlook")?.addEventListener("click", () => {
      const url = this.zarrUrl;
      if (url) window.open(gridlookUrl(url), "_blank", "noopener,noreferrer");
    });

    this.querySelectorAll<HTMLButtonElement>(".nc-tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tab = btn.dataset["tab"] as "metadata" | "gridlook" | undefined;
        if (tab && !btn.disabled) {
          this._activeTab = tab;
          this._update();
        }
      });
    });

    this._q("#nc-agg-config")?.addEventListener("config-change", (e) => {
      this._aggregationConfig = (e as CustomEvent<AggregationConfigValues>).detail;
    });
  }

  // ── Patch dynamic state (no DOM rebuild) ───────────────────────────────────
  private _update(): void {
    const agg = this.isAggregation;
    const status = this.status;
    const isLoading = status === NcDumpDialogState.LOADING;
    const isReady = status === NcDumpDialogState.READY;
    const isError = status === NcDumpDialogState.ERROR;
    const zarrUrl = this.zarrUrl;
    const file = this.file;
    const fileList = Array.isArray(file) ? file : [];
    const hasOutput = this._output != null && this._output !== "";
    const code = String(this.zarrStatusCode ?? 3);
    const loadingText = agg ? "Aggregating files and loading metadata..." : "Loading metadata...";
    const emptyText = agg
      ? "Configure aggregation settings and click 'Aggregate Files' to begin"
      : "Enter a file path and click Load to inspect metadata";

    // Aggregation file list
    if (agg) {
      const wrap = this._q("#nc-file-list-wrap");
      const show = fileList.length > 0;
      this._toggle(wrap, show);
      if (show) {
        const label = this._q("#nc-file-list-label");
        if (label) label.textContent = `Selected files (${fileList.length}):`;
        const ul = this._q("#nc-file-list");
        const key = fileList.join("\u0000");
        if (ul && this._domFileKey !== key) {
          ul.replaceChildren(
            ...fileList.map((f) => {
              const li = document.createElement("li");
              li.textContent = f;
              return li;
            }),
          );
          this._domFileKey = key;
        }
      }
    }

    // Path bar (single-file mode)
    if (!agg) {
      const loadBtn = this._q<HTMLButtonElement>("#nc-load-btn");
      const toggleBtn = this._q<HTMLButtonElement>("#nc-load-toggle");
      if (loadBtn) loadBtn.disabled = isLoading;
      if (toggleBtn) toggleBtn.disabled = isLoading;
      this._syncDropdown();
    }

    // Zarr URL row - shown only when the resolved store URL genuinely DIFFERS
    // from the inspected input (i.e. a real server-side conversion produced a
    // new URL). When the input is already a Zarr store (zarrUrl === file), the
    // path row already shows it, so suppress this duplicate row.
    const fileStr = typeof file === "string" ? file : null;
    const showZarrRow = !!zarrUrl && zarrUrl !== fileStr;
    this._toggle(this._q("#nc-zarr-row"), showZarrRow);
    if (showZarrRow && zarrUrl) {
      const codeEl = this._q("#nc-zarr-url");
      if (codeEl) codeEl.textContent = zarrUrl;
    }
    this._setCopyBtn("#nc-copy-zarr", this._copied, "Copy Zarr URL");

    // Top-level regions
    if (agg) this._toggle(this._q("#nc-agg-form"), isReady && !hasOutput);
    this._toggle(this._q("#nc-pre-loading"), !zarrUrl && isLoading);
    this._toggle(this._q("#nc-tabs-wrap"), !!zarrUrl && (hasOutput || isLoading || isError));
    this._toggle(this._q("#nc-empty-main"), !zarrUrl && !isLoading && isReady && !hasOutput);

    const preText = this._q("#nc-pre-loading-text");
    if (preText) preText.textContent = loadingText;
    this._q("#nc-pre-steps")?.setAttribute("status-code", code);

    // Tabs
    const metaTab = this._q<HTMLButtonElement>('[data-tab="metadata"]');
    const gridTab = this._q<HTMLButtonElement>('[data-tab="gridlook"]');
    if (metaTab) {
      const active = this._activeTab === "metadata";
      metaTab.classList.toggle("di-tab-active", active);
      metaTab.setAttribute("aria-selected", String(active));
    }
    if (gridTab) {
      const active = this._activeTab === "gridlook";
      gridTab.disabled = status !== NcDumpDialogState.READY || !hasOutput;
      gridTab.classList.toggle("di-tab-active", active);
      gridTab.setAttribute("aria-selected", String(active));
    }

    // Body: error
    this._toggle(this._q("#nc-error"), isError && this._activeTab === "metadata");
    const errMsg = this._q("#nc-error-msg");
    if (errMsg) errMsg.textContent = this.error ?? "";

    // Body: loading
    this._toggle(this._q("#nc-loading"), isLoading);
    const bodyText = this._q("#nc-loading-text");
    if (bodyText) bodyText.textContent = loadingText;
    this._q("#nc-body-steps")?.setAttribute("status-code", code);

    // Body: metadata (persistent container; re-inject only when output changes).
    // Never shown in the error state - the error must appear alone.
    this._toggle(
      this._q("#nc-metadata"),
      this._activeTab === "metadata" && hasOutput && !isLoading && !isError,
    );
    const inner = this._q("#nc-metadata-inner");
    if (inner && this._domOutput !== this._output) {
      inner.innerHTML = this._output ?? ""; // trusted xarray-repr HTML
      this._domOutput = this._output;
    }

    // Body: gridlook (persistent iframe; created on first view, src set only
    // when the URL changes - never recreated on unrelated re-renders)
    const showGrid = this._activeTab === "gridlook" && !!zarrUrl;
    this._toggle(this._q("#nc-gridlook"), showGrid);
    if (zarrUrl) {
      const url = gridlookUrl(zarrUrl);
      const gridCode = this._q("#nc-gridlook-url");
      if (gridCode) gridCode.textContent = url;
      if (showGrid) {
        const iframe = this._ensureIframe();
        if (iframe && this._domIframeUrl !== url) {
          this._setIframeSrc(iframe, url);
          this._domIframeUrl = url;
        }
      }
    }
    this._setCopyBtn("#nc-copy-gridlook", this._gridlookCopied, "Copy link");

    // Body: empty
    this._toggle(this._q("#nc-empty-body"), !hasOutput && !isLoading && !isError);
    const eb = this._q("#nc-empty-body-text");
    if (eb) eb.textContent = emptyText;
    const em = this._q("#nc-empty-main-text");
    if (em) em.textContent = emptyText;
  }

  private _syncDropdown(): void {
    const menu = this._q("#nc-dropdown-menu");
    if (menu) (menu as HTMLElement).hidden = !this._dropdownOpen;
  }

  // ── Accessibility: focus trap, initial focus, Escape-to-close ─────────────
  private _focusables(): HTMLElement[] {
    const modal = this._q(".di-modal");
    if (!modal) return [];
    const sel =
      'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
    return Array.from(modal.querySelectorAll<HTMLElement>(sel)).filter(
      (el) => !el.closest("[hidden]"),
    );
  }

  private _initialFocus(): void {
    const target =
      this._q<HTMLElement>("#nc-path-input") ??
      this._focusables()[0] ??
      this._q<HTMLElement>(".di-modal");
    target?.focus?.();
  }

  private _onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.stopPropagation();
      this._emit("inspector-close", null);
      return;
    }
    if (e.key !== "Tab") return;
    const f = this._focusables();
    if (f.length === 0) {
      e.preventDefault();
      return;
    }
    const first = f[0];
    const last = f[f.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !this.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }
}

customElements.define("data-inspector", DataInspectorElement);
