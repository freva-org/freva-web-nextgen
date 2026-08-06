// components/notes.ts - an opt-in developer drawer. It is only created when
// config.devNotes is true, so its strings are never built or attached in production. The
// content is a short, static index of the decisions a developer most often needs to recall
// (the two carve-outs and the contract gotchas). All text is literal - no API data here.

import type { AppContext } from "../context.js";
import { el, replaceChildren, svgIcon } from "../dom.js";
import { ICONS } from "../icons.js";

export interface NotesController {
  toggle(): void;
  isShown(): boolean;
}

interface Note {
  title: string;
  body: string;
}

const NOTES: Note[] = [
  {
    title: "load/{flavour} is a GET",
    body: "The data-load endpoint is a GET that returns 201 and streams zarr URLs; it is auth.required. It is never issued as a POST.",
  },
  {
    title: "Time is unbracketed",
    body: "Time queries are sent as time=<from> TO <to> with a separate time_select=<mode>. The prototype’s [ … TO … ] bracket form is not used anywhere.",
  },
  {
    title: "Catalogue export guard",
    body: 'Intake/STAC export requests max-results=100000; the server answers 413 with the exact detail "Result stream too big." Export is disabled client-side past that ceiling.',
  },
  {
    title: "Browsing fetches no per-file metadata",
    body: "Result rows are the thin {file|uri, fs_type} only. Full per-file facets are fetched lazily - one ?file= call per inspected file - and rendered in the Details panel.",
  },
  {
    title: "V4 - strict/file bbox+time deferred",
    body: "Only flexible (Intersects) ships enabled. strict/file modes for both the time and bbox editors are gated behind config.enableStrictBBoxModes until verified against the backend.",
  },
  {
    title: "V10 - per-file extent deferred",
    body: "Per-file bbox renders whenever the ?file= response carries a bbox (the backend must include bbox in the file field list). Time range is derived from the filename, else shown as not available. Coordinates are never fabricated.",
  },
  {
    title: "Embedding - transformed ancestors break fixed overlays",
    body: "Popovers/menus/tooltips position as fixed relative to the viewport. If any ANCESTOR of the mount establishes a containing block for fixed elements, they anchor to that ancestor instead and appear offset. Triggers: transform, filter, backdrop-filter, perspective, contain: paint/layout/strict, or will-change of any of those. Mount outside such wrappers, or drop the property on the ancestor.",
  },
  {
    title: "Leaflet is a page-global install (survives destroy)",
    body: "The Leaflet stylesheet (and window.L) are installed once per PAGE, tied to no component - because tying the stylesheet to a component lifecycle caused maps in other components to lose their layout when that component re-rendered. Consequently they persist after destroy(): the stylesheet stays in <head> and window.L stays defined. destroy() fully tears down THIS widget (DOM, observers, in-flight requests); it does not, by design, uninstall this shared page-global. The script tag itself is removed once it registers window.L.",
  },
];

export function createNotes(ctx: AppContext): NotesController {
  const list = el("div", { class: "notes-list" });
  for (const n of NOTES) {
    list.append(
      el("div", { class: "nl" }, [
        el("div", { class: "h", text: n.title }),
        el("p", { text: n.body }),
      ]),
    );
  }

  const closeBtn = el(
    "button",
    { class: "x", type: "button", "aria-label": "Close developer notes" },
    [svgIcon(ICONS.x, { size: 16 })],
  );
  const drawer = el(
    "div",
    { class: "notes-drawer", role: "complementary", "aria-label": "Developer notes" },
    [
      el("h4", {}, [
        svgIcon(ICONS.notes, { size: 16 }),
        el("span", { text: "Developer notes" }),
        closeBtn,
      ]),
      list,
    ],
  );

  ctx.roots.app.append(drawer);
  ctx.dis.add(() => drawer.remove());

  const setShown = (on: boolean): void => {
    drawer.classList.toggle("show", on);
  };
  ctx.dis.listen(closeBtn, "click", () => setShown(false));

  // tidy the static markup so a stray text node never lingers between renders
  replaceChildren(list, ...Array.from(list.childNodes));

  return {
    toggle(): void {
      setShown(!drawer.classList.contains("show"));
    },
    isShown(): boolean {
      return drawer.classList.contains("show");
    },
  };
}
