// components/pickbar.ts - the PINNED selection bar. Shown only
// when files are picked; docked at the bottom so it is always visible without scrolling.
//
// Selection is CAPPED at MAX_SELECTED_FILES (25). Actions, scoped to the picks via file=:
//   • Details      - open the comparison panel over the selection (any size)
//   • Download ▾   - Intake / STAC catalogue + URI manifest, streamed for the picks
//   • Aggregate    - the one HEAVY op (auth-gated); it LOCKS past MAX_AGGREGATE_FILES (10), which
//                    is deliberately LOWER than the selection cap: you may select 25 files to
//                    compare them, but only 10 can be aggregated into one dataset.
// The three downloads collapse into one menu (same trio as the whole-query Export) so five actions
// never crowd the bar.

import type { AppContext } from "../context.js";
import { el, replaceChildren, svgIcon, type Disposables } from "../dom.js";
import { ICONS } from "../icons.js";
import { MAX_AGGREGATE_FILES, MAX_SELECTED_FILES, type FileRow } from "../types.js";
import { downloadFilename, partitionDownloadable } from "../downloads.js";
import { exportMenu, exportMenuItem, selectionHeading } from "./exportMenu.js";

/** A catalogue/manifest download scoped to the picked files via file= (streaming export). */
function runDownload(ctx: AppContext, kind: "intake" | "stac" | "uris"): void {
  const files = [...ctx.state.pickedKeys];
  if (files.length === 0) return;
  const query = files.map((f) => `file=${encodeURIComponent(f)}`).join("&");
  void ctx.exportCatalogue(kind, query, "file");
}

function downloadMenu(ctx: AppContext, anchor: HTMLElement): void {
  const pop = ctx.region("popover"); // per-open bucket, flushed when the next popover opens
  // The SAME renderer the whole-result Export uses - only the scope heading and the extra
  // remote-files row differ. Two implementations of one menu drift apart.
  const remote = remoteFilesItem(ctx, pop);
  anchor.setAttribute("aria-expanded", "true");
  ctx.popover.open(
    anchor,
    exportMenu(pop, {
      heading: selectionHeading(ctx.state.pickedKeys.size),
      onPick: (kind) => {
        ctx.popover.close();
        runDownload(ctx, kind);
      },
      ...(remote ? { extra: [remote] } : {}),
    }),
    // 'below' auto-flips ABOVE the bottom-pinned bar
    {
      placement: "below",
      className: "export-pop",
      autoFocus: true,
      // Every close route funnels through `PopoverManager.close()`, so one callback covers
      // selection, Escape, outside click, scroll and replacement by another popover.
      onClose: () => anchor.setAttribute("aria-expanded", "false"),
    },
  );
}

/** The selected rows, in SELECTION order (not result order) - the order the user built. */
function selectedRows(ctx: AppContext): FileRow[] {
  const byKey = new Map(ctx.state.rows.map((r) => [r.key, r]));
  return [...ctx.state.pickedKeys].map((k) => byKey.get(k)).filter((r): r is FileRow => !!r);
}

/**
 * "Remote source files (N)" - a bounded, scrollable list of ONE anchor per eligible file.
 *
 * Each anchor is clicked by the USER, one file at a time. Auto-clicking them would trigger every
 * browser's multiple-download blocker after the second file, so most of the downloads would be
 * silently dropped and the user would have no way to tell which. Bundling or streaming them
 * together is likewise out: that would mean pulling gigabytes through JavaScript memory.
 */
function remoteFilesItem(ctx: AppContext, pop: Disposables): HTMLElement | null {
  const rows = selectedRows(ctx);
  const { eligible, skipped } = partitionDownloadable(rows);
  if (eligible.length === 0) return null;
  return exportMenuItem({
    icon: svgIcon(ICONS.download, { size: 16 }),
    label: `Remote source files (${eligible.length})`,
    desc: skipped
      ? `direct links - ${skipped} selected file${skipped === 1 ? "" : "s"} not remote`
      : "direct links - one download per click",
    onPick: () => {
      ctx.popover.close();
      openRemoteFileList(ctx, eligible, skipped);
    },
    reg: pop,
  });
}

function openRemoteFileList(
  ctx: AppContext,
  eligible: Array<{ row: FileRow; href: string }>,
  skipped: number,
): void {
  const reg = ctx.region("popover");
  const list = el("div", { class: "dl-list", role: "list" });
  for (const { row, href } of eligible) {
    list.append(
      el(
        "a",
        {
          class: "dl-item",
          role: "listitem",
          href,
          download: downloadFilename(href),
          target: "_blank",
          rel: "noopener noreferrer",
          title: href,
        },
        [
          svgIcon(ICONS.download, { size: 14 }),
          el("span", { class: "dl-name", text: downloadFilename(href) }),
          el("span", { class: "dl-path", text: row.file }),
        ],
      ),
    );
  }
  const nodes: HTMLElement[] = [
    el("div", {
      class: "dl-head",
      text: `${eligible.length} remote source file${eligible.length === 1 ? "" : "s"}`,
    }),
    el("div", {
      class: "dl-note",
      text: skipped
        ? `Click a file to download it. ${skipped} selected file${skipped === 1 ? " is" : "s are"} local or not a supported remote format, so ${skipped === 1 ? "it has" : "they have"} no direct link.`
        : "Click a file to download it.",
    }),
    list,
  ];
  ctx.popover.open(ctx.roots.pickbar, nodes, {
    placement: "below",
    className: "dl-pop",
    autoFocus: true,
    scrollBehavior: "close",
  });
  reg.add(() => {
    /* anchors carry no listeners; the bucket exists so the popover cleans up like every other */
  });
}

export function renderPickbar(ctx: AppContext): void {
  const reg = ctx.region("pickbar");
  const host = ctx.roots.pickbar;
  const n = ctx.state.pickedKeys.size;
  host.classList.toggle("show", n > 0);
  if (n === 0) {
    replaceChildren(host);
    return;
  }

  const clear = el(
    "button",
    { class: "x", type: "button", "aria-label": "Clear selection", title: "Clear selection" },
    [svgIcon(ICONS.x, { size: 16 })],
  );
  reg.listen(clear, "click", () => ctx.clearPicks());

  // The cap is part of the count, so the ceiling is visible BEFORE it is hit rather than only in
  // the message you get for bouncing off it.
  const count = el("span", { class: `cnt${n >= MAX_SELECTED_FILES ? " at-cap" : ""}` }, [
    el("b", { text: `${n} / ${MAX_SELECTED_FILES}` }),
    el("span", { text: " selected" }),
  ]);

  // Details - the existing comparison panel over the selection (works at any size).
  const details = el(
    "button",
    { class: "btn", type: "button", title: "Compare the selected files" },
    [svgIcon(ICONS.info, { size: 14 }), el("span", { text: "Details" })],
  );
  reg.listen(details, "click", () => {
    ctx.state.detailSource = "picks";
    ctx.toggleDetails(true);
  });

  // Download ▾ - Intake / STAC / URI manifest, scoped to the picks.
  const download = el(
    "button",
    {
      class: "btn",
      type: "button",
      title: "Download for your selection",
      "aria-haspopup": "menu",
      "aria-expanded": "false",
    },
    [
      svgIcon(ICONS.download, { size: 14 }),
      el("span", { text: "Download" }),
      svgIcon(ICONS.chevronDown, { size: 12 }),
    ],
  );
  reg.listen(download, "click", () => downloadMenu(ctx, download));

  // Aggregate - the heavy op. Auth-gated AND capped at its OWN, lower limit: past
  // MAX_AGGREGATE_FILES it locks while the selection (up to MAX_SELECTED_FILES) stays valid, so
  // everything else in the bar keeps working.
  const authOk = ctx.cfg.authEnabled && ctx.cfg.enableHeavyOps;
  const overCap = n > MAX_AGGREGATE_FILES;
  const disabled = !authOk || overCap;
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

  replaceChildren(host, clear, count, el("div", { class: "spacer" }), details, download, aggregate);

  // A one-line reason under the bar keeps the disabled Aggregate from looking broken.
  if (overCap) {
    host.append(
      el("span", {
        class: "scope-note",
        style: "margin:0 0 0 4px",
        text: `Aggregate: max ${MAX_AGGREGATE_FILES} files`,
      }),
    );
  } else if (!authOk) {
    const note = !ctx.cfg.authEnabled
      ? "Aggregate needs sign-in"
      : "Aggregate needs the data-portal";
    host.append(el("span", { class: "scope-note", style: "margin:0 0 0 4px", text: note }));
  }
}
