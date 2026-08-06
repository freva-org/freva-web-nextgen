// index.ts - the public entry point and the controller. mountDataBrowser builds the shell DOM,
// injects the stylesheet, wires the AppContext that every component depends on, and owns the
// search lifecycle (debounce + monotonic request ids + abort-prior, so a burst of toggles can
// never let a stale response overwrite a newer one). destroy() flushes the Disposables
// registry (every listener/timer/in-flight request) and removes the root, leaving nothing behind.

import { Api, ApiError } from "./api.js";
import type { AppContext, LogSeverity, Roots } from "./context.js";
import { Disposables, el, makeDebounce, svgIcon } from "./dom.js";
import { brandIcon, brandSprite } from "./brand.js";
import { LOGO_DATA_URI } from "./logo.js";
import { ICONS } from "./icons.js";
import { DEFAULT_MAP_CONFIG } from "./map.js";
import { PopoverManager } from "./popover.js";
import {
  BUILTIN_FLAVOURS,
  buildFacets,
  isGatedKey,
  PRIMARY_FACET_FALLBACK,
  ADDITIONAL_FACET_FALLBACK,
  CONTROL_KEYS,
  rememberOverviewShape,
  buildFlavourMaps,
  queryPairs,
  clearAll,
  clearSelectedFacet,
  createInitialState,
  roundBbox,
  parseControlTokens,
  parseUrlQuery,
  facetQueryString,
  filterCommittable,
  knownFacetKeys,
  normalizeBaseFilters,
  translateKey,
  fromApiRow,
  parseFacetTokens,
  selectionsEqual,
  toggleSelected,
  translateSelection,
} from "./state.js";
import { createPerf } from "./perf.js";
import { initialMetadata, resolveMetadata } from "./metadata.js";
import { STYLES } from "./styles.js";
import {
  loadLayout,
  loadOverviewPrefs,
  loadSidebarCollapsed,
  loadTheme,
  loadView,
  saveLayout,
  saveSidebarCollapsed,
  saveTheme,
  saveView,
} from "./theme.js";
import {
  STREAM_CATALOGUE_MAXIMUM,
  STREAM_TOO_BIG_DETAIL,
  type AppState,
  type BBoxSelection,
  type DataBrowserConfig,
  type DataBrowserHandle,
  type FlavourName,
  type ResolvedConfig,
  type TimeSelection,
} from "./types.js";

import { renderChips } from "./components/chips.js";
import { renderDetails } from "./components/details.js";
import { renderOverview, syncOverviewSelection, toggleStack } from "./components/overview.js";
import { renderPickbar } from "./components/pickbar.js";
import { renderResults, updateRowStates } from "./components/results.js";
import { renderSidebar } from "./components/sidebar.js";
import { openBboxEditor } from "./components/bboxEditor.js";
import { openTimeEditor } from "./components/timeEditor.js";
import { createTerminal, type TerminalController } from "./components/terminal.js";
import { createNotes, type NotesController } from "./components/notes.js";
import { createValueSearch } from "./components/searchBar.js";
import { createConsole, type ConsoleController } from "./components/console.js";
import { installTooltips } from "./components/tooltip.js";
import { createInspector, DEFAULT_INSPECTOR_URL } from "./components/inspector.js";

const DEFAULT_API_BASE = "/api/freva-nextgen/databrowser";
const SEARCH_DEBOUNCE_MS = 250;
const RECOUNT_DEBOUNCE_MS = 300;

function resolveConfig(config: DataBrowserConfig): ResolvedConfig {
  const map = { ...DEFAULT_MAP_CONFIG, ...(config.map ?? {}) };
  return {
    map,
    inspectorUrl: config.inspectorUrl ?? DEFAULT_INSPECTOR_URL,
    apiBase: config.apiBase ?? DEFAULT_API_BASE,
    flavour: config.flavour ?? "freva",
    devNotes: config.devNotes ?? false,
    authEnabled: config.authEnabled ?? false,
    enableHeavyOps: config.enableHeavyOps ?? false,
    syncUrl: config.syncUrl ?? true,
    baseFilters: config.baseFilters,
    enableStrictBBoxModes: config.enableStrictBBoxModes ?? false,
    metadata: config.metadata ?? {},
    metadataScriptUrl:
      config.metadataScriptUrl === undefined ? "/static/js/metadata.js" : config.metadataScriptUrl,
    features: {
      themeToggle: config.features?.themeToggle ?? true,
      terminal: config.features?.terminal ?? true,
      overview: config.features?.overview ?? true,
      export: config.features?.export ?? true,
      details: config.features?.details ?? true,
      search: config.features?.search ?? true,
      lensSwitcher: config.features?.lensSwitcher ?? true,
      inspect: config.features?.inspect ?? true,
      brand: config.features?.brand ?? true,
    },
    theme: config.theme ?? {},
    brand: {
      title: config.brand?.title ?? "Freva",
      mark: config.brand?.mark ?? "≈",
      description: config.brand?.description ?? "",
    },
    terminal: {
      host: config.terminal?.host ?? null,
      shell: config.terminal?.shell ?? null,
      os: config.terminal?.os ?? null,
    },
    getAuthToken: config.getAuthToken ?? ((): string | null => null),
    getCsrfToken: config.getCsrfToken ?? ((): string | null => null),
  };
}

interface ShellRefs {
  outer: HTMLElement;
  shell: HTMLElement;
  roots: Roots;
  lensBtn: HTMLButtonElement;
  themeBtn: HTMLButtonElement;
  themeKnob: HTMLElement;
  notesBtn: HTMLButtonElement | null;
  helpPanel: HTMLElement;
  sideCollapse: HTMLButtonElement;
  searchInput: HTMLInputElement;
  resultsCtrl: HTMLButtonElement;
  shelveBtn: HTMLButtonElement;
  overviewCtrl: HTMLButtonElement;
  listSeg: HTMLButtonElement;
  gridSeg: HTMLButtonElement;
  selectAllBtn: HTMLButtonElement;
  cmdBtn: HTMLButtonElement;
  inspectBtn: HTMLButtonElement;
  // the file-panel controls group + the scroller that observes it.
  resBar: HTMLElement;
  panelCtl: HTMLElement;
  resultsScroll: HTMLElement;
}

/** Build the entire shell DOM with el() (no innerHTML for data); collect the Roots + chrome refs. */
function buildShell(cfg: ResolvedConfig): ShellRefs {
  // top bar
  const themeKnob = el("span", { class: "knob" }, [svgIcon(ICONS.moon, { size: 15 })]);
  const themeBtn = el(
    "button",
    { class: "theme", type: "button", "aria-label": "Toggle theme", title: "Toggle day / night" },
    [themeKnob],
  );

  const lensValue = el("span", { class: "v", text: cfg.flavour });
  const lensBtn = el(
    "button",
    {
      class: "lens",
      type: "button",
      "aria-haspopup": "dialog",
      "aria-expanded": "false",
      "aria-label": "Naming flavour",
      title: "Change the naming flavour (metadata lens)",
    },
    [el("span", { class: "k", text: "Flavour" }), lensValue, svgIcon(ICONS.caret, { size: 14 })],
  );

  const searchInput = el("input", {
    class: "input",
    type: "text",
    placeholder: "Search values - e.g. tas",
    "aria-label": "Search facet values",
    autocomplete: "off",
    spellcheck: false,
  });
  const search = el("div", { class: "search" }, [
    el("span", { class: "ic" }, [svgIcon(ICONS.search, { size: 16 })]),
    searchInput,
  ]);

  const notesBtn = cfg.devNotes
    ? el(
        "button",
        {
          class: "icon-btn",
          type: "button",
          "aria-label": "Developer notes",
          title: "Developer notes",
        },
        [svgIcon(ICONS.notes, { size: 16 })],
      )
    : null;

  const f = cfg.features;
  const cmdBtn = el(
    "button",
    { class: "iconbtn", type: "button", "aria-label": "Command terminal", title: "Terminal" },
    [svgIcon(ICONS.terminal, { size: 20 })],
  );
  // Global Inspect launcher - opens the inspector with an empty prompt so the user can paste any
  // Zarr store URL to inspect (metadata + 3D viewer), independent of the current result rows.
  const inspectBtn = el(
    "button",
    {
      class: "iconbtn",
      type: "button",
      "aria-label": "Inspect data",
      title: "Inspect a dataset by URL (metadata & 3D viewer)",
    },
    [svgIcon(ICONS.inspect, { size: 18 })],
  );
  // The help panel is opened ONLY from the terminal's overflow (⋮) menu - the top bar stays clean.
  // The panel itself lives on the app root so it can render above the terminal window.
  // The animated freva mark: a bundled data-URI <img> (browser-animated on the compositor, no
  // network request). If the embedder overrides brand.mark to a custom string, honour that instead.
  // A WebP loop can't be paused via CSS, so under prefers-reduced-motion we render a STATIC mark
  // rather than an indefinitely-looping image (the existing reduced-motion CSS covers only the rest).
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
  const markNode =
    cfg.brand.mark === "\u2248"
      ? reduceMotion
        ? el("span", { class: "mark brand-mark-static", text: "\u2248", "aria-hidden": "true" })
        : el("img", {
            class: "brand-logo",
            src: LOGO_DATA_URI,
            alt: "",
            "aria-hidden": "true",
            decoding: "async",
          })
      : el("span", { class: "mark", text: cfg.brand.mark });
  const brand = el("div", { class: "brand" }, [markNode, el("span", { text: cfg.brand.title })]);
  const topChildren = [
    f.brand ? brand : null,
    f.lensSwitcher ? lensBtn : null,
    f.search ? search : null,
    notesBtn,
    f.inspect ? inspectBtn : null, // global "inspect by URL" launcher, beside the terminal + theme
    f.terminal ? cmdBtn : null, // launcher lives in the top bar, next to the theme toggle
    f.themeToggle ? themeBtn : null,
  ];
  const top = el("header", { class: "top" }, topChildren);

  // Help panel (app-level): how to install & point the freva-client at this instance.
  // Content is taken from the freva-client docs; all strings are literal (no API data here).
  const helpClose = el("button", { class: "help-x", type: "button", "aria-label": "Close help" }, [
    svgIcon(ICONS.close, { size: 15 }),
  ]);
  const helpPanel = el(
    "div",
    {
      class: "help-pop",
      role: "dialog",
      "aria-modal": "false",
      "aria-label": "Help and setup",
    },
    [
      el("div", { class: "help-head" }, [
        svgIcon(ICONS.terminal, { size: 16 }),
        el("span", { class: "t", text: "Run this search yourself" }),
        helpClose,
      ]),
      el("p", {
        text: "The terminal shows the exact CLI command and python call for whatever you have selected. To run them, install the client library:",
      }),
      el("pre", { class: "help-code", text: "python3 -m pip install freva-client" }),
      el("p", {
        text: "That gives you both the freva-client command line tool and the freva_client python library.",
      }),
      el("div", { class: "help-h2", text: "Pointing it at this instance" }),
      el("p", {
        text: "On a centrally administered freva instance there is nothing to do. If you installed the client yourself, set the host once in your config file:",
      }),
      el("pre", { class: "help-code", text: "~/.config/freva/freva.toml" }),
      el("p", {
        class: "help-dim",
        text: "FREVA_CONFIG can also point at a freva.toml elsewhere. That is why the commands here carry no --host flag.",
      }),
      el("a", {
        class: "help-link",
        href: "https://freva-org.github.io/freva-nextgen/",
        target: "_blank",
        rel: "noopener noreferrer",
        text: "freva-client documentation \u2197",
      }),
    ],
  );

  // sidebar
  const facetList = el("div", { class: "side-scroll" });
  const sideCollapse = el(
    "button",
    {
      class: "side-collapse",
      type: "button",
      "aria-label": "Collapse filters",
      title: "Collapse filter sidebar",
    },
    [el("span", { class: "chev" }, [svgIcon(ICONS.chevron, { size: 14 })])],
  );
  const side = el("aside", { class: "side" }, [
    // the sidebar renders its own "Filter · n" header (with Clear all), so only the collapse
    // control lives in this bar - a second static title would stack two words on top of each other.
    el("div", { class: "side-head" }, [sideCollapse]),
    facetList,
    el("div", { class: "side-flavour-veil", "aria-hidden": "true" }, [
      el("span", { class: "spin" }),
    ]),
  ]);

  // center: toprow
  const chips = el("div", { class: "chips" });
  const clearAllBtn = el("button", { class: "clear-btn", type: "button", text: "Clear all" });

  // Two TASK modes, labelled. Only the workspace switch belongs up here; layout and panel toggles
  // sit next to the results they act on. Equal-weight icon-only buttons answering three different
  // questions (which workspace? which layout? is a panel open?) are indistinguishable to the user.
  const resultsCtrl = el(
    "button",
    {
      class: "ctrl on",
      type: "button",
      "aria-label": "Browse results",
      title: "Browse the matching results",
    },
    [svgIcon(ICONS.resultsFocus, { size: 15 }), el("span", { class: "ctrl-lbl", text: "Browse" })],
  );
  const overviewCtrl = el(
    "button",
    {
      class: "ctrl",
      type: "button",
      "aria-label": "Overview",
      title: "Overview of the whole result set",
    },
    [svgIcon(ICONS.overview, { size: 15 }), el("span", { class: "ctrl-lbl", text: "Overview" })],
  );
  // Details is a PANEL toggle, not a destination - it lives in the result bar (built below).
  const infoBtn = el(
    "button",
    {
      class: "iconbtn tbtn",
      type: "button",
      "aria-label": "Details panel",
      title: "Details panel",
    },
    [svgIcon(ICONS.info, { size: 15 }), el("span", { class: "tbtn-lbl", text: "Details" })],
  );
  const cluster = el("div", { class: "ctrl-cluster" }, [
    resultsCtrl,
    f.overview ? overviewCtrl : null,
  ]);

  // Mode cluster sits on the RIGHT; chips fill the middle.
  const toprow = el("div", { class: "toprow" }, [chips, clearAllBtn, cluster]);

  // center: overview
  const overviewGrid = el("div", { class: "facet-grid" });
  const overviewWrap = el("div", { class: "overview-mode" }, [
    el("div", {
      class: "overview-cap",
      text: "Metadata overview - every facet for the current query at a glance.",
    }),
    overviewGrid,
  ]);

  // center: results bar
  const resCount = el("span", { class: "res-count", text: "-" });
  const resSpin = el("span", { class: "res-spin", "aria-hidden": "true" }, [
    el("span", { class: "spin" }),
  ]);
  const listSeg = el(
    "button",
    { type: "button", class: "on", "aria-label": "List view", title: "List view" },
    [svgIcon(ICONS.list, { size: 15 })],
  );
  const gridSeg = el("button", { type: "button", "aria-label": "Grid view", title: "Grid view" }, [
    svgIcon(ICONS.grid, { size: 15 }),
  ]);
  const seg = el("div", { class: "seg" }, [listSeg, gridSeg]);
  const exportBtn = el(
    "button",
    {
      class: "iconbtn tbtn",
      type: "button",
      "aria-label": "Export catalogue",
      title: "Export catalogue",
    },
    [svgIcon(ICONS.download, { size: 15 }), el("span", { class: "tbtn-lbl", text: "Export" })],
  );
  // "Stack": minimize every overview block to a full-width row so they read as an accordion the
  // user expands one at a time. Overview-only - hidden in the file (results) layout (see applyLayout).
  const shelveBtn = el(
    "button",
    {
      class: "iconbtn tbtn ov-shelve",
      type: "button",
      hidden: "true",
      "aria-label": "Minimize all blocks to full-width rows",
      title: "Minimize every block to a full-width row - then expand them one at a time",
    },
    [svgIcon(ICONS.shelve, { size: 15 }), el("span", { class: "tbtn-lbl", text: "Stack" })],
  );
  // View + Details act on the FILE PANEL, so they live in one group that is
  // shown only while the panel is on screen. The count/scope and Export are query-scope - they
  // sit OUTSIDE this group and never move. The trailing divider is inside the group so that when
  // it fades out no orphaned separator is left dangling to the left of Export.
  const selectAllCb = el("span", { class: "cb", "aria-hidden": "true" });
  const selectAll = el(
    "button",
    {
      class: "selall",
      type: "button",
      "aria-label": "Select all listed files",
      title: "Select all currently listed files",
    },
    [selectAllCb, el("span", { class: "ctrl-lbl", text: "Select all" })],
  );
  const panelCtl = el("span", { class: "panelctl in" }, [
    selectAll,
    el("span", { class: "bar-div" }),
    el("span", { class: "view-lbl", text: "View" }),
    seg,
    f.details ? el("span", { class: "bar-div" }) : null,
    f.details ? infoBtn : null, // the panel toggle sits next to the results it opens
    f.export ? el("span", { class: "bar-div" }) : null,
  ]);
  const resBarKids = [
    // "Whole result set" is status text, not a control - it must not be styled as a pill.
    el("span", { class: "scope-lbl", text: "Whole result set" }),
    resCount,
    resSpin,
    cfg.brand.description ? el("span", { class: "scope-desc", text: cfg.brand.description }) : null,
    el("span", { class: "spacer" }),
    panelCtl,
    shelveBtn, // overview-only; applyLayout hides it in the file layout
    f.export ? exportBtn : null, // an ACTION - query-scope, always present, never migrates
  ];
  const resBar = el("div", { class: "res-bar" }, resBarKids);

  // center: command strip + results + pagination
  const cmdStrip = el("div", { class: "cmd" }); // terminal builds its skeleton inside
  // List-view column header (uri | fs type). Lives OUTSIDE the results host (which counts its
  // children for incremental append), and is shown only in list view with rows (toggled in render).
  const listHead = el("div", { class: "list-head", hidden: "true" }, [
    el("span", { class: "lh-uri", text: "uri" }),
    el("span", { class: "lh-fs", text: "fs type" }),
  ]);
  const results = el("div", { class: "rows", id: "fdb-results" });
  const moreWrap = el("div", { class: "more-wrap" });

  // only the results column scrolls.
  // Overview lives INSIDE the scroller so metadata-focused view keeps the file list below it
  const centerFixed = el("div", { class: "center-fixed" }, [toprow, resBar]);
  const resultsScroll = el("div", { class: "results-scroll" }, [
    overviewWrap,
    cmdStrip,
    listHead,
    results,
    moreWrap,
  ]);

  // pickbar (floats inside .center)
  const pickbar = el("div", { class: "pickbar" });
  const center = el("main", { class: "center" }, [centerFixed, resultsScroll, pickbar]);

  // info / details panel
  const infoScroll = el("div", { class: "info-scroll" });
  const infoClose = el(
    "button",
    { class: "x", type: "button", "aria-label": "Close details", title: "Close details" },
    [svgIcon(ICONS.close, { size: 16 })],
  );
  const info = el("aside", { class: "details-panel collapsed" }, [
    el("div", { class: "info-head" }, [
      svgIcon(ICONS.info, { size: 16 }),
      el("span", { class: "t", text: "Details" }),
      infoClose,
    ]),
    infoScroll,
  ]);

  // info-head close shares the toggle with the cluster button
  infoClose.dataset.role = "details-close";

  const body = el("div", { class: "body" }, [side, center, info]);

  // status footer (colored one-line activity + toasts)
  // Every activity lands on this one footer line with a severity colour (green ok / yellow warning
  // / red error), each message overriding the previous.
  const statusDot = el("span", { class: "status-dot info" });
  const statusMsg = el("span", { class: "mono" });
  const status = el("footer", { class: "status", "aria-live": "polite", "aria-label": "Status" }, [
    statusDot,
    statusMsg,
  ]);
  const toastHost = el("div", { class: "toast-host", "aria-live": "polite" });

  const shell = el("div", { class: "fdb-app" }, [top, body, status]);
  // overlays live on the outer box (not the app grid, whose rows must stay header/body/footer)
  const outer = el("div", { class: "freva-db", "data-theme": "night" }, [
    shell,
    toastHost,
    helpPanel,
  ]);

  // reduced-motion attribute (honours the user preference for skeleton/shimmer)
  if (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    shell.setAttribute("data-reduced-motion", "true");
  }

  const roots: Roots = {
    app: outer,
    facetList,
    chips,
    clearAllBtn,
    overviewWrap,
    overviewGrid,
    resCount,
    resSpin,
    exportBtn,
    shelveBtn,
    selectAllBtn: selectAll,
    cmdStrip,
    listHead,
    results,
    moreWrap,
    pickbar,
    info,
    infoScroll,
    infoBtn,
    statusMsg,
    statusDot,
    toastHost,
    lensValue,
  };

  // keep the close button reachable to the controller via a dataset hook
  (roots as Roots & { infoClose?: HTMLButtonElement }).infoClose = infoClose;

  return {
    outer,
    shell,
    roots,
    lensBtn,
    themeBtn,
    themeKnob,
    notesBtn,
    helpPanel,
    sideCollapse,
    searchInput,
    resultsCtrl,
    overviewCtrl,
    shelveBtn,
    listSeg,
    gridSeg,
    selectAllBtn: selectAll,
    cmdBtn,
    inspectBtn,
    resBar,
    panelCtl,
    resultsScroll,
  };
}

export function mountDataBrowser(
  target: HTMLElement,
  config: DataBrowserConfig = {},
): DataBrowserHandle {
  const cfg = resolveConfig(config);
  const refs = buildShell(cfg);
  const { roots, shell } = refs;

  // inject the stylesheet once into the root subtree
  const styleEl = el("style", { type: "text/css" });
  styleEl.textContent = STYLES;
  roots.app.insertBefore(styleEl, roots.app.firstChild);
  // inject the brand-logo sprite once (nc/grib/zarr/stac/intake reference it via <use>, so the
  // heavy path data lives in the DOM a single time instead of per result card). Removed with the app.
  roots.app.insertBefore(brandSprite(), roots.app.firstChild);

  const dis = new Disposables();
  const api = new Api(cfg, dis);
  const popover = new PopoverManager(roots.app, dis);

  const state: AppState = createInitialState(cfg);
  state.flavour = cfg.flavour;
  state.theme = cfg.theme.mode ?? loadTheme(); // a host can open the widget in its own mode
  state.layout = loadLayout();
  state.view = loadView();
  state.flavours = [...BUILTIN_FLAVOURS];
  // On a phone the filter sidebar starts COLLAPSED (a slim rail the user taps to open) so the file
  // results own the narrow screen - unless the user has explicitly opened/collapsed it before.
  const narrowStart = typeof matchMedia === "function" && matchMedia("(max-width: 560px)").matches;
  state.sidebarCollapsed = loadSidebarCollapsed(narrowStart);
  // restore persisted metadata-view block choices
  const ovPrefs = loadOverviewPrefs();
  if (ovPrefs) {
    state.overviewSort = ovPrefs.sort;
    state.overviewCollapsed = new Set(ovPrefs.collapsed);
    state.overviewSpan = ovPrefs.span;
    state.overviewH = ovPrefs.h ?? {};
    state.overviewOrder = ovPrefs.order;
    state.overviewAddOpen = ovPrefs.addOpen;
    state.overviewStacked = ovPrefs.stacked ?? false;
    state.overviewStackSeen = ovPrefs.stackSeen ?? [];
    state.overviewSnapshot = ovPrefs.snapshot ?? null;
  }
  // Config-supplied descriptions are available immediately; the deployment script (if any)
  // merges UNDER them once it lands (config wins per key/value).
  state.metadata = initialMetadata(cfg);
  state.baseFilters = normalizeBaseFilters(cfg.baseFilters); // the invisible always-applied scope

  // Deep-link: the URL is the source of truth on load. Apply flavour FIRST (the facet keys in the
  // link are in that flavour's naming), then the facets/time/bbox. This runs before the first
  // render and search, so the sidebar, chips and terminal all derive from the restored state - no
  // desync. Reserved transport keys are already stripped by parseUrlQuery; here we also VALIDATE the
  // flavour (it lands in the request path) and record which keys we imported so writes preserve any
  // unrelated host-page params instead of erasing them.
  const urlOwnedKeys = new Set<string>();
  let urlImportsReconciled = false; // one-shot: drop non-facet URL params once real facet keys load
  let overviewFailed = false; // /overview settled with an error -> enables the reconcile fallback vocab
  let pendingUrlFlavour: string | null = null; // a URL flavour not yet in the (builtin-only) list
  if (cfg.syncUrl && typeof window !== "undefined" && window.location) {
    try {
      const link = parseUrlQuery(window.location.search);
      if (link.flavour && state.flavours.includes(link.flavour)) {
        state.flavour = link.flavour; // only a known flavour may steer the request path - apply FIRST
        roots.lensValue.textContent = state.flavour; // …and reflect it in the header dropdown label
      } else if (link.flavour) {
        pendingUrlFlavour = link.flavour; // custom flavour: reconsider once /overview lists it
      }
      // A key that's part of the base scope must NOT also be imported as a removable facet - the gate
      // owns it. Computed AFTER the flavour is applied so gated keys translate under the right flavour.
      const gated = new Set(
        Object.keys(state.baseFilters).map((k) => translateKey(state, k, "freva", state.flavour)),
      );
      for (const k of gated) delete link.selected[k];
      if (Object.keys(link.selected).length) {
        state.selected = link.selected;
        for (const k of Object.keys(link.selected)) urlOwnedKeys.add(k);
      }
      if (link.time) {
        state.time = link.time;
        urlOwnedKeys.add("time");
        urlOwnedKeys.add("time_select");
      }
      if (link.bbox) {
        state.bbox = link.bbox;
        urlOwnedKeys.add("bbox");
        urlOwnedKeys.add("bbox_select");
      }
      if (link.flavour && state.flavours.includes(link.flavour)) urlOwnedKeys.add("flavour");
    } catch {
      /* a malformed URL must never block mount */
    }
  }

  const searchDebounce = makeDebounce(dis);
  const recountDebounce = makeDebounce(dis);
  const perf = createPerf(cfg.devNotes);

  let terminal: TerminalController | null = null;
  let notes: NotesController | null = null;
  let console_: ConsoleController | null = null;

  // status / counts / export-gate helpers
  // A "held" status (holdMs>0) survives the transient lifecycle statuses a debounced search
  // fires right after (Searching… -> ''). Rules:
  //   • holdMs>0  -> always writes AND (re)holds for holdMs. So a later held write (e.g. a real
  //                 error) overrides an earlier held warning - errors are never suppressed.
  //   • holdMs==0 -> a transient; suppressed only while a hold is active.
  // An explicit, unrelated operation (catalogue export) calls clearStatusHold() first so its
  // own progress/feedback isn't blocked by a lingering search-bar warning.
  let statusHoldUntil = 0;
  function classify(msg: string): LogSeverity {
    const m = msg.toLowerCase();
    if (/fail|error|could not|too big|couldn|unable|denied/.test(m)) return "error";
    if (/not applied|warn|narrow it|up to \d|still loading/.test(m)) return "warn";
    if (/downloaded|done|copied|complete|added|applied/.test(m)) return "success";
    return "info";
  }
  function setStatus(msg: string, holdMs = 0): void {
    const now = Date.now();
    if (holdMs <= 0 && now < statusHoldUntil) return; // an active hold suppresses transient status
    state.status = msg;
    // route through the console: it owns the one-line bar text + severity dot + ring buffer.
    if (console_ && msg) console_.log(classify(msg), msg);
    else roots.statusMsg.textContent = msg;
    statusHoldUntil = holdMs > 0 ? now + holdMs : 0;
  }
  function clearStatusHold(): void {
    statusHoldUntil = 0;
  }

  function updateResCount(): void {
    let text: string;
    if (state.search === "loading" && state.rows.length === 0) text = "Searching…";
    else if (state.search === "error") text = "Search failed";
    else if (state.rows.length === 0) text = "No files match";
    else {
      const n = state.totalCount.toLocaleString("en-US");
      text = `${n} ${state.totalCount === 1 ? "file" : "files"}`;
    }
    roots.resCount.textContent = text;
    // any search in flight (even a re-search with existing rows) shows a spinner, so
    // nothing slow looks idle.
    roots.resSpin.classList.toggle("show", state.search === "loading");
  }

  function exportDisabled(): boolean {
    return state.totalCount > STREAM_CATALOGUE_MAXIMUM;
  }

  function updateExportState(): void {
    const disabled = exportDisabled();
    const tip = disabled
      ? `Too many files to export (>${STREAM_CATALOGUE_MAXIMUM.toLocaleString("en-US")}) - narrow the query`
      : "Export catalogue";
    roots.exportBtn.setAttribute("aria-disabled", disabled ? "true" : "false");
    roots.exportBtn.classList.toggle("is-disabled", disabled); // greyed, not-allowed cursor (see CSS)
    roots.exportBtn.setAttribute("data-tip", tip);
    // Keep "Export catalogue" as the stable accessible NAME (its function), and append the reason
    // when gated so AT users hear WHY it's inert - not just that it is.
    roots.exportBtn.setAttribute(
      "aria-label",
      disabled
        ? `Export catalogue - unavailable: too many files (>${STREAM_CATALOGUE_MAXIMUM.toLocaleString("en-US")}); narrow the query`
        : "Export catalogue",
    );
  }

  // chrome appliers (pure DOM, no fetch)
  const THEME_TOKENS = [
    "bg",
    "surface",
    "surface-2",
    "surface-3",
    "text",
    "dim",
    "faint",
    "border",
    "border-2",
    "accent",
    "accent-2",
    "accent-soft",
    "good",
    "warn",
    "danger",
    "ocean",
    "land",
  ] as const;
  function applyThemeTokens(): void {
    // Embedder palette contract: clear any previously-set token, then apply `both` overrides and
    // the current theme's overrides on top (as CSS custom properties on the root).
    const rootStyle = roots.app.style;
    const safe = (v: unknown): v is string =>
      typeof v === "string" && v.length > 0 && v.length < 200 && !/[{}<>;]/.test(v);
    for (const t of THEME_TOKENS) rootStyle.removeProperty(`--${t}`);
    const merged = { ...(cfg.theme.both ?? {}), ...(cfg.theme[state.theme] ?? {}) };
    for (const [token, value] of Object.entries(merged)) {
      if (safe(value)) rootStyle.setProperty(`--${token}`, value); // reject values that could inject CSS
    }
    // Font (applies to both themes). Same value guard so config can't break out of the property.
    if (safe(cfg.theme.font)) rootStyle.setProperty("--ui", cfg.theme.font);
    else rootStyle.removeProperty("--ui");
  }
  function applyTheme(): void {
    roots.app.setAttribute("data-theme", state.theme);
    applyThemeTokens();
    refs.themeKnob.replaceChildren(
      svgIcon(state.theme === "night" ? ICONS.moon : ICONS.sun, { size: 15 }),
    );
  }
  function applyLayout(): void {
    shell.classList.toggle("metaview", state.layout === "overview");
    // shelve visibility is owned by setPanelControls (below, via syncPanelControls) so it can also
    // hide it once the file panel scrolls in; here we just keep its label in sync.
    if (state.layout === "overview") {
      const l = refs.shelveBtn.querySelector(".tbtn-lbl");
      if (l) l.textContent = state.overviewStacked ? "Unstack" : "Stack";
    }
    refs.resultsCtrl.classList.toggle("on", state.layout === "results");
    refs.resultsCtrl.setAttribute("aria-pressed", state.layout === "results" ? "true" : "false");
    refs.overviewCtrl.classList.toggle("on", state.layout === "overview");
    refs.overviewCtrl.setAttribute("aria-pressed", state.layout === "overview" ? "true" : "false");
    syncPanelControls();
  }

  // ONE rule: the file-panel controls (View + Details) are shown iff the file panel is on screen.
  // In Browse the panel is always visible, so the rule needs no observer and no special case -
  // "always on screen -> always shown". In Overview the file list sits below the metadata cards, so
  // the controls fade into the same bar only once it is scrolled to. Count + Export are
  // query-scope and never migrate.
  let panelIO: IntersectionObserver | null = null;
  let panelIOActive = false;
  function setPanelControls(on: boolean): void {
    refs.panelCtl.classList.toggle("in", on);
    refs.panelCtl.setAttribute("aria-hidden", on ? "false" : "true");
    // Keyboard-safe: while hidden the controls act on something off screen, so they leave the
    // tab order entirely (aria-hidden alone would still let a screen reader announce them).
    refs.panelCtl.querySelectorAll<HTMLElement>("button").forEach((b) => {
      b.tabIndex = on ? 0 : -1;
    });
    refs.resBar.classList.toggle("merged", on && state.layout === "overview");
    // Stack acts on the metadata BLOCKS. Hide it outside overview, and - only when we can
    // actually track scroll position (observer active) - once the file panel is reached (on = true).
    refs.shelveBtn.hidden = state.layout !== "overview" || (panelIOActive && on);
  }
  function syncPanelControls(): void {
    panelIO?.disconnect();
    panelIO = null;
    panelIOActive = false;
    if (state.layout !== "overview" || typeof IntersectionObserver !== "function") {
      // Browse (or no IntersectionObserver): the file panel is always on screen.
      setPanelControls(true);
      return;
    }
    panelIOActive = true;
    setPanelControls(false);
    // Hysteresis (no boundary flicker): reveal ~120px BEFORE the file panel reaches the fold,
    // and hide only once it is fully gone. A single observer on the results region drives it.
    panelIO = new IntersectionObserver(
      (entries) => setPanelControls(entries.some((e) => e.isIntersecting)),
      { root: refs.resultsScroll, rootMargin: "0px 0px -120px 0px", threshold: 0 },
    );
    panelIO.observe(roots.results);
  }
  dis.add(() => {
    panelIO?.disconnect();
    panelIO = null;
  });
  function applyView(): void {
    refs.listSeg.classList.toggle("on", state.view === "list");
    refs.gridSeg.classList.toggle("on", state.view === "grid");
  }
  function applySidebarCollapsed(): void {
    shell.classList.toggle("side-collapsed", state.sidebarCollapsed);
    refs.sideCollapse.setAttribute(
      "aria-label",
      state.sidebarCollapsed ? "Expand filters" : "Collapse filters",
    );
    refs.sideCollapse.setAttribute("aria-expanded", state.sidebarCollapsed ? "false" : "true");
  }
  function toggleSidebarCollapsed(): void {
    state.sidebarCollapsed = !state.sidebarCollapsed;
    saveSidebarCollapsed(state.sidebarCollapsed);
    applySidebarCollapsed();
  }

  // render orchestration (per-region change detection)
  // Each region's render is wrapped in a cheap input signature; a re-render only happens
  // when the signature changed since the region last rendered. That keeps a terminal
  // keystroke and a facet toggle cheap: only regions whose inputs changed rebuild, instead
  // of every keystroke rebuilding sidebar + chips + overview.
  const renderSigs = new Map<string, string>();
  function ifChanged(regionName: string, sig: string, render: () => void): void {
    if (renderSigs.get(regionName) === sig) return;
    renderSigs.set(regionName, sig);
    const stop = perf.start(`render:${regionName}`);
    render();
    stop();
  }
  const selSig = (): string => JSON.stringify(state.selected);
  const geoSig = (): string => JSON.stringify([state.time, state.bbox]);

  function renderSidebarIf(): void {
    ifChanged(
      "sidebar",
      JSON.stringify([
        state.facetsVersion,
        selSig(),
        geoSig(),
        state.flavour,
        [...state.sidebarOpen],
        state.sidebarAddOpen,
        state.metadataVersion,
      ]),
      () => renderSidebar(ctx),
    );
  }
  function renderChipsIf(): void {
    ifChanged("chips", JSON.stringify([selSig(), geoSig()]), () => renderChips(ctx));
  }
  function renderOverviewIf(): void {
    // The Overview tree is expensive (every primary facet card + its first value rows). Results view
    // hides it via CSS, so building it after each search is wasted work on the hot first-paint path.
    // Defer entirely while hidden; setLayout('overview') calls this on demand once it's revealed, and
    // the memo signature is left stale so that on-demand call always rebuilds with the latest state.
    if (state.layout !== "overview") return;
    ifChanged(
      "overview",
      JSON.stringify([
        // NB: selSig() is deliberately NOT part of this signature - including it re-renders the
        // whole overview on every facet click. A toggle patches the selection highlight in place
        // via syncOverviewSelection instead of rebuilding the grid.
        state.facetsVersion,
        geoSig(),
        state.flavour,
        state.overviewStale,
        state.metadataVersion,
        state.overviewSort,
        state.overviewSpan,
        state.overviewH,
        [...state.overviewCollapsed],
        state.overviewAddOpen,
        state.overviewOrder,
        state.overviewStacked,
      ]),
      () => renderOverview(ctx),
    );
  }
  function renderResultsIf(): void {
    ifChanged(
      "results",
      JSON.stringify([
        state.rowsVersion,
        state.view,
        state.search,
        state.searchError ?? "",
        state.totalCount,
      ]),
      () => renderResults(ctx),
    );
  }

  function renderCommand(): void {
    terminal?.render();
  }
  function syncAll(): void {
    renderSidebarIf();
    renderChipsIf();
    renderOverviewIf();
    syncOverviewSelection(ctx); // patch the highlight in place when the grid wasn't rebuilt
    renderCommand();
  }
  /** Full re-render after a committed search settles (each region still signature-guarded). */
  function afterSearch(): void {
    reconcileUrlImports(); // once facet keys are known, release any non-facet URL params to the host
    shell.classList.remove("flavour-loading"); // lift the flavour veil once counts land
    renderSidebarIf();
    renderChipsIf();
    renderOverviewIf();
    renderResultsIf();
    renderPickbar(ctx);
    renderDetails(ctx);
    renderCommand();
    updateResCount();
    updateExportState();
  }

  // search lifecycle
  async function runSearch(append: boolean): Promise<void> {
    const start = append ? state.rows.length : 0;
    const id = api.nextRequestId();
    state.lastRequestId = id;
    const rev = queryRevision; // the query this search is for; a later change bumps queryRevision
    const signal = api.channelSignal("search");
    state.search = "loading";
    if (!append) state.start = 0;
    renderResultsIf();
    updateResCount();
    if (!append) setStatus("Searching…");

    try {
      const stopFetch = perf.start("search:fetch+parse");
      const res = await api.extendedSearch(state.flavour, state.uniqKey, facetQueryString(state), {
        start,
        signal,
      });
      stopFetch();
      if (state.lastRequestId !== id || queryRevision !== rev) return; // superseded, or the query changed
      perf.time("search:normalize", () => {
        const rows = res.search_results.map((r) => fromApiRow(r, state.uniqKey));
        // In-place append (not concat): concat copies the whole accumulated array on every page, so a
        // long session paging to the ceiling is cumulatively O(n²). Push keeps it O(n) total; change
        // detection rides on rowsVersion/rowsEpoch, not array identity.
        if (append) {
          for (const r of rows) state.rows.push(r);
        } else {
          state.rows = rows;
          state.rowsEpoch++;
        } // a reset starts a new epoch; appends keep it (O(1) append check)
        rowsRevision = rev; // these rows belong to THIS query
        state.rowsVersion++;
        state.totalCount =
          typeof res.total_count === "number" ? res.total_count : state.rows.length;
        if (id >= facetsAppliedId) {
          facetsAppliedId = id;
          state.facets = buildFacets(res);
          state.facetsVersion++;
          state.primaryFacets = res.primary_facets ?? [];
          state.facetMapping = res.facet_mapping ?? {};
          rememberOverviewShape(state); // keep block layout stable on a later no-match query
        }
      });
      state.start = state.rows.length;
      state.search = state.rows.length === 0 ? "empty" : "loaded";
      state.searchError = undefined;
      state.overviewStale = false;
      afterSearch();
      setStatus(state.rows.length === 0 ? "No files match the current filters." : "");
    } catch (e) {
      if (e instanceof ApiError && e.aborted) return;
      if (state.lastRequestId !== id || queryRevision !== rev) return;
      const message = e instanceof ApiError ? e.message : "Search failed.";
      if (append) {
        // A "load next 100" failure must NOT wipe the already-loaded page: keep the rows,
        // stay in the loaded state, and surface the error in the status bar / load-more affordance.
        state.search = "loaded";
        renderResultsIf();
        updateResCount();
        setStatus(`Could not load more results: ${message}`, 4000);
        return;
      }
      state.search = "error";
      state.searchError = message;
      shell.classList.remove("flavour-loading"); // never leave the veil stuck on an error
      renderResultsIf();
      updateResCount();
      updateExportState();
      setStatus(message, 4000); // an error must override any held warning
      reconcileUrlImports(overviewFailed); // first-request failure: drop junk facet + retry (fallback vocab if /overview also failed)
    }
  }

  function reconcileUrlImports(useFallbackVocab = false): void {
    // Deep-linked params are imported optimistically at mount (we don't yet know the real facet keys).
    // Once the first payload tells us the actual attribute/facet keys, drop any imported key that
    // isn't a real facet - a host page's ?page= or ?utm_source= - and stop claiming ownership of it,
    // so it survives as a foreign param and "Clear all" can't erase it. Runs once.
    if (urlImportsReconciled || !cfg.syncUrl) return;
    let known = knownFacetKeys(state);
    if (known.size === 0) {
      // Normally we wait for a payload that defines the facet keys. But if BOTH /overview and the first
      // search have failed we'd otherwise stay stuck forever with the junk param disclosed. In that case
      // fall back to the STATIC freva facet vocabulary: it releases obvious host params (?page,
      // ?utm_source) so a clean retry isn't blocked, while preserving any real freva facet key.
      if (!useFallbackVocab) return;
      known = new Set(
        [...PRIMARY_FACET_FALLBACK, ...ADDITIONAL_FACET_FALLBACK, ...CONTROL_KEYS].map((k) =>
          k.toLowerCase(),
        ),
      );
    }
    urlImportsReconciled = true;
    let changed = false;
    for (const k of Object.keys(state.selected)) {
      if (!known.has(k.toLowerCase())) {
        delete state.selected[k]; // not a facet - release it back to the host page
        urlOwnedKeys.delete(k);
        changed = true;
      }
    }
    if (changed) {
      syncUrlFromState();
      commitSearch();
    } // clean URL + re-run without the junk filters
  }
  function syncUrlFromState(): void {
    if (!cfg.syncUrl || typeof window === "undefined" || !window.history?.replaceState) return;
    try {
      // Start from the CURRENT query so unrelated host-page params survive. Remove only the keys the
      // widget itself last wrote (urlOwnedKeys), then append this query's params and remember the new
      // owned set. This way "Clear all" drops the widget's params without erasing the embedder's.
      const p = new URLSearchParams(window.location.search);
      for (const k of urlOwnedKeys) p.delete(k);
      urlOwnedKeys.clear();
      if (state.flavour && state.flavour !== "freva") {
        p.set("flavour", state.flavour);
        urlOwnedKeys.add("flavour");
      }
      for (const [k, v] of queryPairs(state)) {
        p.append(k, v);
        urlOwnedKeys.add(k);
      }
      const qs = p.toString();
      const url = window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash;
      window.history.replaceState(null, "", url); // replace, not push - filtering shouldn't spam history
    } catch {
      /* URL updates are best-effort; never let them break a search */
    }
  }
  let heldScopedSearch = false; // a scoped search is waiting for the current custom flavour's map
  let flavoursSettled = false; // GET /flavours has resolved or failed -> the map set is now final
  // A scoped request can only be keyed correctly when the current flavour's freva↔flavour map is known.
  // Builtins always have a baked map; a custom flavour needs GET /flavours. No baseFilters ⇒ always ok.
  const canScopedSearch = (): boolean =>
    Object.keys(state.baseFilters).length === 0 ||
    BUILTIN_FLAVOURS.includes(state.flavour as FlavourName) ||
    !!state.flavourMaps[state.flavour];
  function failScope(): void {
    state.search = "error";
    state.searchError =
      "Scoped browsing is unavailable - this flavour’s field mapping could not be loaded.";
    shell.classList.remove("flavour-loading");
    renderResultsIf();
    updateResCount();
  }
  function commitSearch(): void {
    // Fail-closed: a custom flavour + baseFilters must not fire a search until its map is
    // known, or the gate goes out under the wrong key. Hold one search behind the veil while /flavours
    // is in flight; if it has already settled without this flavour's map, fail visibly. This covers
    // URL-driven and interactive flavour switches, not just the config-driven bootstrap.
    if (!canScopedSearch()) {
      if (flavoursSettled) failScope();
      else {
        heldScopedSearch = true;
        state.search = "loading";
        shell.classList.add("flavour-loading");
        renderResultsIf();
      }
      return;
    }
    // A query mutation changes state.selected/time/bbox/flavour SYNCHRONOUSLY, but the replacement
    // request id isn't minted until the debounced runSearch begins (SEARCH_DEBOUNCE_MS later). To
    // stop an in-flight OLD search/recount from settling during that window and writing rows/counts
    // for a query the user has already changed, bump a query revision now and abort in-flight work.
    // Every response must match BOTH the latest request id AND the current queryRevision to commit.
    queryRevision++;
    syncUrlFromState(); // keep the shareable link in step with the live query
    api.channelSignal("search"); // abort an in-flight search from the previous query
    api.channelSignal("recount"); // …and an in-flight recount
    searchDebounce(() => void runSearch(false), SEARCH_DEBOUNCE_MS);
  }
  function loadNextPage(): void {
    if (state.search === "loading") return;
    // The visible rows belong to a query the user has already changed (the replacement search is
    // still inside its debounce). Appending would splice a new-query page onto old-query rows at
    // the old offset - so wait for the replacement instead of paginating a dead result set.
    if (rowsRevision !== queryRevision) return;
    void runSearch(true);
  }
  function retrySearch(): void {
    void runSearch(false);
  }

  function recountOverview(): void {
    recountDebounce(() => {
      void (async (): Promise<void> => {
        // Same monotonic-id discipline as runSearch: the recount's facets are applied
        // only if no NEWER request (search or recount) started since. Without this, a slow
        // metadata-search could settle after a fresh extended-search and overwrite its
        // fresher facet counts with stale ones. Ids share one counter with searches, so the
        // comparison against state.lastRequestId is meaningful across the two channels.
        const id = api.nextRequestId();
        lastRecountId = id;
        const rev = queryRevision; // the query this recount is for
        const signal = api.channelSignal("recount");
        try {
          const res = await api.metadataSearch(
            state.flavour,
            state.uniqKey,
            facetQueryString(state),
            signal,
          );
          if (
            lastRecountId !== id ||
            state.lastRequestId > id ||
            id < facetsAppliedId ||
            queryRevision !== rev
          )
            return; // superseded or query changed
          facetsAppliedId = id;
          state.facets = buildFacets(res);
          state.facetsVersion++;
          state.primaryFacets = res.primary_facets ?? state.primaryFacets;
          state.facetMapping = res.facet_mapping ?? state.facetMapping;
          state.overviewStale = false;
          rememberOverviewShape(state); // keep the overview block layout stable
        } catch (e) {
          if (e instanceof ApiError && e.aborted) return;
          if (lastRecountId !== id || state.lastRequestId > id || queryRevision !== rev) return;
          state.overviewStale = true; // keep the previous counts, flag them
        }
        renderOverviewIf();
        renderSidebarIf();
      })();
    }, RECOUNT_DEBOUNCE_MS);
  }
  let lastRecountId = 0;
  // Monotonic query revision - bumped synchronously by commitSearch() on every query change, so a
  // response can tell whether the visible query still matches what it was fetched for (see above).
  let queryRevision = 0;
  // Which query revision the CURRENTLY DISPLAYED rows belong to (pagination is only valid while
  // this matches queryRevision - see loadNextPage).
  let rowsRevision = 0;
  // Shared high-water mark for FACET writes across the search and recount channels:
  // rows come only from searches, but facets come from both, so a stale search settling after
  // a newer recount must keep its rows yet NOT overwrite the fresher facets.
  let facetsAppliedId = 0;

  // mutations
  function toggleFacet(key: string, value: string): void {
    if (isGatedKey(state, key)) return; // the base scope owns this key - never mutate/search on it
    state.externalEdits++; // not typed in the terminal -> the terminal must re-sync
    toggleSelected(state, key, value);
    syncAll();
    commitSearch();
  }
  function clearFacet(key: string): void {
    if (isGatedKey(state, key)) return; // can't clear the gate
    if (!state.selected[key]?.length) return; // nothing selected -> no-op (no needless refetch)
    state.externalEdits++; // not typed in the terminal -> the terminal must re-sync
    clearSelectedFacet(state, key);
    syncAll();
    commitSearch();
  }
  function clearAllFacets(): void {
    state.externalEdits++; // not typed in the terminal -> the terminal must re-sync
    clearAll(state);
    syncAll();
    commitSearch();
  }
  function setTime(t: TimeSelection | null): void {
    state.externalEdits++; // not typed in the terminal -> the terminal must re-sync
    state.time = t;
    syncAll();
    commitSearch();
  }
  const timeEqual = (a: TimeSelection | null, b: TimeSelection | null): boolean =>
    (!a && !b) || (!!a && !!b && a.from === b.from && a.to === b.to && a.mode === b.mode);
  const bboxEqual = (a: BBoxSelection | null, b: BBoxSelection | null): boolean =>
    (!a && !b) ||
    (!!a &&
      !!b &&
      a.minLon === b.minLon &&
      a.maxLon === b.maxLon &&
      a.minLat === b.minLat &&
      a.maxLat === b.maxLat &&
      a.mode === b.mode);

  function setBbox(b: BBoxSelection | null): void {
    state.externalEdits++; // not typed in the terminal -> the terminal must re-sync
    // Rounded at the SOURCE (one rule, in state.ts) so the live query, the terminal and the copied
    // command can never disagree - a map drag otherwise yields 8-decimal noise.
    state.bbox = roundBbox(b);
    syncAll();
    commitSearch();
  }
  function setFlavour(f: FlavourName): void {
    state.externalEdits++; // not typed in the terminal -> the terminal must re-sync
    if (f === state.flavour) return;
    const from = state.flavour;
    state.flavour = f;
    // translate=true means every facet key we hold is in the OLD flavour's names - re-key the active
    // selection to the NEW flavour (model⇄source_id …). Values, time and bbox are flavour-invariant.
    state.selected = translateSelection(state, state.selected, from, f);
    state.overviewShape = []; // shape is keyed to the old flavour's names - let the next payload rebuild it
    applyAttributeKeys(); // the facet-key set is flavour-specific
    roots.lensValue.textContent = f;
    shell.classList.add("flavour-loading"); // clean spinner over the sidebar while labels re-fetch
    syncAll(); // re-label facets/command under the new lens
    commitSearch(); // re-fetch counts/mapping under the new flavour's names
  }
  function setLayout(l: "results" | "overview"): void {
    state.layout = l;
    saveLayout(l);
    applyLayout();
    if (l === "overview") {
      renderOverviewIf();
      syncOverviewSelection(ctx); // close the switch-into-overview-after-a-terminal-edit window
      recountOverview();
      // Overview *is* the metadata cards at the very top of the scroller. If the user had scrolled
      // down into the file list, those cards render off-screen above them and the toggle looks like
      // a no-op - so jump the scroller back to the top to reveal them. (scrollTo is absent in
      // jsdom/minimal DOMs -> optional call.)
      refs.resultsScroll.scrollTo?.({ top: 0 });
    }
  }
  function setView(v: "list" | "grid"): void {
    state.view = v;
    saveView(v);
    applyView();
    renderResultsIf();
  }
  let themeFlipGen = 0;
  function setTheme(t: "day" | "night"): void {
    const changed = state.theme !== t;
    state.theme = t;
    saveTheme(t);
    // A theme flip re-resolves every CSS variable; with per-node background/color transitions that
    // starts thousands of simultaneous 0.12–0.35s animations across the rows/facet values, which
    // stutters. Suppress transitions for the flip (two rAFs = one committed frame), so the toggle
    // is a single style pass.
    const gen = ++themeFlipGen; // only the NEWEST flip may lift the suppression
    roots.app.setAttribute("data-notransition", "true");
    applyTheme();
    dis.raf(() => {
      dis.raf(() => {
        if (gen === themeFlipGen) roots.app.removeAttribute("data-notransition");
      });
    });
    if (changed) cfg.theme.onModeChange?.(t); // two-way sync with a host's own toggle
  }

  // details / picks
  function toggleDetails(force?: boolean): void {
    state.detailsOpen = force ?? !state.detailsOpen;
    roots.infoBtn.classList.toggle("on", state.detailsOpen);
    roots.infoBtn.setAttribute("aria-pressed", state.detailsOpen ? "true" : "false");
    renderDetails(ctx);
  }
  function focusFile(key: string): void {
    state.focusKey = key;
    state.detailSource = "focus"; // clicking a row makes THAT file the Details subject, even with picks
    updateRowStates(ctx); // in-place class/aria patch - no full row rebuild on click
    if (state.detailsOpen) renderDetails(ctx);
  }
  function togglePick(key: string): void {
    if (state.pickedKeys.has(key)) {
      state.pickedKeys.delete(key);
    } else {
      // Selection is UNLIMITED - pick as many as you like. Only the heavy Aggregate action is
      // capped (it locks in the pickbar past MAX_FILE_SELECTION); downloads and Details are not.
      state.pickedKeys.add(key);
    }
    state.detailSource = "picks"; // (de)selecting makes the current picks the Details subject
    updateRowStates(ctx);
    renderPickbar(ctx);
    if (state.detailsOpen) renderDetails(ctx);
  }
  function clearPicks(): void {
    state.pickedKeys.clear();
    state.detailSource = "focus"; // no picks left - fall back to the focused row
    updateRowStates(ctx);
    renderPickbar(ctx);
    if (state.detailsOpen) renderDetails(ctx);
  }

  // terminal draft (user typed in the CLI)
  /**
   * Commit a draft from the terminal (already stripped of the in-progress token by the
   * caller). Routes through filterCommittable, the SAME guard the search bar uses:
   * unknown keys and closed-value-set failures never reach state.selected or the backend.
   * Returns the number of rejected tokens so the terminal can keep a dirty draft visible.
   * A draft that produces the identical selection is a no-op: no re-render, no search -
   * this is what stops every keystroke from firing redundant work.
   */
  function applyTerminalDraft(text: string): number {
    state.terminalDraft = text;
    // time/bbox (+ their *_select modes) are REAL tokens, not facets: they're pulled out first and
    // routed to state.time/state.bbox, so `bbox=10,1,1,1` can't fall through to the facet path and
    // commit a fake chip plus a meaningless query param. Removing the token clears them.
    const control = parseControlTokens(parseFacetTokens(text));
    const { accepted, rejected } = filterCommittable(state, control.rest);
    const timeChanged = !timeEqual(state.time, control.time);
    const bboxChanged = !bboxEqual(state.bbox, control.bbox);
    if (selectionsEqual(state.selected, accepted) && !timeChanged && !bboxChanged) {
      return rejected.length + control.errors.length;
    }
    state.selected = accepted;
    if (timeChanged) state.time = control.time;
    if (bboxChanged) state.bbox = roundBbox(control.bbox);
    // The terminal already shows what the user typed - re-render everything *except* its input.
    renderChipsIf();
    renderSidebarIf();
    renderOverviewIf();
    syncOverviewSelection(ctx); // selSig is not in the overview signature, so patch the highlight here too
    commitSearch();
    return rejected.length + control.errors.length;
  }
  /** Control errors are surfaced by the terminal; expose them for its warning line. */
  function terminalDraftErrors(text: string): string[] {
    return parseControlTokens(parseFacetTokens(text)).errors;
  }

  // editors / popovers
  function openTimeEditorFn(anchor: HTMLElement): void {
    openTimeEditor(ctx, anchor);
  }
  function openBboxEditorFn(anchor: HTMLElement): void {
    openBboxEditor(ctx, anchor);
  }
  function closeAllPopovers(): void {
    popover.close();
  }

  // Per-region listener buckets: each re-render flushes its previous bucket before attaching
  // listeners to freshly-created nodes, so detached-node listeners never accumulate.
  // A region re-render also detaches the DOM an open popover may be anchored to (e.g. a
  // row's kebab menu when a debounced search settles). The flush kills the menu's listeners,
  // so a visible-but-dead popover would remain - schedule a microtask (after the synchronous
  // rebuild completes) that closes the popover if its anchor is no longer connected.
  const regionBuckets = new Map<string, Disposables>();
  let destroyed = false;
  function region(name: string): Disposables {
    regionBuckets.get(name)?.flush();
    const bucket = dis.child();
    regionBuckets.set(name, bucket);
    queueMicrotask(() => {
      if (!destroyed) popover.closeIfAnchorDetached();
    });
    return bucket;
  }

  const ctx: AppContext = {
    state,
    api,
    dis,
    region,
    cfg,
    roots,
    popover,
    commitSearch,
    loadNextPage,
    retrySearch,
    syncAll,
    renderSidebar: renderSidebarIf,
    renderChips: renderChipsIf,
    renderResults: renderResultsIf,
    renderOverview: renderOverviewIf,
    renderCommand,
    renderDetails: () => renderDetails(ctx),
    recountOverview,
    exportCatalogue: (kind, query, uniqKey) => doExport(kind, query, uniqKey),
    toggleFacet,
    clearAllFacets,
    clearFacet,
    setTime,
    setBbox,
    setFlavour,
    setLayout,
    setView,
    setTheme,
    toggleDetails,
    focusFile,
    togglePick,
    clearPicks,
    applyTerminalDraft,
    terminalDraftErrors,
    openTimeEditor: openTimeEditorFn,
    openBboxEditor: openBboxEditorFn,
    closeAllPopovers,
    setStatus,
    log: (severity, message) => console_?.log(severity, message),
    toast: (severity, message) => console_?.toast(severity, message),
    openInspect: (file) => inspector.open(file),
    openHelp: () => toggleHelp(true),
  };

  function toggleHelp(show?: boolean): void {
    refs.helpPanel.classList.toggle("show", show ?? !refs.helpPanel.classList.contains("show"));
  }
  dis.listen(refs.helpPanel.querySelector(".help-x") as HTMLElement, "click", () =>
    toggleHelp(false),
  );
  dis.listen(document, "keydown", (e) => {
    const ke = e as KeyboardEvent;
    // If a popover already handled this Escape (it calls preventDefault), Help stays open. Checking
    // defaultPrevented instead of silencing the event keeps the host app's own Escape listeners alive.
    if (ke.key === "Escape" && !ke.defaultPrevented && !popover.isOpen()) toggleHelp(false);
  });

  // footer console + toasts own the status bar text, severity dot, ring-buffered log, and toasts
  console_ = createConsole(ctx);
  installTooltips(roots.app, dis); // immediate, styled tooltips in place of the native `title` popup
  const inspector = createInspector(ctx);

  // terminal + notes need the assembled ctx
  if (cfg.features.terminal) terminal = createTerminal(ctx);
  if (cfg.devNotes) notes = createNotes(ctx);

  // top-bar wiring
  dis.listen(refs.themeBtn, "click", () => setTheme(state.theme === "night" ? "day" : "night"));
  dis.listen(refs.sideCollapse, "click", () => toggleSidebarCollapsed());
  dis.listen(refs.listSeg, "click", () => setView("list"));
  dis.listen(refs.gridSeg, "click", () => setView("grid"));
  dis.listen(refs.shelveBtn, "click", () => {
    toggleStack(ctx);
    syncShelve();
  });
  function syncShelve(): void {
    const on = state.overviewStacked;
    const lbl = refs.shelveBtn.querySelector(".tbtn-lbl");
    if (lbl) lbl.textContent = on ? "Unstack" : "Stack";
    refs.shelveBtn.setAttribute("aria-pressed", on ? "true" : "false");
    // the explicit aria-label overrides the visible text, so it must track the action too.
    refs.shelveBtn.setAttribute(
      "aria-label",
      on ? "Unstack - restore the block layout" : "Stack all blocks into full-width rows",
    );
    refs.shelveBtn.classList.toggle("on", on);
  }
  syncShelve();
  dis.listen(refs.selectAllBtn, "click", () => {
    const keys = state.rows.map((r) => r.key);
    const all = keys.length > 0 && keys.every((k) => state.pickedKeys.has(k));
    if (all) for (const k of keys) state.pickedKeys.delete(k);
    else for (const k of keys) state.pickedKeys.add(k);
    state.detailSource = "picks";
    updateRowStates(ctx); // also re-syncs the Select-all control
    renderPickbar(ctx);
    if (state.detailsOpen) renderDetails(ctx);
  });
  dis.listen(refs.resultsCtrl, "click", () => setLayout("results"));
  dis.listen(refs.overviewCtrl, "click", () => setLayout("overview"));
  dis.listen(roots.infoBtn, "click", () => toggleDetails());
  dis.listen(refs.cmdBtn, "click", () => terminal?.toggle());
  dis.listen(refs.inspectBtn, "click", () => {
    void inspector.openEmpty();
  });
  dis.listen(roots.clearAllBtn, "click", () => clearAllFacets());

  const infoClose = (roots as Roots & { infoClose?: HTMLButtonElement }).infoClose;
  if (infoClose) dis.listen(infoClose, "click", () => toggleDetails(false));

  if (refs.notesBtn && notes) {
    const nb = refs.notesBtn;
    const nc = notes;
    dis.listen(nb, "click", () => {
      nc.toggle();
      nb.classList.toggle("on", nc.isShown());
    });
  }

  // Value-first main search bar: the user types a VALUE and
  // picks a facet=value match from the dropdown. The key=value power syntax lives in the terminal.
  if (cfg.features.search) createValueSearch(ctx, refs.searchInput);

  // lens dropdown
  dis.listen(refs.lensBtn, "click", () => {
    if (popover.isOpen()) {
      popover.close();
      return;
    }
    const pop = region("popover"); // per-open bucket; flushed when the next popover opens
    const items: HTMLElement[] = [];
    for (const f of state.flavours) {
      if (f === "user" && !cfg.authEnabled) continue;
      const active = f === state.flavour;
      const item = el("button", { class: `pop-item${active ? " check on" : ""}`, type: "button" }, [
        el("span", { class: "desc", text: f }),
        active ? el("span", { class: "tick" }, [svgIcon(ICONS.check, { size: 13 })]) : null,
      ]);
      pop.listen(item, "click", () => {
        popover.close();
        setFlavour(f);
      });
      items.push(item);
    }
    // The dropdown lists only the selectable flavours: flavour CRUD needs auth that isn't wired,
    // so a "Manage naming flavours…" entry would lead to a dead "UI pending" message.
    refs.lensBtn.setAttribute("aria-expanded", "true");
    popover.open(refs.lensBtn, items, {
      placement: "below",
      className: "lens-pop",
      autoFocus: true, // move keyboard focus into the menu
      onClose: () => refs.lensBtn.setAttribute("aria-expanded", "false"),
    });
  });

  // export dropdown (whole-query catalogue) - handles the exact 413 + the 100k ceiling
  dis.listen(roots.exportBtn, "click", () => {
    if (exportDisabled()) {
      setStatus(
        `This query returns more than ${STREAM_CATALOGUE_MAXIMUM.toLocaleString("en-US")} files - narrow it before exporting a catalogue.`,
      );
      return;
    }
    if (popover.isOpen()) {
      popover.close();
      return;
    }
    const pop = region("popover"); // per-open bucket; flushed when the next popover opens
    const mk = (
      kind: "intake" | "stac" | "uris",
      icon: Node,
      label: string,
      desc: string,
    ): HTMLButtonElement => {
      const b = el("button", { class: "pop-item pic", type: "button" }, [
        icon,
        el("span", {}, [
          el("span", { class: "desc", text: label }),
          el("span", { class: "sub", text: desc }),
        ]),
      ]);
      pop.listen(b, "click", () => {
        popover.close();
        void doExport(kind);
      });
      return b;
    };
    popover.open(
      roots.exportBtn,
      [
        mk(
          "intake",
          brandIcon("intake", { size: 16 }),
          "Intake catalogue",
          "intake-esm JSON for the whole result set",
        ),
        mk(
          "stac",
          brandIcon("stac", { size: 16 }),
          "STAC catalogue",
          "STAC zip for the whole result set",
        ),
        mk(
          "uris",
          svgIcon(ICONS.uris, { size: 16 }),
          "URI manifest",
          "Plain-text list of file URIs for the whole result set",
        ),
      ],
      { placement: "below", className: "export-pop" },
    );
  });

  /** Concurrent downloads in flight - the Export button shows a busy state while any is running. */
  let exportsInFlight = 0;
  function exportBusy(delta: number): void {
    exportsInFlight = Math.max(0, exportsInFlight + delta);
    roots.exportBtn.classList.toggle("busy", exportsInFlight > 0); // busy while ANY download runs
  }

  /**
   * Catalogue download: hand the URL to the BROWSER and let it stream the
   * response straight to disk. No byte bookkeeping, no buffering, and downloads run CONCURRENTLY:
   * reading the body chunk-by-chunk to report "12 MB of 30 MB" would buffer the whole catalogue in
   * memory before it hits disk and put exports on one shared abort channel, where starting a second
   * download cancels the first.
   *
   * A bearer token can't ride on a plain <a download>, so when one is configured we still fetch
   * (with our own per-download AbortController - never a shared one) and save the blob. The
   * download <a> lives HERE, not in the Api layer. `query`/`uniqKey` overrides let per-file exports
   * (results kebab / details panel) share this one code path.
   */
  async function doExport(
    kind: "intake" | "stac" | "uris",
    query?: string,
    uniqKey?: "file" | "uri",
  ): Promise<void> {
    const meta = {
      intake: { label: "Intake catalogue", filename: "freva-intake.json" },
      stac: { label: "STAC catalogue", filename: "freva-stac.zip" },
      uris: { label: "URI manifest", filename: "freva-uris.txt" },
    }[kind];
    const { label, filename } = meta;
    const key = uniqKey ?? state.uniqKey;
    const q = query ?? facetQueryString(state);
    // The URI manifest comes from data-search (plain text); intake/stac from the catalogue endpoints.
    const url =
      kind === "uris"
        ? api.dataSearchUrl(state.flavour, key, q)
        : api.catalogueUrl(kind, state.flavour, key, q);
    clearStatusHold(); // an explicit export supersedes a lingering search-bar warning

    const save = (href: string): void => {
      const a = document.createElement("a");
      a.href = href;
      a.download = filename;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
    };

    // No auth header needed -> the browser streams it itself (same-origin cookies still ride along).
    // But a direct <a download> can't see the response, so a 413/5xx would be saved AS the file. Do a
    // cheap HEAD preflight first; if the probe is unsupported (405) or itself fails (offline/CORS), we
    // don't block - the browser's own download + error UI takes over. (Assumes HEAD is cheap on the
    // catalogue endpoint; if a backend recomputes the catalogue for HEAD, this doubles that cost.)
    if (!cfg.getAuthToken()) {
      const ctrl = new AbortController();
      const off = dis.add(() => ctrl.abort()); // destroy() aborts the probe so nothing fires afterward
      try {
        const probe = await fetch(url, { method: "HEAD", signal: ctrl.signal });
        if (destroyed) return;
        if (!probe.ok && probe.status !== 405) {
          const msg =
            probe.status === 413
              ? `This query is too large for the server to export - narrow it and try again.`
              : `${label} couldn't be prepared (server responded ${probe.status}).`;
          setStatus(msg);
          ctx.toast("error", msg);
          return;
        }
      } catch {
        if (destroyed || ctrl.signal.aborted) return; // torn down mid-probe - do NOT start a download
        /* genuine probe failure - fall through to the native download */
      } finally {
        off();
      }
      if (destroyed) return; // defence in depth: never trigger a download after teardown
      save(url);
      setStatus(`${label} download started.`);
      ctx.toast("success", `${label} download started.`);
      return;
    }

    // Bearer token -> we must set a header, so fetch it ourselves. Own controller: a second export
    // can run alongside this one, and destroy() still cancels both.
    const ctrl = new AbortController();
    const off = dis.add(() => ctrl.abort());
    exportBusy(+1);
    setStatus(`Preparing ${label}…`);
    try {
      const res =
        kind === "uris"
          ? await api.manifestResponse(state.flavour, key, q, ctrl.signal)
          : await api.catalogueResponse(kind, state.flavour, key, q, ctrl.signal);
      const blob = await res.blob(); // no chunk loop, no size bookkeeping
      const objectUrl = URL.createObjectURL(blob);
      save(objectUrl);
      dis.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
      if (!destroyed) ctx.toast("success", `${label} downloaded.`);
    } catch (e) {
      if (e instanceof ApiError && e.aborted) return;
      if (e instanceof DOMException && e.name === "AbortError") return;
      if (e instanceof ApiError && (e.status === 413 || e.detail === STREAM_TOO_BIG_DETAIL)) {
        updateExportState();
        ctx.toast(
          "warn",
          "The result stream is too big to export - narrow the query and try again.",
        );
        return;
      }
      ctx.toast("error", e instanceof ApiError ? e.message : "Catalogue export failed.");
    } finally {
      off();
      exportBusy(-1);
      // NB: don't clear the status here - the success/error toast above owns it (clearing would
      // wipe the very 413/error message we just surfaced).
    }
  }

  // initial paint + bootstrap
  applyTheme();
  applyLayout();
  applyView();
  applySidebarCollapsed();
  renderSidebarIf();
  renderChipsIf();
  renderResultsIf();
  renderPickbar(ctx);
  renderDetails(ctx);
  renderCommand();
  updateResCount();
  updateExportState();

  target.appendChild(refs.outer);

  // Bootstrap: the shell + skeletons above paint synchronously; the first search does NOT wait
  // for /overview (they are independent requests - serialising them would add a full round-trip
  // to first results on slow links). Overview merges in when it lands and only refreshes the bits
  // it informs (flavour list, attribute keys -> terminal key hints).
  // Nothing is fetched twice: one /overview, one extended-search.
  // Bootstrap fail-closed rule: a CUSTOM current flavour (no builtin map) combined with
  // baseFilters would send the gate under the WRONG key until GET /flavours lands. So for that case we
  // HOLD the first search behind the loading veil and start it only once the map is known - and fail
  // VISIBLY if the map never arrives, rather than querying the whole archive with a mis-keyed gate.
  const scopedCustomFlavour =
    Object.keys(state.baseFilters).length > 0 &&
    !BUILTIN_FLAVOURS.includes(state.flavour as FlavourName);
  let initialSearchStarted = false;
  const startInitialSearch = (): void => {
    if (initialSearchStarted || destroyed) return;
    initialSearchStarted = true;
    void runSearch(false);
  };
  const failScopedBootstrap = (): void => {
    if (initialSearchStarted || destroyed) return;
    initialSearchStarted = true; // don't also fire a (mis-keyed) search later
    failScope();
  };
  if (scopedCustomFlavour) {
    state.search = "loading";
    renderResultsIf();
  } else {
    startInitialSearch();
  }
  // metadata.js (config + deployment script): config descriptions are already applied
  // synchronously above; the deployment script, if enabled, merges under them and re-renders
  // the facet regions so hover descriptions appear. Degrades silently when absent.
  void (async (): Promise<void> => {
    try {
      const merged = await resolveMetadata(cfg, dis, roots.app);
      if (destroyed) return;
      state.metadata = merged;
      state.metadataVersion++;
      renderSidebarIf();
      renderOverviewIf();
    } catch {
      /* metadata is optional context; the browser works without any descriptions */
    }
  })();
  let overviewAttrs: Record<string, string[]> | string[] | null = null;
  /** Facet keys for the CURRENT flavour (the map is flavour-keyed); falls back to the union. */
  function applyAttributeKeys(): void {
    const a = overviewAttrs;
    if (!a) return;
    if (Array.isArray(a)) {
      state.attributeKeys = a;
      return;
    }
    const forFlavour = a[state.flavour];
    state.attributeKeys = Array.isArray(forFlavour)
      ? forFlavour
      : [...new Set(Object.values(a).flat())]; // unknown flavour -> union of every flavour's keys
  }

  void (async (): Promise<void> => {
    try {
      const ov = await api.overview();
      if (destroyed) return; // settled after teardown - don't touch the detached tree
      const flavs = Array.isArray(ov.flavours) ? ov.flavours : [];
      const merged = [...BUILTIN_FLAVOURS];
      for (const f of flavs) if (!merged.includes(f)) merged.push(f);
      state.flavours = merged;
      // A custom flavour named in the URL was rejected at mount (only builtins were known then). Now
      // that /overview has listed it, apply it: the deep-linked facet keys are already in that
      // flavour's naming, so no re-key - just switch, sync the URL, and re-query.
      if (
        pendingUrlFlavour &&
        state.flavours.includes(pendingUrlFlavour) &&
        pendingUrlFlavour !== state.flavour
      ) {
        state.flavour = pendingUrlFlavour as FlavourName;
        pendingUrlFlavour = null;
        applyAttributeKeys();
        roots.lensValue.textContent = state.flavour;
        syncAll(); // relabel the lens + facets/command; NO re-key (URL keys are already in this flavour)
        syncUrlFromState();
        commitSearch();
      }
      // /overview returns attributes KEYED BY FLAVOUR ({freva: [...facet keys], cmip6: [...]}), so
      // the values are the facet keys - taking Object.keys() here would leak the FLAVOUR NAMES
      // into the facet-key autocomplete.
      overviewAttrs = ov.attributes ?? null;
      applyAttributeKeys();
      reconcileUrlImports(); // attributeKeys now known -> drop any non-facet URL params before/independent of the first search
      renderCommand(); // key hints in the terminal may have widened
    } catch {
      /* overview is optional context; search still works anonymously */
      overviewFailed = true;
      reconcileUrlImports(true); // /overview failed - if the search also failed, release stuck host params
    }
  })();

  // The per-flavour freva↔flavour translation table (GET /flavours). Only globally-visible flavours
  // come back for an anonymous caller, which is exactly the no-auth scope we support. Needed to
  // re-key the active selection when the lens changes.
  void (async (): Promise<void> => {
    try {
      const res = await api.listFlavours();
      if (destroyed) return;
      const list = Array.isArray(res.flavours) ? res.flavours : [];
      const before = JSON.stringify(state.flavourMaps[state.flavour]?.forward ?? null);
      const beforeQ = facetQueryString(state); // the wire query as it stands under the current map
      state.flavourMaps = { ...state.flavourMaps, ...buildFlavourMaps(list) }; // server overrides builtins
      const after = JSON.stringify(state.flavourMaps[state.flavour]?.forward ?? null);
      const afterQ = facetQueryString(state);
      flavoursSettled = true; // the map set is now final - commitSearch can stop holding
      // A scoped custom flavour held its first search until now: start it only if this flavour is
      // actually mapped (so the gate is keyed correctly); otherwise fail closed - never query unscoped.
      if (scopedCustomFlavour && !initialSearchStarted) {
        if (state.flavourMaps[state.flavour]) {
          renderCommand();
          startInitialSearch();
        } else failScopedBootstrap();
        return;
      }
      // A URL-driven or interactive switch INTO a custom flavour reaches commitSearch before the map
      // exists, so it is held (never fired mis-keyed). Now that the map set is final, run it once -
      // commitSearch re-checks canScopedSearch(): it searches with the correct key if the map arrived,
      // or fails closed if this flavour has no map. This covers the transition race, not just boot.
      if (heldScopedSearch) {
        heldScopedSearch = false;
        renderSidebarIf();
        renderChipsIf();
        renderOverviewIf();
        renderCommand();
        commitSearch();
        return;
      }
      if (before !== after) {
        // The current flavour's mapping just changed (a custom flavour's table arrived, or the server
        // overrode a builtin). Re-render so displayed labels use the corrected mapping.
        //
        // KNOWN LIMITATION (rare): if a user *interactively* switches INTO an as-yet-unmapped custom
        // flavour while holding selections, those selections are identity-translated at switch time and
        // are NOT re-keyed here (we can't tell their current naming without knowing which map applied
        // then). The SCOPE is unaffected - baseFilters re-translate from freva-canonical on every wire
        // call, so the gate is always keyed correctly - only a user's own facet selections may be
        // mis-keyed until they reselect. Custom flavours are almost always set at mount (handled by the
        // fail-closed hold above), so this interactive path is left alone rather than risking a
        // double-translate on the common builtin-refine path.
        renderSidebarIf();
        renderChipsIf();
        renderOverviewIf();
        renderCommand();
        // …but only re-QUERY when the wire keys actually change. A builtin flavour whose server map
        // merely stringifies differently from the baked identity (different key order/set, same
        // translation) must NOT fire a second search that immediately cancels the first - that wasted
        // round-trip is pure latency on the common path.
        if (beforeQ !== afterQ) commitSearch();
      }
    } catch {
      // flavour maps are optional for a builtin flavour; the lens still switches, selection just won't
      // re-key. But a scoped custom flavour that held its search cannot be keyed correctly without the
      // map - fail closed rather than fire a mis-scoped query.
      flavoursSettled = true;
      if (scopedCustomFlavour && !initialSearchStarted) failScopedBootstrap();
      else if (heldScopedSearch) {
        heldScopedSearch = false;
        failScope();
      }
    }
  })();

  return {
    destroy(): void {
      destroyed = true;
      popover.close();
      dis.flush();
      refs.outer.remove();
    },
    getState(): Readonly<AppState> {
      // A decoupled snapshot: `Readonly<>` is shallow, so returning the live object would let
      // callers do `getState().pickedKeys.add(…)` straight into internal state. This is a read/
      // diagnostic API, so the clone cost is fine.
      return structuredClone(state) as AppState;
    },
    setTheme(mode: "day" | "night"): void {
      if (!destroyed) setTheme(mode); // a host drives light/dark from its own control
    },
  };
}

export type { DataBrowserConfig, DataBrowserHandle } from "./types.js";
export default mountDataBrowser;
