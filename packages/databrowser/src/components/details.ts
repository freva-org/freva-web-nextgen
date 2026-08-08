// components/details.ts - the gated, lazy Details panel. It fetches ?file= ONLY when the panel
// is open and a file is focused/picked - browsing costs nothing. The per-file facet table is
// REAL, parsed from the ?file= response's `facets` block. The bbox mini-map renders whenever the
// ?file= response carries a bbox; time is derived from the filename when parseable, otherwise
// "not available yet" - never fabricated.
//
// Fetches are cached by key (survive close/reopen), tagged with a monotonic request id, and
// dropped if a newer request superseded them. Partial batch failure shows what loaded and flags
// the rest; a pick that is no longer present is dropped.

import { ApiError } from "../api.js";
import type { AppContext } from "../context.js";
import { el, replaceChildren, svgIcon, type Disposables } from "../dom.js";
import { brandIcon } from "../brand.js";
import { ICONS } from "../icons.js";
import {
  labelFor,
  metaFromFacetsBlock,
  normalizeBboxLon,
  parseEnvelope,
  parseSolrTimeRange,
  timeRangeFromFilename,
} from "../state.js";
import { paintRect, worldSVG } from "../geo.js";
import { mountLeafletMap } from "./leafletMap.js";
import { inspectEnabled } from "./inspector.js";
import type { FileRow } from "../types.js";
import { MAX_AGGREGATE_FILES, MAX_SELECTED_FILES } from "../types.js";

// no module-level Disposables: the region bucket is passed explicitly per render.

interface Store {
  sig: string | null;
  /** the target-set signature that `attempted`/`failed` currently pertain to. */
  sigSeen: string | null;
  reqId: number;
  attempted: Set<string>;
  failed: Set<string>;
  errorMsg: string;
}
const stores = new WeakMap<AppContext, Store>();
function store(ctx: AppContext): Store {
  let s = stores.get(ctx);
  if (!s) {
    s = {
      sig: null,
      sigSeen: null,
      reqId: 0,
      attempted: new Set(),
      failed: new Set(),
      errorMsg: "",
    };
    stores.set(ctx, s);
  }
  return s;
}

/** Stable signature of a target set of rows under the current flavour. */
function setSignature(rows: FileRow[], flavour: string): string {
  return rows.map((r) => r.key).join("|") + "#" + flavour;
}

const PALETTE = ["#4F8DF7", "#34C98A", "#E6B14E", "#C79BF0", "#F0795F", "#3FB6D8", "#E0608A"];
function rgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function metaText(v: string | string[] | number): string {
  return Array.isArray(v) ? v.join(", ") : String(v);
}
function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}
function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i + 1);
}

/** Which row keys the panel describes: the user's LAST action wins - a clicked row ('focus') shows
 *  just that file even while picks exist; (de)selecting or the pickbar Details button ('picks') shows
 *  the whole selection. Falls back gracefully when the preferred source is empty. */
function targetKeys(ctx: AppContext): string[] {
  const { detailSource, focusKey, pickedKeys } = ctx.state;
  if (detailSource === "focus" && focusKey) return [focusKey];
  if (pickedKeys.size > 0) return [...pickedKeys];
  if (focusKey) return [focusKey];
  return [];
}

function metaRow(k: string, v: string, na = false): HTMLElement {
  return el("div", { class: "meta-row" }, [
    el("span", { class: "k", text: k }),
    el("span", { class: `v${na ? " na" : ""}`, text: v }),
  ]);
}

function infoSec(icon: keyof typeof ICONS | null, label: string): HTMLElement {
  const sec = el("div", { class: "info-sec" });
  if (icon) sec.append(svgIcon(ICONS[icon], { size: 13 }));
  sec.append(el("span", { text: label }));
  return sec;
}
/**
 * The SELECTION the action block acts on. This is deliberately NOT "the rows whose metadata
 * loaded": a metadata request that failed changes what we can SHOW, never what the user selected.
 * Conflating the two produces a wrong "N files selected", a wrong `deselect N`, and - with
 * a single successful fetch out of several - a multi-file selection presenting single-file actions.
 */
export interface ActionTarget {
  /** Every selected file, in selection order, regardless of metadata outcome. */
  files: string[];
  /** files.length, carried explicitly so the arithmetic reads unambiguously. */
  count: number;
}

// catalogue download actions (scoped to the picked files via file=)
// NOTE: per-file Details fetches are issued ONE request per file on purpose. A single
// multi-file ?file=a&file=b call returns an AGGREGATE facets block that cannot be attributed
// back to an individual file, so a per-file diff genuinely requires per-file calls. Selection is
// capped at MAX_SELECTED_FILES, and those calls still run through a bounded concurrency pool (see
// ensureFetch) rather than all at once. Do not "batch into one request".
function actionsBlock(ctx: AppContext, reg: Disposables, target: ActionTarget): HTMLElement {
  const files = target.files;
  const multi = target.count > 1;
  // Primary action depends on the selection. A SINGLE file -> Inspect (read one store; an already-zarr
  // file renders without sign-in, a non-zarr file surfaces its own "needs sign-in / data-portal"
  // message). A BUNCH -> Aggregate (combine into one dataset) - Inspect makes no sense for many stores.
  // The Aggregate button mirrors the pickbar's gating: it LOCKS past MAX_AGGREGATE_FILES and needs
  // auth + the data-portal, and it shows the reason so a disabled button never looks broken.
  let primary: HTMLElement;
  let lockNote: HTMLElement | null = null;
  if (multi) {
    // The SELECTED count, not the loaded-metadata count: with 25 selected this must say to deselect
    // 15 to reach the 10-file aggregate limit, even if only 3 of the 25 returned metadata.
    const n = target.count;
    const overCap = n > MAX_AGGREGATE_FILES;
    const disabled = !ctx.cfg.authEnabled || !ctx.cfg.enableHeavyOps || overCap;
    const why = overCap
      ? `Aggregation handles up to ${MAX_AGGREGATE_FILES} files - deselect ${n - MAX_AGGREGATE_FILES} to enable it`
      : !ctx.cfg.authEnabled
        ? "Aggregate - needs sign-in"
        : !ctx.cfg.enableHeavyOps
          ? "Aggregate - data-portal not enabled"
          : "Aggregation isn\u2019t wired up in this build yet";
    const aggregate = el(
      "button",
      {
        class: `btn primary${overCap ? " locked" : ""}`,
        type: "button",
        disabled: disabled ? "true" : null,
        title: why,
      },
      [svgIcon(ICONS.aggregate, { size: 15 }), el("span", { text: "Aggregate" })],
    );
    if (!disabled)
      reg.listen(aggregate, "click", () =>
        ctx.toast("warn", "Aggregation isn\u2019t wired up in this build yet."),
      );
    primary = aggregate;
    if (disabled) lockNote = el("p", { class: "scope-note", text: why });
  } else {
    const canInspect = inspectEnabled(ctx);
    const inspect = el(
      "button",
      {
        class: "btn primary",
        type: "button",
        disabled: canInspect ? null : "true",
        title: canInspect
          ? "Inspect data (zarr stores render without sign-in)"
          : "Inspect is disabled for this deployment",
      },
      [svgIcon(ICONS.inspect, { size: 15 }), el("span", { text: "Inspect data" })],
    );
    if (canInspect)
      reg.listen(inspect, "click", () => {
        void ctx.openInspect(files[0]);
      });
    primary = inspect;
  }

  // One shared, streaming, progress-reporting export path, scoped by file= against the current
  // uniq_key path. The search rows only carry `file` reliably (uri is not returned), so there is
  // no file/uri toggle here: offering a uri scope we cannot build would silently send the wrong
  // constraint.
  const dl = (kind: "intake" | "stac"): void => {
    const query = files.map((f) => `file=${encodeURIComponent(f)}`).join("&");
    void ctx.exportCatalogue(kind, query, "file");
  };
  const intake = el("button", { class: "btn", type: "button" }, [
    brandIcon("intake", { size: 16 }),
    el("span", { text: "Intake catalogue (.json)" }),
  ]);
  const stac = el("button", { class: "btn", type: "button" }, [
    brandIcon("stac", { size: 16 }),
    el("span", { text: "STAC catalogue (.zip)" }),
  ]);
  reg.listen(intake, "click", () => dl("intake"));
  reg.listen(stac, "click", () => dl("stac"));

  return el("div", { class: "info-actions" }, [
    primary,
    lockNote,
    infoSec("download", "Download as catalog"),
    el("p", {
      class: "scope-note",
      text: multi
        ? `scoped to your ${target.count} picks - file= constraint`
        : "scoped to this file - file= constraint",
    }),
    intake,
    stac,
  ]);
}

// single-file view
/**
 * Partial-failure indicator + "Retry failed" - shown in BOTH the single-file and diff views.
 * When N targets are selected and only one loads the view is single-file, yet the failure of
 * the others must still be surfaced with a retry, so a 1-of-2 success never drops it silently.
 * Retry clears the attempted/failed bookkeeping for the current set so only the missing files
 * are re-fetched.
 */
function partialFlag(ctx: AppContext, reg: Disposables, failedCount: number): HTMLElement | null {
  if (!failedCount) return null;
  const retryBtn = el("button", { class: "btn sm", type: "button", text: "Retry failed" });
  reg.listen(retryBtn, "click", () => {
    const s2 = store(ctx);
    s2.attempted.clear();
    s2.failed.clear();
    s2.sig = null;
    renderDetails(ctx);
  });
  return el("div", { class: "partial-flag" }, [
    el("span", { text: `${failedCount} file(s) could not be loaded. ` }),
    retryBtn,
  ]);
}

function renderSingle(
  ctx: AppContext,
  reg: Disposables,
  row: FileRow,
  target: ActionTarget,
  failedCount = 0,
): void {
  const scroll = ctx.roots.infoScroll;
  const nodes: HTMLElement[] = [
    el("div", { class: "info-name", text: basename(row.file) }),
    el("div", { class: "info-sub", text: dirname(row.file) }),
  ];
  const flag = partialFlag(ctx, reg, failedCount);
  if (flag) nodes.push(flag);

  // BBox - REAL, from `fields=bbox` on the ?file= response (Solr ENVELOPE). Absent -> the default.
  nodes.push(infoSec("box", "Bounding box"));
  if (row.bbox) {
    const svg = worldSVG(290, 150);
    // Report the NORMALISED extent: a global store publishes lon 0 -> 360, which reads as "the
    // eastern half" unless we say plainly that it covers everything.
    const nb = normalizeBboxLon(row.bbox);
    const lonText = nb.global
      ? "lon global (−180 → 180)"
      : `lon ${nb.minLon} → ${nb.maxLon}${nb.wraps ? " (crosses the antimeridian)" : ""}`;
    // Same on-demand upgrade as the editor: the SVG paints instantly; a "Zoom" click loads Leaflet
    // so the extent can be inspected up close. Read-only here - nothing to draw.
    const mini = el("div", { class: "minimap" }, [svg]);
    const zoomBtn = el(
      "button",
      {
        class: "map-zoom",
        type: "button",
        title: "Zoomable map",
        "aria-label": "Switch to the zoomable map",
      },
      [svgIcon(ICONS.search, { size: 13 }), el("span", { text: "Zoom" })],
    );
    reg.listen(zoomBtn, "click", () => {
      zoomBtn.disabled = true;
      zoomBtn.textContent = "Loading map…";
      void mountLeafletMap(ctx, reg, mini, { editable: false, bbox: row.bbox ?? null }).then(
        (h) => {
          if (!h) {
            zoomBtn.disabled = false;
            zoomBtn.textContent = "Zoom unavailable";
            return;
          }
          svg.remove(); // one map, not two
          mini.classList.add("has-leaflet");
          zoomBtn.remove();
        },
      );
    });
    const wrap = el("div", { class: "miniwrap" }, [
      el("div", { class: "map-slot" }, [mini, zoomBtn]),
      el("div", { class: "coords" }, [
        el("span", { text: lonText }),
        el("span", { text: `lat ${nb.minLat} → ${nb.maxLat}` }),
      ]),
    ]);
    nodes.push(wrap);
    paintRect(svg, row.bbox, 290, 150);
  } else {
    nodes.push(
      el("div", { class: "meta" }, [
        el("div", { class: "na", text: "Spatial extent: not available yet." }),
      ]),
    );
  }

  // Time - from the API when present, else derived from the filename (labelled as such), else absent.
  nodes.push(infoSec("clock", "Time"));
  const apiOrCached = row.timeRange;
  const inferredNow = apiOrCached ? null : timeRangeFromFilename(row.file);
  const tr = apiOrCached ?? inferredNow;
  const isInferred = inferredNow != null || row.timeRangeInferred === true;
  nodes.push(
    el("div", { class: "meta" }, [
      tr
        ? metaRow(isInferred ? "time range (from filename)" : "time range", tr)
        : el("div", { class: "na", text: "Time range: not available yet." }),
    ]),
  );

  // Facets - REAL, from the ?file= facets block.
  nodes.push(infoSec(null, "Facets (from ?file=)"));
  const meta = el("div", { class: "meta" });
  const entries = Object.entries(row.meta ?? {});
  if (entries.length) {
    for (const [k, v] of entries) meta.append(metaRow(labelFor(ctx.state, k), metaText(v)));
  } else {
    meta.append(el("div", { class: "na", text: "No per-file metadata returned." }));
  }
  nodes.push(meta);

  // `target` - not `[row.file]`. When several files are selected but only one returned metadata,
  // the VIEW is single-file (there is nothing to diff) while the ACTIONS still act on the whole
  // selection; passing the one loaded row here would silently downgrade them.
  nodes.push(actionsBlock(ctx, reg, target));
  replaceChildren(scroll, ...nodes);
}

// multi-pick diff view
/** A DEFENSIVE internal ceiling on the comparison table and its per-file fetches. The UI already
 *  caps selection at MAX_SELECTED_FILES, so this normally never bites; it exists so corrupted or
 *  restored state that exceeds the UI limit still cannot fan out into unbounded requests. */
const DIFF_MAX = MAX_SELECTED_FILES;

/** Open the comparison matrix full-screen in a scrollable overlay (scroll X and Y for wide tables). */
function openMatrixModal(
  ctx: AppContext,
  reg: Disposables,
  table: HTMLElement,
  title: string,
): void {
  const scope = reg.child(); // flushed on close AND when the details panel re-renders
  const prevFocus = document.activeElement as HTMLElement | null; // restored on close
  const close = (): void => {
    scope.flush();
  }; // focus is restored by the scope cleanup below
  const closeBtn = el("button", { class: "x", type: "button", "aria-label": "Close comparison" }, [
    svgIcon(ICONS.close, { size: 18 }),
  ]);
  const head = el("div", { class: "dmm-head" }, [
    el("span", { class: "dmm-title", text: title }),
    closeBtn,
  ]);
  const body = el("div", { class: "dmm-body" }, [table.cloneNode(true) as HTMLElement]);
  const modal = el(
    "div",
    {
      class: "dmm-modal",
      role: "dialog",
      "aria-modal": "true",
      "aria-label": title,
      tabindex: "-1",
    },
    [head, body],
  );
  const backdrop = el("div", { class: "dmm-backdrop" }, [modal]);
  scope.listen(closeBtn, "click", close);
  scope.listen(backdrop, "click", (e) => {
    if (e.target === backdrop) close();
  });
  const focusables = (): HTMLElement[] =>
    Array.from(
      modal.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((e) => !e.hasAttribute("disabled"));
  // Esc closes; Tab is trapped inside the dialog (modal focus containment).
  scope.listen(document, "keydown", (e) => {
    const ev = e as KeyboardEvent;
    if (ev.key === "Escape") {
      close();
      return;
    }
    if (ev.key !== "Tab") return;
    const f = focusables();
    if (f.length === 0) {
      ev.preventDefault();
      modal.focus();
      return;
    }
    const first = f[0];
    const last = f[f.length - 1];
    const active = document.activeElement;
    if (!modal.contains(active)) {
      ev.preventDefault();
      first.focus();
    } else if (ev.shiftKey && active === first) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && active === last) {
      ev.preventDefault();
      first.focus();
    }
  });
  scope.add(() => {
    try {
      backdrop.remove();
    } catch {
      /* gone */
    }
    // Restore focus on ANY teardown (explicit close, Escape, OR a details re-render that flushed this
    // scope). Defer past the synchronous rebuild: at flush time the opener is still in the DOM, but a
    // re-render is about to remove it - so decide AFTER the rebuild. A live opener wins; otherwise fall
    // back to the stable Details launcher so focus never lands on <body>.
    queueMicrotask(() => {
      const target = prevFocus && prevFocus.isConnected ? prevFocus : ctx.roots.infoBtn;
      if (target && target.isConnected) {
        try {
          target.focus();
        } catch {
          /* not focusable */
        }
      }
    });
  });
  ctx.roots.app.appendChild(backdrop);
  (focusables()[0] ?? modal).focus(); // move focus into the dialog on open
}

function renderDiff(
  ctx: AppContext,
  reg: Disposables,
  rows: FileRow[],
  target: ActionTarget,
  failedCount: number,
  hiddenCount = 0,
): void {
  const scroll = ctx.roots.infoScroll;
  const metas = rows.map((r) => r.meta ?? {});
  const keys = [...new Set(metas.flatMap((m) => Object.keys(m)))];
  const distinct = (k: string): string[] => [
    ...new Set(metas.map((m) => (k in m ? metaText(m[k]) : "-"))),
  ];
  const varying = keys.filter((k) => distinct(k).length > 1);
  const common = keys.filter((k) => !varying.includes(k));

  const nodes: HTMLElement[] = [
    // The SELECTED count heads the panel; `rows.length` is only how many could be compared.
    el("div", { class: "info-name", text: `${target.count} files selected` }),
    el("div", {
      class: "info-sub",
      text: `comparing - ${varying.length} field${varying.length === 1 ? "" : "s"} differ`,
    }),
  ];
  if (failedCount) {
    const flag = partialFlag(ctx, reg, failedCount);
    if (flag) nodes.push(flag);
  }

  nodes.push(infoSec(null, "Differences"));
  if (varying.length) {
    const summary = el("div", { class: "diff-summary" });
    for (const k of varying)
      summary.append(
        el("span", { class: "varchip" }, [
          el("span", { class: "vc-k", text: labelFor(ctx.state, k) }),
          el("span", { class: "vc-n", text: String(distinct(k).length) }),
        ]),
      );
    nodes.push(summary);

    // matrix: one numbered row per file, a column per differing field
    const colValues: Record<string, string[]> = {};
    for (const k of varying) colValues[k] = distinct(k);
    const thead = el("tr", {}, [
      el("th", { text: "#" }),
      ...varying.map((k) => el("th", { text: labelFor(ctx.state, k) })),
    ]);
    const tbody = rows.map((r, i) => {
      const m = metas[i];
      const cells = varying.map((k) => {
        const val = k in m ? metaText(m[k]) : "-";
        const color = PALETTE[colValues[k].indexOf(val) % PALETTE.length];
        return el("td", {}, [
          el("span", {
            class: "dchip",
            style: `background:${rgba(color, 0.16)};color:${color}`,
            text: val,
          }),
        ]);
      });
      return el("tr", {}, [
        el("td", { class: "rownum", title: basename(r.file), text: String(i + 1) }),
        ...cells,
      ]);
    });
    const table = el("table", { class: "dmatrix" }, [
      el("thead", {}, [thead]),
      el("tbody", {}, tbody),
    ]);
    const enlarge = el(
      "button",
      { class: "btn diff-enlarge", type: "button", title: "Open the comparison full-screen" },
      [svgIcon(ICONS.expandWide, { size: 14 }), el("span", { text: "Enlarge" })],
    );
    reg.listen(enlarge, "click", () =>
      openMatrixModal(
        ctx,
        reg,
        table,
        `Comparing ${rows.length} file${rows.length === 1 ? "" : "s"}`,
      ),
    );
    nodes.push(el("div", { class: "diff-tools" }, [enlarge]));
    nodes.push(
      el("div", { class: "dscroll", role: "region", "aria-label": "Per-file differences" }, [
        table,
      ]),
    );
    if (hiddenCount > 0) {
      nodes.push(
        el("p", {
          class: "scope-note",
          style: "margin:6px 16px 0",
          text: `Comparing the first ${DIFF_MAX} files - ${hiddenCount} more selected. Deselect some to compare the rest.`,
        }),
      );
    }
  } else {
    // "identical" is a real claim; only make it when there were fields to compare. With no
    // per-file metadata at all, say so honestly rather than inventing agreement from nothing.
    nodes.push(
      el("p", {
        class: "scope-note",
        style: "margin:0 16px",
        text:
          keys.length === 0
            ? `No per-file metadata was returned to compare across these ${rows.length} files.`
            : `Every field is identical across the ${rows.length} files.`,
      }),
    );
  }

  // Shared-by-all collapsible block
  const sharedBody = el("div", { class: "shared-body" }, [
    el(
      "div",
      { class: "meta" },
      common.map((k) => metaRow(labelFor(ctx.state, k), metaText(metas[0][k]))),
    ),
  ]);
  const sharedHead = el("div", { class: "info-sec shared-head", role: "button", tabindex: "0" }, [
    svgIcon(ICONS.check, { size: 13 }),
    el("span", { text: `Shared by all ${rows.length}` }),
    el("span", { class: "chev2" }, [svgIcon(ICONS.caret, { size: 12 })]),
  ]);
  const shared = el("div", { class: "shared open" }, [sharedHead, sharedBody]);
  const toggleShared = (): void => {
    shared.classList.toggle("open");
  };
  reg.listen(sharedHead, "click", toggleShared);
  reg.listen(sharedHead, "keydown", (e) => {
    const k = (e as KeyboardEvent).key;
    if (k === "Enter" || k === " ") {
      e.preventDefault();
      toggleShared();
    }
  });
  nodes.push(shared);

  nodes.push(actionsBlock(ctx, reg, target));
  replaceChildren(scroll, ...nodes);
}

// states
function renderEmpty(ctx: AppContext, msg?: string): void {
  replaceChildren(
    ctx.roots.infoScroll,
    el("div", { class: "empty" }, [
      el("div", { class: "big" }, [svgIcon(ICONS.info, { size: 30 })]),
      el("p", {}, [
        document.createTextNode(msg ?? "Details is on. Click a file to query "),
        msg ? null : el("code", { text: "?file=<name>" }),
        document.createTextNode(msg ? "" : " - nothing is fetched until you do."),
      ]),
    ]),
  );
}
function renderLoading(ctx: AppContext, what: string): void {
  replaceChildren(
    ctx.roots.infoScroll,
    el("div", { class: "querying" }, [
      el("span", { text: `querying ?file= for ${what}…` }),
      el("div", { class: "bar" }),
    ]),
  );
}
function renderError(ctx: AppContext, reg: Disposables, msg: string): void {
  const retry = el("button", { class: "btn", type: "button" }, [
    svgIcon(ICONS.retry, { size: 15 }),
    el("span", { text: "Retry" }),
  ]);
  reg.listen(retry, "click", () => {
    const s = store(ctx);
    s.attempted.clear();
    s.failed.clear();
    renderDetails(ctx);
  });
  replaceChildren(
    ctx.roots.infoScroll,
    el("div", { class: "state-msg err" }, [el("p", { text: msg }), retry]),
  );
}

// fetch orchestration
/** Run `fn` over `items` at most `limit` at a time, preserving order. Selection is unlimited, so a
 *  large diff must NOT fire one parallel request per file - this bounds the in-flight set while
 *  still fetching every pick. `fn` catches its own errors, so this never rejects. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}
const DETAILS_CONCURRENCY = 6;
const DETAILS_CACHE_MAX = 500; // session cap on cached per-file metadata (FIFO eviction)

function ensureFetch(ctx: AppContext, present: FileRow[], missing: FileRow[]): void {
  const s = store(ctx);
  const flavour = ctx.state.flavour; // capture: the lens may change while this request is in flight
  const sig = setSignature(present, flavour);
  if (s.sig === sig) return; // already fetching this exact set
  s.sig = sig;
  const reqId = ctx.api.nextRequestId();
  s.reqId = reqId;
  ctx.state.details = "loading";
  const signal = ctx.api.channelSignal("details");

  void mapPool(missing, DETAILS_CONCURRENCY, (r) =>
    ctx.api
      .filePathMetadata(flavour, [r.file], signal)
      .then((res) => ({ ok: true as const, r, res }))
      .catch((err: unknown) => ({ ok: false as const, r, err })),
  )
    .then((results) => {
      if (s.reqId !== reqId || ctx.state.flavour !== flavour) return; // superseded, or the lens changed under us
      let aborted = false;
      for (const out of results) {
        s.attempted.add(out.r.key);
        if (out.ok) {
          // The row for THIS file in the response carries the optional time/bbox fields. When they
          // are present we show the REAL extent; when the index omits them we fall back to what we
          // had before (a filename-derived range, else "not available") - never a fabricated one.
          const hit =
            (out.res.search_results ?? []).find((x) => (x.file ?? x.uri) === out.r.file) ??
            (out.res.search_results ?? [])[0];
          const box = parseEnvelope((hit as { bbox?: unknown } | undefined)?.bbox);
          const range = parseSolrTimeRange((hit as { time?: unknown } | undefined)?.time);
          const inferred = range ? null : timeRangeFromFilename(out.r.file);
          const cache = ctx.state.detailsCache;
          cache.set(cacheKey(flavour, out.r.key), {
            ...out.r,
            meta: metaFromFacetsBlock(out.res.facets ?? {}), // a 2xx with no facets is not fatal
            bbox: box ? { ...box, mode: "flexible" } : out.r.bbox,
            timeRange: range ?? inferred ?? undefined,
            timeRangeInferred: !range && !!inferred,
          });
          // Bound the session cache: a long browse of many files must not grow it without limit. Map
          // preserves insertion order, so the first key is the oldest - evict from the front.
          while (cache.size > DETAILS_CACHE_MAX) {
            const oldest = cache.keys().next().value as string | undefined;
            if (oldest === undefined) break;
            cache.delete(oldest);
          }
          s.failed.delete(out.r.key);
        } else if (out.err instanceof ApiError && out.err.aborted) {
          aborted = true;
        } else {
          s.failed.add(out.r.key);
          s.errorMsg = out.err instanceof ApiError ? out.err.message : "Details request failed.";
        }
      }
      if (aborted) return;
      s.sig = null;
      renderDetails(ctx);
    })
    .catch(() => {
      // Never leave the panel stuck spinning if response processing throws (e.g. a 2xx whose
      // shape we didn't expect). Commit an honest error state and re-render.
      if (s.reqId !== reqId || ctx.state.flavour !== flavour) return;
      for (const r of missing) {
        s.attempted.add(r.key);
        s.failed.add(r.key);
      }
      s.errorMsg = "Details response could not be read.";
      s.sig = null;
      renderDetails(ctx);
    });
}

const cacheKey = (flavour: string, fileKey: string): string => `${flavour}::${fileKey}`; // metadata is flavour-specific

export function renderDetails(ctx: AppContext): void {
  const reg = ctx.region("details");
  const info = ctx.roots.info;
  if (!ctx.state.detailsOpen) {
    info.classList.add("collapsed");
    return;
  }
  info.classList.remove("collapsed");

  const s = store(ctx);
  const keys = targetKeys(ctx);
  if (keys.length === 0) {
    ctx.state.details = "idle";
    renderEmpty(ctx);
    return;
  }

  // resolve keys -> currently-present rows; drop any that paged out / were cleared
  const byKey = new Map(ctx.state.rows.map((r) => [r.key, r]));
  const resolved = keys
    .map((k) => ctx.state.detailsCache.get(cacheKey(ctx.state.flavour, k)) ?? byKey.get(k))
    .filter((r): r is FileRow => !!r);
  // The comparison table (and its per-file fetches) get expensive past a point. Cap what we
  // fetch AND render to DIFF_MAX; anything beyond is reported as a count, not silently dropped.
  const hiddenCount = Math.max(0, resolved.length - DIFF_MAX);
  const present = hiddenCount > 0 ? resolved.slice(0, DIFF_MAX) : resolved;
  if (present.length === 0) {
    ctx.state.details = "empty";
    renderEmpty(ctx, "The selected file is no longer in the results.");
    return;
  }

  // When the target set changes, the attempted/failed bookkeeping no longer applies - clear it
  // so a file that failed transiently in a previous set is re-fetched here. Cached files
  // are unaffected (the cache check below still skips them).
  const sig = setSignature(present, ctx.state.flavour);
  if (s.sigSeen !== sig) {
    s.attempted.clear();
    s.failed.clear();
    s.sigSeen = sig;
  }

  const missing = present.filter(
    (r) =>
      !ctx.state.detailsCache.has(cacheKey(ctx.state.flavour, r.key)) && !s.attempted.has(r.key),
  );
  if (missing.length) {
    ensureFetch(ctx, present, missing);
    renderLoading(ctx, present.length > 1 ? `${present.length} files` : basename(present[0].file));
    return;
  }

  // everything has been attempted; gather what loaded
  const loaded = present.filter((r) =>
    ctx.state.detailsCache.has(cacheKey(ctx.state.flavour, r.key)),
  );
  const failedCount = present.length - loaded.length;
  if (loaded.length === 0) {
    ctx.state.details = "error";
    renderError(ctx, reg, s.errorMsg || "No metadata returned.");
    return;
  }
  ctx.state.details = "loaded";
  const rows = loaded.map(
    (r) => ctx.state.detailsCache.get(cacheKey(ctx.state.flavour, r.key)) as FileRow,
  );
  // The action target is the SELECTION (every present row), independent of which fetches succeeded.
  const target: ActionTarget = {
    files: present.map((r) => r.file),
    count: present.length,
  };
  if (rows.length > 1) renderDiff(ctx, reg, rows, target, failedCount, hiddenCount);
  else renderSingle(ctx, reg, rows[0], target, failedCount);
}
