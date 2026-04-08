/**
 * <data-inspector> — NetCDF / Zarr file inspection dialog.
 *
 * Replaces the NcdumpDialog React component with a framework-agnostic
 * custom element. Markup and styles are identical to the original.
 *
 * ── Attributes ─────────────────────────────────────────────────────────────
 *   open              Boolean — controls visibility
 *   file              String, or JSON-encoded string[] for aggregation mode
 *   status            "ready" | "loading" | "error"
 *   error             Error message string
 *   zarr-url          Presigned Zarr URL
 *   zarr-status-code  Number (backend status code from ZarrPoller)
 *   is-aggregation    Boolean
 *
 * ── JS-only properties ─────────────────────────────────────────────────────
 *   output            string | null  (HTML string from xarray repr; too large for an attribute)
 *
 * ── Events fired ───────────────────────────────────────────────────────────
 *   inspector-close   —  replaces onClose prop
 *   inspector-submit  CustomEvent<{ file, aggregationConfig }>  — replaces submitNcdump prop
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

export class DataInspectorElement extends HTMLElement {
  // ── Internal state ────────────────────────────────────────────────────────
  private _pathInput = "";
  private _copied = false;
  private _gridlookCopied = false;
  private _activeTab: "metadata" | "gridlook" = "metadata";
  private _dropdownOpen = false;
  private _aggregationConfig: AggregationConfigValues = { ...DEFAULT_AGG_CONFIG };
  private _output: string | null = null;

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

  /** JS-only property — HTML string from xarray repr. Setting triggers re-render. */
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

    this._render();
    document.addEventListener("mousedown", this._onOutsideClick);
  }

  disconnectedCallback(): void {
    document.removeEventListener("mousedown", this._onOutsideClick);
  }

  attributeChangedCallback(name: string, _old: string | null, val: string | null): void {
    if (name === "open") {
      if (val !== null) {
        // Opened: reset to metadata tab, auto-submit in single-file mode
        this._activeTab = "metadata";
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
    }

    if (name === "file" && val && !val.startsWith("[")) {
      this._pathInput = val;
    }

    // Targeted update: zarr-status-code only needs to propagate to child element
    if (name === "zarr-status-code" && this.isConnected) {
      const steps = this.querySelector("zarr-loading-steps");
      if (steps) {
        steps.setAttribute("status-code", val ?? "3");
        return; // skip full re-render
      }
    }

    if (this.isConnected) this._render();
  }

  // ── Event helpers ─────────────────────────────────────────────────────────
  private _emit(name: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true, detail }));
  }

  private _onOutsideClick = (e: MouseEvent): void => {
    const dropdownParent = this.querySelector(".nc-dropdown-wrap");
    if (dropdownParent && !dropdownParent.contains(e.target as Node)) {
      this._dropdownOpen = false;
      this._syncDropdown();
    }
  };

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

  // ── Render ────────────────────────────────────────────────────────────────
  private _render(): void {
    if (!this.open) {
      this.innerHTML = "";
      return;
    }

    // _pathInput is the source of truth — kept up to date by:
    //   - attributeChangedCallback when `file` attribute changes
    //   - the input's `input` event listener when the user types
    // We only need to track focus so we can restore it after re-render.
    const wasFocused = document.activeElement?.id === "nc-path-input";

    const { file, status, zarrUrl, zarrStatusCode, isAggregation } = this;
    const fileList = Array.isArray(file) ? file : [];
    const isLoading = status === NcDumpDialogState.LOADING;
    const isReady = status === NcDumpDialogState.READY;
    const isError = status === NcDumpDialogState.ERROR;

    this.innerHTML = `
      <div id="nc-backdrop" class="token-modal show"
        style="display:flex;align-items:center;justify-content:center;padding:12px;">
        <div class="token-modal-content"
          style="max-width:1200px;width:100%;max-height:95vh;display:flex;flex-direction:column;">

          <!-- ── Header ── -->
          <div class="token-header"
            style="flex-shrink:0;border-bottom:1px solid #e5e7eb;padding-bottom:12px;">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
              <div style="flex:1;min-width:0;">

                <h1 style="margin-bottom:12px;font-size:clamp(16px,4vw,20px);">
                  <i class="fas ${isAggregation ? "fa-layer-group" : "fa-info-circle"} me-2"
                    style="font-size:16px;color:#3b82f6;"></i>
                  ${isAggregation ? "Aggregate Files" : "File Inspector"}
                </h1>

                ${
                  isAggregation && fileList.length
                    ? `
                  <div style="margin-bottom:12px;padding:10px;background-color:#f9fafb;
                    border-radius:6px;max-height:120px;overflow-y:auto;">
                    <div style="font-size:12px;color:#6b7280;margin-bottom:6px;font-weight:500;">
                      Selected files (${fileList.length}):
                    </div>
                    <ul style="font-size:11px;margin:0;padding-left:20px;">
                      ${fileList.map((f) => `<li style="color:#374151;word-break:break-all;">${f}</li>`).join("")}
                    </ul>
                  </div>`
                    : ""
                }

                ${!isAggregation ? this._renderPathBar() : ""}
                ${zarrUrl ? this._renderZarrUrlRow(zarrUrl) : ""}
              </div>

              <button id="nc-close-btn" class="token-close-btn"
                style="font-size:28px;line-height:1;flex-shrink:0;width:32px;height:32px;">×</button>
            </div>
          </div>

          <!-- ── Aggregation config form ── -->
          ${
            isAggregation && isReady && !this._output
              ? `
            <div style="padding:16px;overflow-y:auto;">
              <h5 class="mb-3">Aggregation Configuration</h5>
              <aggregation-config id="nc-agg-config"
                initial-config='${JSON.stringify(this._aggregationConfig)}'></aggregation-config>
              <div class="d-flex justify-content-end gap-2 mt-3">
                <button id="nc-cancel-btn" class="btn btn-secondary">Cancel</button>
                <button id="nc-aggregate-btn" class="btn btn-primary">
                  <i class="fas fa-compress-arrows-alt me-2"></i>Aggregate Files
                </button>
              </div>
            </div>`
              : ""
          }

          <!-- ── Pre-zarr loading (no zarrUrl yet) ── -->
          ${
            !zarrUrl && isLoading
              ? `
            <div class="text-center py-4">
              <zarr-loading-steps status-code="${zarrStatusCode ?? 6}"
                ${isAggregation ? "is-aggregation" : ""}></zarr-loading-steps>
              <p class="mt-3 text-muted" style="font-size:13px;">
                ${isAggregation ? "Aggregating files and loading metadata..." : "Loading metadata..."}
              </p>
            </div>`
              : ""
          }

          <!-- ── Tabs + body ── -->
          ${
            zarrUrl && (this._output || isLoading || isError)
              ? `
            <div style="display:flex;gap:2px;border-bottom:2px solid #e5e7eb;padding-bottom:0;">
              ${this._renderTabBtn("metadata", "fa-database", "Metadata", false)}
              ${this._renderTabBtn("gridlook", "fa-cube", "3D Viewer", status !== NcDumpDialogState.READY || !this._output)}
            </div>
            <div class="token-section"
              style="flex:1;overflow-y:auto;overflow-x:hidden;padding:16px 12px;max-height:calc(95vh - 200px);">
              ${this._renderBody(isLoading, isError, zarrUrl)}
            </div>`
              : ""
          }

          <!-- ── Empty state ── -->
          ${
            !zarrUrl && !isLoading && isReady && !this._output
              ? `
            <div class="text-center py-4">
              <i class="fas fa-database" style="font-size:40px;color:#d1d5db;margin-bottom:12px;display:block;"></i>
              <p class="text-muted" style="font-size:13px;padding:0 12px;">
                ${
                  isAggregation
                    ? "Configure aggregation settings and click 'Aggregate Files' to begin"
                    : "Enter a file path and click Load to inspect metadata"
                }
              </p>
            </div>`
              : ""
          }

        </div>
      </div>`;

    this._attachListeners();

    // Restore path input value and focus
    const newPathEl = this.querySelector<HTMLInputElement>("#nc-path-input");
    if (newPathEl) {
      newPathEl.value = this._pathInput;
      if (wasFocused) newPathEl.focus();
    }
  }

  // ── Render helpers ────────────────────────────────────────────────────────

  /** Path input + Load / bypass-cache dropdown — always visible in single-file mode. */
  private _renderPathBar(): string {
    const disabled = this.status === NcDumpDialogState.LOADING;
    return `
      <div style="margin-bottom:8px;">
        <label style="display:block;font-size:12px;color:#6b7280;margin-bottom:4px;font-weight:500;">
          File path:
        </label>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <input id="nc-path-input" type="text" class="form-control form-control-sm"
            placeholder="/path/to/data.nc"
            style="flex:1 1 200px;font-size:13px;padding:6px 10px;min-width:0;">
          <div class="btn-group btn-group-sm nc-dropdown-wrap" style="position:relative;flex-shrink:0;">
            <button id="nc-load-btn" class="btn btn-sm btn-primary"
              style="padding:6px 14px;font-size:13px;white-space:nowrap;"
              ${disabled ? "disabled" : ""}>
              <i class="fas fa-sync-alt me-1"></i>Load
            </button>
            <button id="nc-load-toggle" class="btn btn-sm btn-primary dropdown-toggle dropdown-toggle-split"
              style="padding:6px 8px;" title="More load options" ${disabled ? "disabled" : ""}>
              <span class="visually-hidden">Toggle</span>
            </button>
            <ul id="nc-dropdown-menu" class="dropdown-menu nc-dropdown-menu"
              style="position:absolute;top:100%;right:0;z-index:1050;min-width:210px;margin-top:2px;
                display:${this._dropdownOpen ? "block" : "none"};">
              <li>
                <button id="nc-reload-btn" class="dropdown-item" style="font-size:13px;">
                  <i class="fas fa-ban me-2 text-warning"></i>Force Reload (bypass cache)
                </button>
              </li>
            </ul>
          </div>
        </div>
      </div>`;
  }

  /** Zarr URL display row — only shown once a zarrUrl is available. */
  private _renderZarrUrlRow(zarrUrl: string): string {
    return `
      <div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px;
        padding:8px 10px;background-color:#f3f4f6;border-radius:6px;font-size:11px;margin-bottom:8px;">
        <div style="display:flex;align-items:center;gap:6px;flex:1 1 100%;min-width:0;">
          <i class="fas fa-link" style="color:#6b7280;flex-shrink:0;"></i>
          <span style="color:#6b7280;font-weight:500;flex-shrink:0;">Zarr:</span>
          <code style="flex:1;background:white;padding:4px 8px;border-radius:4px;font-size:10px;
            color:#1f2937;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
            border:1px solid #e5e7eb;min-width:0;">${zarrUrl}</code>
          <button id="nc-copy-zarr" class="btn btn-sm"
            style="padding:4px 10px;font-size:11px;background:white;border:1px solid #d1d5db;
              border-radius:4px;color:#374151;flex-shrink:0;"
            title="${this._copied ? "Copied!" : "Copy Zarr URL"}">
            <i class="fas fa-${this._copied ? "check" : "copy"}"></i>
          </button>
        </div>
      </div>`;
  }
  private _renderTabBtn(
    id: "metadata" | "gridlook",
    icon: string,
    label: string,
    disabled: boolean,
  ): string {
    const active = this._activeTab === id;
    return `
      <button data-tab="${id}" class="nc-tab-btn" ${disabled ? "disabled" : ""}
        style="padding:12px 16px;font-size:14px;font-weight:${active ? 600 : 500};
          background-color:${active ? "#f3f4f6" : "transparent"};border:none;
          border-bottom:${active ? "3px solid #3b82f6" : "none"};
          cursor:${disabled ? "not-allowed" : "pointer"};opacity:${disabled ? 0.5 : 1};
          color:${active ? "#1f2937" : "#6b7280"};transition:all 0.2s ease;">
        <i class="fas ${icon} me-2"></i>${label}
      </button>`;
  }

  private _renderBody(isLoading: boolean, isError: boolean, zarrUrl: string): string {
    const parts: string[] = [];

    // Error
    if (isError && this._activeTab === "metadata") {
      parts.push(`
        <div style="border-radius:8px;background-color:#fee2e2;border:1px solid #fecaca;
          color:#991b1b;font-size:13px;padding:12px;margin-bottom:16px;">
          <div style="display:flex;align-items:start;gap:10px;">
            <i class="fas fa-exclamation-circle" style="font-size:18px;margin-top:2px;flex-shrink:0;"></i>
            <div style="flex:1;min-width:0;">
              <strong style="display:block;margin-bottom:6px;">Error loading metadata</strong>
              <div style="word-wrap:break-word;white-space:pre-wrap;">${this.error ?? ""}</div>
              <button id="nc-retry-btn" class="btn btn-sm mt-2"
                style="background-color:#dc2626;color:white;border:none;padding:6px 12px;font-size:12px;">
                <i class="fas fa-redo me-1"></i>Retry
              </button>
            </div>
          </div>
        </div>`);
    }

    // Loading spinner
    if (isLoading) {
      parts.push(`
        <div class="text-center py-4">
          <zarr-loading-steps status-code="${this.zarrStatusCode ?? 3}"
            ${this.isAggregation ? "is-aggregation" : ""}></zarr-loading-steps>
          <p class="mt-3 text-muted" style="font-size:13px;">
            ${this.isAggregation ? "Aggregating files and loading metadata..." : "Loading metadata..."}
          </p>
        </div>`);
    }

    // Metadata tab
    if (this._activeTab === "metadata" && this._output && !isLoading) {
      parts.push(`
        <div class="xarray-metadata-display"
          style="display:flex;justify-content:center;width:100%;overflow-x:auto;">
          <div>${this._output}</div>
        </div>`);
    }

    // 3D Viewer tab
    if (this._activeTab === "gridlook" && zarrUrl) {
      const gridlookUrl = `https://gridlook.pages.dev/#${zarrUrl}`;
      parts.push(`
        <div style="display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:12px;
          background-color:#eff6ff;border-radius:8px;font-size:12px;margin-bottom:16px;
          border:1px solid #bfdbfe;">
          <div style="display:flex;align-items:center;gap:6px;flex:1 1 100%;min-width:0;">
            <i class="fas fa-external-link-alt" style="color:#0284c7;flex-shrink:0;"></i>
            <span style="color:#0284c7;font-weight:600;flex-shrink:0;">GridLook URL:</span>
            <code style="flex:1;background:white;padding:6px 10px;border-radius:4px;font-size:11px;
              color:#1f2937;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
              border:1px solid #93c5fd;min-width:0;">${gridlookUrl}</code>
            <button id="nc-copy-gridlook" class="btn btn-sm"
              style="padding:6px 12px;font-size:12px;background:white;border:1px solid #93c5fd;
                border-radius:4px;color:#0284c7;flex-shrink:0;"
              title="${this._gridlookCopied ? "Copied!" : "Copy link"}">
              <i class="fas fa-${this._gridlookCopied ? "check" : "copy"}"></i>
            </button>
            <button id="nc-refresh-gridlook" class="btn btn-sm"
              style="padding:6px 12px;font-size:12px;background:white;border:1px solid #93c5fd;
                border-radius:4px;color:#0284c7;flex-shrink:0;" title="Refresh GridLook viewer">
              <i class="fas fa-redo me-1"></i>
            </button>
            <button id="nc-open-gridlook" class="btn btn-sm"
              style="padding:6px 12px;font-size:12px;background:#0284c7;border:1px solid #0284c7;
                border-radius:4px;color:white;flex-shrink:0;" title="Open in new tab">
              <i class="fas fa-arrow-up-right-from-square me-1"></i>Open in New Tab
            </button>
          </div>
        </div>

        <div style="width:100%;height:calc(95vh - 280px);min-height:500px;background-color:#f9fafb;
          border-radius:8px;overflow:hidden;border:1px solid #e5e7eb;">
          <iframe id="nc-gridlook-iframe" src="${gridlookUrl}"
            style="width:100%;height:100%;border:none;" title="GridLook 3D Viewer"></iframe>
        </div>`);
    }

    // Empty state inside body
    if (!this._output && !isLoading && !isError) {
      parts.push(`
        <div class="text-center py-4">
          <i class="fas fa-database" style="font-size:40px;color:#d1d5db;margin-bottom:12px;display:block;"></i>
          <p class="text-muted" style="font-size:13px;padding:0 12px;">
            ${
              this.isAggregation
                ? "Configure aggregation settings and click 'Aggregate Files' to begin"
                : "Enter a file path and click Load to inspect metadata"
            }
          </p>
        </div>`);
    }

    return parts.join("\n");
  }

  // ── Event listeners ───────────────────────────────────────────────────────
  private _attachListeners(): void {
    // Backdrop click to close
    this.querySelector("#nc-backdrop")?.addEventListener("click", (e) => {
      if (e.target === e.currentTarget) this._emit("inspector-close", null);
    });

    // Close button
    this.querySelector("#nc-close-btn")?.addEventListener("click", () => {
      this._emit("inspector-close", null);
    });

    // Cancel button (aggregation mode)
    this.querySelector("#nc-cancel-btn")?.addEventListener("click", () => {
      this._emit("inspector-close", null);
    });

    // Load button
    this.querySelector("#nc-load-btn")?.addEventListener("click", () => {
      this._handleInspect();
    });

    // Path input — keep _pathInput in sync as user types, submit on Enter
    const pathInput = this.querySelector<HTMLInputElement>("#nc-path-input");
    pathInput?.addEventListener("input", (e) => {
      this._pathInput = (e.target as HTMLInputElement).value;
    });
    pathInput?.addEventListener("keypress", (e) => {
      if ((e as KeyboardEvent).key === "Enter") this._handleInspect();
    });

    // Aggregate button
    this.querySelector("#nc-aggregate-btn")?.addEventListener("click", () => {
      this._handleInspect();
    });

    // Dropdown toggle
    this.querySelector("#nc-load-toggle")?.addEventListener("click", () => {
      this._dropdownOpen = !this._dropdownOpen;
      this._syncDropdown();
    });

    // Force reload
    this.querySelector("#nc-reload-btn")?.addEventListener("click", () => {
      this._handleInspectReload();
    });

    // Retry button
    this.querySelector("#nc-retry-btn")?.addEventListener("click", () => {
      this._handleInspect();
    });

    // Copy Zarr URL
    this.querySelector("#nc-copy-zarr")?.addEventListener("click", () => {
      const url = this.zarrUrl;
      if (!url) return;
      void navigator.clipboard.writeText(url).then(() => {
        this._copied = true;
        this._render();
        setTimeout(() => {
          this._copied = false;
          this._render();
        }, 2000);
      });
    });

    // Copy GridLook URL
    this.querySelector("#nc-copy-gridlook")?.addEventListener("click", () => {
      void navigator.clipboard.writeText(`https://gridlook.pages.dev/#${this.zarrUrl}`).then(() => {
        this._gridlookCopied = true;
        this._render();
        setTimeout(() => {
          this._gridlookCopied = false;
          this._render();
        }, 2000);
      });
    });

    // Refresh GridLook (remount iframe)
    this.querySelector("#nc-refresh-gridlook")?.addEventListener("click", () => {
      const iframe = this.querySelector<HTMLIFrameElement>("#nc-gridlook-iframe");
      if (iframe) {
        const src = iframe.src;
        iframe.src = "";
        iframe.src = src;
      }
    });

    // Open GridLook in new tab
    this.querySelector("#nc-open-gridlook")?.addEventListener("click", () => {
      window.open(`https://gridlook.pages.dev/#${this.zarrUrl}`, "_blank");
    });

    // Tab buttons
    this.querySelectorAll<HTMLButtonElement>(".nc-tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tab = btn.dataset["tab"] as "metadata" | "gridlook";
        if (tab && !btn.disabled) {
          this._activeTab = tab;
          this._render();
        }
      });
    });

    // AggregationConfig change event
    this.querySelector("#nc-agg-config")?.addEventListener("config-change", (e) => {
      this._aggregationConfig = (e as CustomEvent<AggregationConfigValues>).detail;
    });
  }

  private _syncDropdown(): void {
    const menu = this.querySelector<HTMLElement>("#nc-dropdown-menu");
    if (menu) menu.style.display = this._dropdownOpen ? "block" : "none";
  }
}

customElements.define("data-inspector", DataInspectorElement);
