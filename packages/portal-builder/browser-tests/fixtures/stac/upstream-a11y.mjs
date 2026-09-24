// What the pinned STAC Browser costs us in accessibility, written down.
//
// The mount is scanned rather than excluded, and held to this list. An exclusion hides the cost
// instead of recording it, and a scan that runs before the application has mounted excludes
// nothing anyway. Each entry is a serious or critical finding of upstream's own, at the pinned
// commit, that the portal cannot fix from outside the application. A finding that is NOT here
// fails the suite - that is the point of the list. A finding that stops appearing on the root view
// fails it too, so an upgrade that fixes something forces the list to shrink rather than quietly
// keeping a stale excuse.
//
// Nothing here is a reason to relax the standard for the portal's own markup: the same check
// requires zero serious or critical findings OUTSIDE the mount, including the portal-owned
// introduction region that sits directly above it.

/**
 * The root catalogue view. No map is drawn here, so this set is deterministic and is compared
 * exactly.
 */
export const ROOT_VIEW = {
  "aria-valid-attr-value": {
    element: ".multiselect__input",
    why: "The keyword filter (vue-multiselect) points `aria-owns` at a listbox id that only exists while the menu is open.",
    fixableFromOutside: false,
  },
};

/**
 * A collection or item view, which additionally draws an OpenLayers map. Compared as an upper
 * bound rather than exactly: whether the map has painted its controls by the time the scan runs is
 * a timing question, and a check that fails when the map is slow measures the machine.
 */
export const CHILD_VIEW = {
  ...ROOT_VIEW,
  "button-name": {
    element: "the map's attribution toggle",
    why: "OpenLayers renders the attribution control as a button whose label is a CSS-drawn glyph, with no accessible name.",
    fixableFromOutside: false,
  },
  "target-size": {
    element: ".ol-zoom-in, .ol-zoom-out",
    why: "OpenLayers' zoom controls are 22px; WCAG 2.2 asks for 24px.",
    fixableFromOutside: false,
  },
};
