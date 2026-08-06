/**
 * <aggregation-config> - configuration form for multi-file aggregation.
 *
 * Attributes:
 *   initial-config   JSON string of Partial<AggregationConfigValues>
 *
 * Events fired:
 *   config-change    CustomEvent<AggregationConfigValues>
 *
 * Styled with Bootstrap utility classes - host app must provide Bootstrap CSS.
 * Renders once; uses event delegation + targeted DOM updates (no re-renders on input change).
 */

import type { AggregationConfigValues } from "../types";

const CHEVRON_DOWN = `<svg viewBox="0 0 448 512" width="10" height="10" style="vertical-align:middle;">
  <path d="M207.029 381.476L12.686 187.132c-9.373-9.373-9.373-24.569 0-33.941l22.667-22.667
    c9.357-9.357 24.522-9.375 33.901-.04L224 284.505l154.745-154.021c9.379-9.335
    24.544-9.317 33.901.04l22.667 22.667c9.373 9.373 9.373 24.569 0 33.941
    L240.971 381.476c-9.373 9.372-24.569 9.372-33.942 0z" fill="currentColor"/>
</svg>`;

const CHEVRON_RIGHT = `<svg viewBox="0 0 256 512" width="6" height="10" style="vertical-align:middle;">
  <path d="M224.3 273l-136 136c-9.4 9.4-24.6 9.4-33.9 0l-22.6-22.6c-9.4-9.4-9.4-24.6
    0-33.9l96.4-96.4-96.4-96.4c-9.4-9.4-9.4-24.6 0-33.9L54.3 103c9.4-9.4
    24.6-9.4 33.9 0l136 136c9.5 9.4 9.5 24.6.1 34z" fill="currentColor"/>
</svg>`;

const DEFAULT_CONFIG: AggregationConfigValues = {
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

export class AggregationConfigElement extends HTMLElement {
  private _config: AggregationConfigValues = { ...DEFAULT_CONFIG };
  private _showAdvanced = false;

  connectedCallback(): void {
    try {
      const initial = JSON.parse(
        this.getAttribute("initial-config") ?? "{}",
      ) as Partial<AggregationConfigValues>;
      this._config = { ...DEFAULT_CONFIG, ...initial };
    } catch {
      this._config = { ...DEFAULT_CONFIG };
    }
    this._render();
    this.addEventListener("change", this._handleChange);
    this.addEventListener("click", this._handleClick);
  }

  disconnectedCallback(): void {
    this.removeEventListener("change", this._handleChange);
    this.removeEventListener("click", this._handleClick);
  }

  private _handleChange = (e: Event): void => {
    const target = e.target as HTMLInputElement | HTMLSelectElement;
    const field = target.dataset["field"] as keyof AggregationConfigValues | undefined;
    if (!field) return;

    let value: string | number | boolean | null;

    if ((target as HTMLInputElement).type === "checkbox") {
      value = (target as HTMLInputElement).checked;
    } else if ((target as HTMLInputElement).type === "number") {
      const raw = parseFloat(target.value);
      value = Number.isFinite(raw) ? raw : parseInt(target.value, 10);
    } else {
      value = target.value === "" ? null : target.value;
    }

    this._config = { ...this._config, [field]: value } as AggregationConfigValues;
    this._emitChange();
    this._updateConditionals();
  };

  private _handleClick = (e: Event): void => {
    if ((e.target as HTMLElement).closest("#nc-advanced-toggle")) {
      this._showAdvanced = !this._showAdvanced;
      const adv = this.querySelector<HTMLElement>(".nc-advanced");
      const icon = this.querySelector<HTMLElement>(".nc-chevron");
      if (adv) adv.style.display = this._showAdvanced ? "block" : "none";
      if (icon) icon.innerHTML = this._showAdvanced ? CHEVRON_DOWN : CHEVRON_RIGHT;
    }
  };

  private _emitChange(): void {
    this.dispatchEvent(
      new CustomEvent<AggregationConfigValues>("config-change", {
        bubbles: true,
        composed: true,
        detail: this._config,
      }),
    );
  }

  /** Show/hide conditional fields without re-rendering. */
  private _updateConditionals(): void {
    const dimField = this.querySelector<HTMLElement>(".nc-dim-field");
    const mapChunk = this.querySelector<HTMLElement>(".nc-map-chunksize");
    if (dimField) dimField.style.display = this._config.aggregate === "concat" ? "block" : "none";
    if (mapChunk) mapChunk.style.display = this._config.access_pattern === "map" ? "block" : "none";
  }

  private _render(): void {
    const c = this._config;

    this.innerHTML = `
      <div class="aggregation-config">

        <!-- Aggregation Method -->
        <div class="mb-3">
          <label class="form-label fw-semibold">Aggregation Method</label>
          <select class="form-select form-select-sm" data-field="aggregate">
            <option value="auto"   ${c.aggregate === "auto" ? "selected" : ""}>Auto (Detect automatically)</option>
            <option value="merge"  ${c.aggregate === "merge" ? "selected" : ""}>Merge (Combine variables)</option>
            <option value="concat" ${c.aggregate === "concat" ? "selected" : ""}>Concat (Join along dimension)</option>
          </select>
          <div class="form-text text-muted">Auto mode will automatically detect the best aggregation method</div>
        </div>

        <!-- Timeout -->
        <div class="mb-3">
          <label class="form-label fw-semibold">Timeout (seconds)</label>
          <input type="number" class="form-control form-control-sm"
            data-field="timeout" min="10" max="3600" value="${c.timeout ?? 120}">
          <div class="form-text text-muted">
            Max wait time for the aggregation to complete (default: 120 s). Increase for large datasets.
          </div>
        </div>

        <!-- Advanced Toggle -->
        <button type="button" id="nc-advanced-toggle"
          class="btn btn-link btn-sm p-0 mb-3 text-decoration-none">
          <span class="nc-chevron">${this._showAdvanced ? CHEVRON_DOWN : CHEVRON_RIGHT}</span>
          <span class="ms-2">Advanced Options</span>
        </button>

        <!-- Advanced Options -->
        <div class="nc-advanced" style="display:${this._showAdvanced ? "block" : "none"};">

          <!-- Dimension (concat only) -->
          <div class="mb-3 nc-dim-field" style="display:${c.aggregate === "concat" ? "block" : "none"};">
            <label class="form-label">Dimension to Concatenate Along</label>
            <input type="text" class="form-control form-control-sm"
              data-field="dim" placeholder="e.g., time, ensemble" value="${c.dim ?? ""}">
            <div class="form-text text-muted">Leave empty to create a new dimension</div>
          </div>

          <!-- Join Mode -->
          <div class="mb-3">
            <label class="form-label">Join Mode</label>
            <select class="form-select form-select-sm" data-field="join">
              <option value=""      ${!c.join ? "selected" : ""}>Default</option>
              <option value="outer" ${c.join === "outer" ? "selected" : ""}>Outer (Union)</option>
              <option value="inner" ${c.join === "inner" ? "selected" : ""}>Inner (Intersection)</option>
              <option value="left"  ${c.join === "left" ? "selected" : ""}>Left</option>
              <option value="right" ${c.join === "right" ? "selected" : ""}>Right</option>
              <option value="exact" ${c.join === "exact" ? "selected" : ""}>Exact (Must match)</option>
            </select>
          </div>

          <!-- Compatibility Mode -->
          <div class="mb-3">
            <label class="form-label">Compatibility Mode</label>
            <select class="form-select form-select-sm" data-field="compat">
              <option value=""              ${!c.compat ? "selected" : ""}>Default</option>
              <option value="no_conflicts"  ${c.compat === "no_conflicts" ? "selected" : ""}>No Conflicts</option>
              <option value="equals"        ${c.compat === "equals" ? "selected" : ""}>Equals</option>
              <option value="override"      ${c.compat === "override" ? "selected" : ""}>Override</option>
            </select>
          </div>

          <!-- Data Variables -->
          <div class="mb-3">
            <label class="form-label">Data Variables Handling</label>
            <select class="form-select form-select-sm" data-field="data_vars">
              <option value=""          ${!c.data_vars ? "selected" : ""}>Default</option>
              <option value="minimal"   ${c.data_vars === "minimal" ? "selected" : ""}>Minimal</option>
              <option value="different" ${c.data_vars === "different" ? "selected" : ""}>Different</option>
              <option value="all"       ${c.data_vars === "all" ? "selected" : ""}>All</option>
            </select>
          </div>

          <!-- Coordinates -->
          <div class="mb-3">
            <label class="form-label">Coordinates Handling</label>
            <select class="form-select form-select-sm" data-field="coords">
              <option value=""          ${!c.coords ? "selected" : ""}>Default</option>
              <option value="minimal"   ${c.coords === "minimal" ? "selected" : ""}>Minimal</option>
              <option value="different" ${c.coords === "different" ? "selected" : ""}>Different</option>
              <option value="all"       ${c.coords === "all" ? "selected" : ""}>All</option>
            </select>
          </div>

          <!-- Group By -->
          <div class="mb-3">
            <label class="form-label">Group By (Optional)</label>
            <input type="text" class="form-control form-control-sm"
              data-field="group_by" placeholder="e.g., ensemble, variable" value="${c.group_by ?? ""}">
            <div class="form-text text-muted">Group files by a specific attribute</div>
          </div>

          <!-- Reload Cache -->
          <div class="mb-3">
            <div class="form-check">
              <input type="checkbox" class="form-check-input" id="aggregation-reload"
                data-field="reload" ${c.reload ? "checked" : ""}>
              <label class="form-check-label" for="aggregation-reload">Force Reload (bypass cache)</label>
            </div>
            <div class="form-text text-muted">
              Force server to fetch fresh data instead of using cached version
            </div>
          </div>

          <!-- Access Pattern -->
          <div class="mb-3">
            <label class="form-label">Access Pattern Optimization</label>
            <select class="form-select form-select-sm" data-field="access_pattern">
              <option value="map"         ${c.access_pattern === "map" ? "selected" : ""}>Map (spatial slices)</option>
              <option value="time_series" ${c.access_pattern === "time_series" ? "selected" : ""}>Time Series (temporal slices)</option>
            </select>
            <div class="form-text text-muted">Optimize chunk layout for your typical data access pattern</div>
          </div>

          <!-- Chunk Size -->
          <div class="mb-3">
            <label class="form-label">Target Chunk Size (MB)</label>
            <input type="number" class="form-control form-control-sm"
              data-field="chunk_size" step="0.1" min="1" max="1000" value="${c.chunk_size ?? 16.0}">
            <div class="form-text text-muted">Target size for data chunks (default: 16 MB)</div>
          </div>

          <!-- Map Primary Chunksize (map pattern only) -->
          <div class="mb-3 nc-map-chunksize" style="display:${c.access_pattern === "map" ? "block" : "none"};">
            <label class="form-label">Primary Dimension Chunk Size</label>
            <input type="number" class="form-control form-control-sm"
              data-field="map_primary_chunksize" min="1" value="${c.map_primary_chunksize ?? 1}">
            <div class="form-text text-muted">Number of time steps per chunk (for map access pattern)</div>
          </div>

        </div>
      </div>`;
  }
}

customElements.define("aggregation-config", AggregationConfigElement);
