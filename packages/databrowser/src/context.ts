// context.ts - the contract between the controller (index.ts) and the components.
// Components depend only on this interface, never on index.ts directly.

import type { Api } from "./api.js";
import type { Disposables } from "./dom.js";
import type { PopoverManager } from "./popover.js";
import type {
  AppState,
  BBoxSelection,
  FlavourName,
  ResolvedConfig,
  TimeSelection,
} from "./types.js";

export interface Roots {
  app: HTMLElement;
  facetList: HTMLElement;
  chips: HTMLElement;
  clearAllBtn: HTMLButtonElement;
  overviewWrap: HTMLElement;
  overviewGrid: HTMLElement;
  resCount: HTMLElement;
  resSpin: HTMLElement;
  exportBtn: HTMLButtonElement;
  selectAllBtn: HTMLButtonElement;
  shelveBtn: HTMLButtonElement;
  cmdStrip: HTMLElement;
  listHead: HTMLElement;
  results: HTMLElement;
  moreWrap: HTMLElement;
  pickbar: HTMLElement;
  info: HTMLElement;
  infoScroll: HTMLElement;
  infoBtn: HTMLButtonElement;
  statusMsg: HTMLElement;
  statusDot: HTMLElement;
  toastHost: HTMLElement;
  lensValue: HTMLElement;
}

export interface AppContext {
  readonly state: AppState;
  readonly api: Api;
  readonly dis: Disposables;
  /**
   * Returns a fresh per-region disposable bucket, flushing the previous bucket registered under
   * the same name. Re-rendered regions attach their listeners here (not on the app-wide `dis`)
   * so detached-node listeners are released on every re-render. All buckets flush on destroy.
   */
  region(name: string): Disposables;
  readonly cfg: ResolvedConfig;
  readonly roots: Roots;
  readonly popover: PopoverManager;

  // search lifecycle
  commitSearch(): void; // debounced extended-search for the current query, resets paging
  loadNextPage(): void;
  retrySearch(): void;

  // region renders (no fetch)
  syncAll(): void;
  renderSidebar(): void;
  renderChips(): void;
  renderResults(): void;
  renderOverview(): void;
  renderCommand(): void;
  renderDetails(): void;
  recountOverview(): void;

  // mutations
  toggleFacet(key: string, value: string): void;
  /** Clear every selected value for one facet (the facet header-badge affordance). */
  clearFacet(key: string): void;
  clearAllFacets(): void;
  setTime(t: TimeSelection | null): void;
  setBbox(b: BBoxSelection | null): void;
  setFlavour(f: FlavourName): void;
  setLayout(l: "results" | "overview"): void;
  setView(v: "list" | "grid"): void;
  setTheme(t: "day" | "night"): void;

  // details / picks
  toggleDetails(force?: boolean): void;
  focusFile(key: string): void;
  togglePick(key: string): void;
  clearPicks(): void;

  // terminal
  /**
   * Commit a terminal draft (the caller strips the in-progress token). Runs the shared
   * filterCommittable guard; returns how many tokens were REJECTED (unknown key /
   * closed-value-set failure) so the terminal can keep a dirty draft visible.
   */
  applyTerminalDraft(text: string): number;
  /** Validation messages for time/bbox tokens in the terminal draft (empty when all good). */
  terminalDraftErrors(text: string): string[];

  /**
   * Stream a catalogue download with progress + abort. No args beyond `kind` exports
   * the whole current query; `query`/`uniqKey` overrides scope it (per-file exports).
   */
  exportCatalogue(
    kind: "intake" | "stac" | "uris",
    query?: string,
    uniqKey?: "file" | "uri",
  ): Promise<void>;

  // editors / popovers / status
  openTimeEditor(anchor: HTMLElement): void;
  openBboxEditor(anchor: HTMLElement): void;
  closeAllPopovers(except?: HTMLElement): void;
  setStatus(msg: string): void;
  /** Open the lazy, gated per-file Inspect (ncdump) dialog for a file path. */
  openInspect(file: string): Promise<void>;
  /** Open the app-level Help panel (install/setup for the freva-client CLI + python library). */
  openHelp(): void;
  /** Append an event to the footer console ring buffer (and reflect it in the one-line bar). */
  log(severity: LogSeverity, message: string): void;
  /** Pop an auto-dismissing toast AND log it (transient outcome; full detail stays in console). */
  toast(severity: LogSeverity, message: string): void;
}

export type LogSeverity = "info" | "success" | "warn" | "error";
