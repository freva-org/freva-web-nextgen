/**
 * <zarr-loading-steps> — animated stepper shown while Zarr conversion is in progress.
 *
 * Attributes:
 *   status-code   number  Backend status code (0-5). Default: 3
 *   is-aggregation        Boolean. Changes the rotating messages shown.
 *
 */

const KEYFRAMES = `
  @keyframes zarrPulseRing {
    0%   { transform: scale(0.9); opacity: 0.7; }
    60%  { transform: scale(1.6); opacity: 0;   }
    100% { transform: scale(0.9); opacity: 0;   }
  }
  @keyframes zarrSpinArc {
    from { transform: rotate(0deg);   }
    to   { transform: rotate(360deg); }
  }
  @keyframes zarrMsgIn {
    0%   { opacity: 0; transform: translateY(5px);  }
    18%  { opacity: 1; transform: translateY(0);     }
    82%  { opacity: 1; transform: translateY(0);     }
    100% { opacity: 0; transform: translateY(-5px);  }
  }
  @keyframes zarrTrackFill {
    from { width: 0%; }
    to   { width: 100%; }
  }
  .zarr-spin { animation: zarrSpinArc 1.3s linear infinite; transform-origin: center; }
  .zarr-msg  { animation: zarrMsgIn 2.8s ease-in-out forwards; }
`;

const STAGES = [
  { id: "submitted", label: "Submitted" },
  { id: "queued", label: "Queued" },
  { id: "converting", label: "Converting" },
  { id: "ready", label: "Ready" },
] as const;

const C = {
  done: "#0d9488",
  active: "#14b8a6",
  pending: "#d1d5db",
  track: "#e5e7eb",
  textOn: "#0f766e",
  textOff: "#9ca3af",
  msg: "#6b7280",
  timer: "#d1d5db",
};

const PROCESSING_MESSAGES = [
  "Reading file structure…",
  "Analysing coordinate metadata…",
  "Optimising chunk layout…",
  "Building Zarr metadata store…",
  "Assembling data variables…",
  "Applying access-pattern optimisation…",
  "Finalising dataset…",
];

const AGGREGATION_MESSAGES = [
  "Aligning coordinate indexes…",
  "Resolving variable conflicts…",
  "Concatenating along dimension…",
  "Merging datasets…",
  "Validating compatibility…",
  "Assembling aggregated store…",
  "Almost there…",
];

function statusToStageIndex(code: number): number {
  if (code === 0) return 3;
  if (code === 4) return 2;
  if (code === 3) return 1;
  return 0;
}

function injectKeyframes(): void {
  if (!document.getElementById("zarr-loading-keyframes")) {
    const style = document.createElement("style");
    style.id = "zarr-loading-keyframes";
    style.textContent = KEYFRAMES;
    document.head.appendChild(style);
  }
}

function renderStageDot(i: number, stageIdx: number, label: string): string {
  const isDone = i < stageIdx;
  const isActive = i === stageIdx;

  const dot = isDone
    ? `<svg width="10" height="8" viewBox="0 0 10 8" fill="none">
        <path d="M1 4L3.8 7L9 1" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
       </svg>`
    : isActive
      ? `<svg width="16" height="16" viewBox="0 0 16 16" class="zarr-spin" style="position:absolute;">
        <circle cx="8" cy="8" r="5.5" fill="none" stroke="${C.active}" stroke-width="2"
          stroke-dasharray="18 17" stroke-linecap="round"/>
       </svg>`
      : `<div style="width:5px;height:5px;border-radius:50%;background:${C.pending};"></div>`;

  const pulseRing = isActive
    ? `<div style="position:absolute;width:30px;height:30px;border-radius:50%;
         border:2px solid ${C.active};animation:zarrPulseRing 2s ease-out infinite;pointer-events:none;"></div>`
    : "";

  const connectorBefore =
    i > 0
      ? `
    <div style="flex:1;height:2px;background:${isDone ? `linear-gradient(90deg,${C.done},${C.active})` : C.track};
      transition:background 0.5s ease;position:relative;overflow:hidden;">
      ${
        isActive
          ? `<div style="position:absolute;top:0;left:0;height:100%;
        background:linear-gradient(90deg,${C.done},${C.active});
        animation:zarrTrackFill 0.6s ease forwards;"></div>`
          : ""
      }
    </div>`
      : "";

  return `
    ${connectorBefore}
    <div style="position:relative;display:flex;flex-direction:column;align-items:center;">
      ${pulseRing}
      <div style="width:22px;height:22px;border-radius:50%;
        background:${isDone ? C.done : isActive ? "#fff" : "#f9fafb"};
        border:2px solid ${isDone ? C.done : isActive ? C.active : C.pending};
        display:flex;align-items:center;justify-content:center;
        position:relative;z-index:1;
        box-shadow:${isActive ? `0 0 0 4px rgba(20,184,166,0.12)` : "none"};
        transition:all 0.4s ease;">
        ${dot}
      </div>
      <span style="position:absolute;top:28px;font-size:10.5px;
        font-weight:${isActive ? 600 : 400};
        color:${isDone ? C.done : isActive ? C.textOn : C.textOff};
        white-space:nowrap;letter-spacing:0.03em;text-transform:uppercase;
        transition:color 0.4s ease;">
        ${label}
      </span>
    </div>`;
}

export class ZarrLoadingStepsElement extends HTMLElement {
  private _msgIdx = 0;
  private _msgKey = 0;
  private _elapsed = 0;
  private _startTime = Date.now();
  private _msgTimer: ReturnType<typeof setInterval> | null = null;
  private _elapsedTimer: ReturnType<typeof setInterval> | null = null;

  static get observedAttributes(): string[] {
    return ["status-code", "is-aggregation"];
  }

  get statusCode(): number {
    return parseInt(this.getAttribute("status-code") ?? "3", 10);
  }

  get isAggregation(): boolean {
    return this.hasAttribute("is-aggregation");
  }

  connectedCallback(): void {
    injectKeyframes();
    this._render();
    this._startTimers();
  }

  disconnectedCallback(): void {
    this._stopTimers();
  }

  attributeChangedCallback(): void {
    if (this.isConnected) this._updateStages();
  }

  private _startTimers(): void {
    this._startTime = Date.now();

    this._elapsedTimer = setInterval(() => {
      this._elapsed = Math.floor((Date.now() - this._startTime) / 1000);
      const el = this.querySelector<HTMLElement>(".zarr-elapsed");
      if (el) el.textContent = this._formatElapsed(this._elapsed);
    }, 1000);

    this._startMsgCycle();
  }

  private _startMsgCycle(): void {
    if (this._msgTimer) clearInterval(this._msgTimer);
    const stageIdx = statusToStageIndex(this.statusCode);
    if (stageIdx !== 2) return;

    const messages = this.isAggregation ? AGGREGATION_MESSAGES : PROCESSING_MESSAGES;
    this._msgTimer = setInterval(() => {
      this._msgIdx = (this._msgIdx + 1) % messages.length;
      this._msgKey += 1;
      this._updateMessage();
    }, 2800);
  }

  private _stopTimers(): void {
    if (this._msgTimer) {
      clearInterval(this._msgTimer);
      this._msgTimer = null;
    }
    if (this._elapsedTimer) {
      clearInterval(this._elapsedTimer);
      this._elapsedTimer = null;
    }
  }

  private _formatElapsed(s: number): string {
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  }

  private _render(): void {
    const stageIdx = statusToStageIndex(this.statusCode);
    const messages = this.isAggregation ? AGGREGATION_MESSAGES : PROCESSING_MESSAGES;

    this.innerHTML = `
      <div style="padding:28px 12px 20px;display:flex;flex-direction:column;align-items:center;gap:0;">
        <div class="zarr-stages" style="display:flex;align-items:center;width:100%;max-width:360px;margin-bottom:28px;">
          ${STAGES.map((s, i) => renderStageDot(i, stageIdx, s.label)).join("")}
        </div>

        <div style="height:20px;"></div>

        <div class="zarr-msg-container" style="min-height:22px;text-align:center;">
          ${this._renderMessage(stageIdx, messages)}
        </div>

        <div style="margin-top:10px;">
          <span class="zarr-elapsed" style="font-size:11px;color:${C.timer};
            font-variant-numeric:tabular-nums;letter-spacing:0.05em;">
            ${this._formatElapsed(this._elapsed)}
          </span>
        </div>
      </div>`;
  }

  private _renderMessage(stageIdx: number, messages: readonly string[]): string {
    if (stageIdx === 2) {
      return `<span key="${this._msgKey}" class="zarr-msg" style="font-size:13px;color:${C.msg};">
                ${messages[this._msgIdx]}
              </span>`;
    }
    if (stageIdx === 1) {
      return `<span style="font-size:13px;color:${C.msg};">Waiting for a worker to pick up the task…</span>`;
    }
    return "";
  }

  /** Update only the stage dots (called when statusCode changes). */
  private _updateStages(): void {
    const stageIdx = statusToStageIndex(this.statusCode);
    const stagesEl = this.querySelector<HTMLElement>(".zarr-stages");
    if (stagesEl) {
      stagesEl.innerHTML = STAGES.map((s, i) => renderStageDot(i, stageIdx, s.label)).join("");
    }
    const msgContainer = this.querySelector<HTMLElement>(".zarr-msg-container");
    if (msgContainer) {
      const messages = this.isAggregation ? AGGREGATION_MESSAGES : PROCESSING_MESSAGES;
      msgContainer.innerHTML = this._renderMessage(stageIdx, messages);
    }
    this._startMsgCycle();
  }

  /** Update only the rotating message text. */
  private _updateMessage(): void {
    const stageIdx = statusToStageIndex(this.statusCode);
    const msgContainer = this.querySelector<HTMLElement>(".zarr-msg-container");
    if (msgContainer) {
      const messages = this.isAggregation ? AGGREGATION_MESSAGES : PROCESSING_MESSAGES;
      msgContainer.innerHTML = this._renderMessage(stageIdx, messages);
    }
  }
}

customElements.define("zarr-loading-steps", ZarrLoadingStepsElement);
