// components/pickbar.ts - the PINNED selection bar. Shown only
// when files are picked; docked at the bottom so it is always visible without scrolling.
//
// Selection is UNLIMITED. Five actions, scoped to the picks via file=:
//   • Details      - open the comparison panel over the selection (any size)
//   • Download ▾   - Intake / STAC catalogue + URI manifest, streamed for the picks
//   • Aggregate    - the one HEAVY op (auth-gated); it LOCKS past MAX_FILE_SELECTION rather
//                    than blocking the selection itself.
// The three downloads collapse into one menu (same trio as the whole-query Export) so five actions
// never crowd the bar.

import type { AppContext } from "../context.js";
import { el, replaceChildren, svgIcon } from "../dom.js";
import { brandIcon } from "../brand.js";
import { ICONS } from "../icons.js";
import { MAX_FILE_SELECTION } from "../types.js";

/** A catalogue/manifest download scoped to the picked files via file= (streaming export). */
function runDownload(ctx: AppContext, kind: "intake" | "stac" | "uris"): void {
  const files = [...ctx.state.pickedKeys];
  if (files.length === 0) return;
  const query = files.map((f) => `file=${encodeURIComponent(f)}`).join("&");
  void ctx.exportCatalogue(kind, query, "file");
}

function downloadMenu(ctx: AppContext, anchor: HTMLElement): void {
  const pop = ctx.region("popover"); // per-open bucket, flushed when the next popover opens
  const item = (
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
      ctx.popover.close();
      runDownload(ctx, kind);
    });
    return b;
  };
  ctx.popover.open(
    anchor,
    [
      item(
        "intake",
        brandIcon("intake", { size: 16 }),
        "Intake catalogue (.json)",
        "intake-esm for your selection",
      ),
      item(
        "stac",
        brandIcon("stac", { size: 16 }),
        "STAC catalogue (.zip)",
        "STAC items for your selection",
      ),
      item(
        "uris",
        svgIcon(ICONS.uris, { size: 16 }),
        "URI manifest (.txt)",
        "plain-text list of the file URIs",
      ),
    ],
    { placement: "below", className: "export-pop" }, // 'below' auto-flips ABOVE the bottom-pinned bar
  );
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

  // Unlimited count - no "/ max"; the number just climbs.
  const count = el("span", { class: "cnt" }, [
    el("b", { text: String(n) }),
    el("span", { text: n === 1 ? " file selected" : " files selected" }),
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
    { class: "btn", type: "button", title: "Download for your selection" },
    [
      svgIcon(ICONS.download, { size: 14 }),
      el("span", { text: "Download" }),
      svgIcon(ICONS.chevronDown, { size: 12 }),
    ],
  );
  reg.listen(download, "click", () => downloadMenu(ctx, download));

  // Aggregate - the heavy op. Auth-gated AND capped: past MAX_FILE_SELECTION it locks (the selection
  // does not). Everything else above stays available.
  const authOk = ctx.cfg.authEnabled && ctx.cfg.enableHeavyOps;
  const overCap = n > MAX_FILE_SELECTION;
  const disabled = !authOk || overCap;
  const why = overCap
    ? `Aggregation handles up to ${MAX_FILE_SELECTION} files - deselect ${n - MAX_FILE_SELECTION} to enable it`
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
        text: `Aggregate: max ${MAX_FILE_SELECTION} files`,
      }),
    );
  } else if (!authOk) {
    const note = !ctx.cfg.authEnabled
      ? "Aggregate needs sign-in"
      : "Aggregate needs the data-portal";
    host.append(el("span", { class: "scope-note", style: "margin:0 0 0 4px", text: note }));
  }
}
