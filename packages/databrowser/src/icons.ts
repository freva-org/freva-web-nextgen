// icons.ts - every string here is a compile-time literal (never API data), so passing
// them to svgIcon()'s innerHTML is safe. Inline SVG is preferred for actionable controls
// because Unicode glyphs render inconsistently across OS/browser.

const stroke =
  'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';

export const ICONS = {
  search: `<circle cx="11" cy="11" r="7" ${stroke}/><path d="M21 21l-4.3-4.3" ${stroke}/>`,
  chevron: `<path d="M9 6l6 6-6 6" ${stroke}/>`,
  chevronDown: `<path d="M6 9l6 6 6-6" ${stroke}/>`,
  close: `<path d="M6 6l12 12M18 6L6 18" ${stroke}/>`,
  check: `<path d="M5 12l5 5 9-11" ${stroke}/>`,
  sun: `<circle cx="12" cy="12" r="4" ${stroke}/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19" ${stroke}/>`,
  moon: `<path d="M21 12.8A8.5 8.5 0 1111.2 3a6.5 6.5 0 009.8 9.8z" ${stroke}/>`,
  notes: `<path d="M4 5h16M4 12h16M4 19h10" ${stroke}/>`,
  info: `<circle cx="12" cy="12" r="9" ${stroke}/><path d="M12 11v5M12 8h.01" ${stroke}/>`,
  resultsFocus: `<rect x="3" y="4" width="7" height="16" rx="1.5" ${stroke}/><rect x="12" y="4" width="9" height="16" rx="1.5" ${stroke}/>`,
  overview: `<path d="M4 20h16" ${stroke}/><rect x="5" y="10.5" width="3.4" height="6.5" rx="1" ${stroke}/><rect x="10.3" y="5.5" width="3.4" height="11.5" rx="1" ${stroke}/><rect x="15.6" y="13.5" width="3.4" height="3.5" rx="1" ${stroke}/>`,
  list: `<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" ${stroke}/>`,
  grid: `<rect x="3" y="3" width="8" height="8" rx="1.5" ${stroke}/><rect x="13" y="3" width="8" height="8" rx="1.5" ${stroke}/><rect x="3" y="13" width="8" height="8" rx="1.5" ${stroke}/><rect x="13" y="13" width="8" height="8" rx="1.5" ${stroke}/>`,
  command: `<path d="M9 6a3 3 0 10-3 3h12a3 3 0 10-3-3v12a3 3 0 103-3H6a3 3 0 10-3 3" ${stroke}/>`,
  // Inspect = a microscope (the ncdump/metadata inspector). Adapted from a standard line-icon set.
  inspect: `<path d="M6 18h8" ${stroke}/><path d="M3 22h18" ${stroke}/><path d="M14 22a7 7 0 100-14h-1" ${stroke}/><path d="M9 14h2" ${stroke}/><path d="M8 6h6v4a2 2 0 01-2 2h-2a2 2 0 01-2-2z" ${stroke}/><path d="M12 6V3a1 1 0 00-1-1H9a1 1 0 00-1 1v3" ${stroke}/>`,
  download: `<path d="M12 4v11M7 11l5 5 5-5M5 20h14" ${stroke}/>`,
  caret: `<path d="M6 9l6 6 6-6" ${stroke}/>`,
  copy: `<rect x="9" y="9" width="11" height="11" rx="2" ${stroke}/><path d="M5 15V5a2 2 0 012-2h10" ${stroke}/>`,
  kebab: `<circle cx="12" cy="5" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="19" r="1.6" fill="currentColor"/>`,
  clock: `<circle cx="12" cy="12" r="9" ${stroke}/><path d="M12 7v5l3.5 2" ${stroke}/>`,
  box: `<rect x="3" y="6" width="18" height="12" rx="1.5" ${stroke}/>`,
  expandWide: `<path d="M3 12h18M7 8l-4 4 4 4M17 8l4 4-4 4" ${stroke}/>`,
  expandTall: `<path d="M12 3v18M8 7L12 3l4 4M8 17l4 4 4-4" ${stroke}/>`,
  plus: `<path d="M12 5v14M5 12h14" ${stroke}/>`,
  x: `<path d="M6 6l12 12M18 6L6 18" ${stroke}/>`,
  retry: `<path d="M21 12a9 9 0 11-3-6.7M21 4v4h-4" ${stroke}/>`,
  // URI manifest (.txt): a page carrying a bulleted list of links (a plain-text list of file URIs).
  uris: `<path d="M6 3h9l4 4v14H6z" ${stroke}/><path d="M15 3v4h4" ${stroke}/><circle cx="9.3" cy="9" r=".95" fill="currentColor"/><path d="M11 9h5" ${stroke}/><circle cx="9.3" cy="12.5" r=".95" fill="currentColor"/><path d="M11 12.5h5" ${stroke}/><circle cx="9.3" cy="16" r=".95" fill="currentColor"/><path d="M11 16h5" ${stroke}/>`,
  // Aggregate: two inputs merging into a single output - the "combine files into one dataset" op.
  aggregate: `<rect x="3" y="4.5" width="6.5" height="5" rx="1.3" ${stroke}/><rect x="3" y="14.5" width="6.5" height="5" rx="1.3" ${stroke}/><path d="M9.5 7h3.5a2 2 0 0 1 2 2v1M9.5 17h3.5a2 2 0 0 0 2-2v-1" ${stroke}/><rect x="15" y="8.5" width="6" height="7" rx="1.5" ${stroke}/>`,
  // "Shelve" the overview: collapse every block to a full-width row (three stacked full-width bars).
  shelve: `<rect x="3" y="5" width="18" height="3.4" rx="1.6" ${stroke}/><rect x="3" y="10.3" width="18" height="3.4" rx="1.6" ${stroke}/><rect x="3" y="15.6" width="18" height="3.4" rx="1.6" ${stroke}/>`,
  gear: `<circle cx="12" cy="12" r="3.2" ${stroke}/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" ${stroke}/>`,
  // "reset size": a box snapping back to its default (arrows pointing IN)
  reset: `<rect x="4" y="4" width="16" height="16" rx="2" ${stroke}/><path d="M9 9l-3-3M9 9V6M9 9H6M15 15l3 3M15 15v3M15 15h3" ${stroke}/>`,
  // "minimize": collapse to the title bar (a line, like a window's minimize)
  minimize: `<path d="M6 16h12" ${stroke}/><path d="M12 12l-3-3M12 12l3-3" ${stroke}/>`,
  // sorts: numeric (count, descending) and alphabetical - the arrow shows the DIRECTION
  sortCount: `<path d="M4 7h10M4 12h7M4 17h4" ${stroke}/><path d="M17 5v14M17 19l3-3M17 19l-3-3" ${stroke}/>`,
  sortAlpha: `<path d="M4 7h8M4 12h6M4 17h4" ${stroke}/><path d="M16 8l2-3 2 3M16.5 7h3M16 19l2-3 2 3M16.5 18h3" ${stroke}/>`,
  // Cloud-Shell-style prompt-in-a-window mark: the conventional terminal affordance (">_").
  terminal: `<rect x="2.5" y="4" width="19" height="16" rx="2.5" ${stroke}/><path d="M7 9.5l2.8 2.5L7 14.5M12.8 15h4.4" ${stroke}/>`,
  // Tab glyphs. bash = a prompt caret; python = a generic snake curve (deliberately NOT the PSF
  // logo, which is a trademark we shouldn't reproduce).
  bashTab: `<path d="M4 7l4 4-4 4M11 16h8" ${stroke}/>`,
  help: `<circle cx="12" cy="12" r="9" ${stroke}/><path d="M9.6 9.3a2.5 2.5 0 114 2.1c-.9.6-1.6 1-1.6 2.1M12 17h.01" ${stroke}/>`,
  // Monochrome python mark (single currentColor fill)
  pySnake: `<path fill="currentColor" d="M11.9 2c-1.6 0-3 .14-4 .5C6.6 3 6.2 3.9 6.2 5.2v1.9h5.9v.8H4.3c-1.4 0-2.6.8-3 2.4-.4 1.8-.4 2.9 0 4.8.3 1.4 1.1 2.4 2.5 2.4h1.6v-2.2c0-1.6 1.4-3 3-3h5.4c1.3 0 2.4-1.1 2.4-2.4V5.2c0-1.3-1.1-2.3-2.4-2.5-.8-.14-1.7-.2-2.5-.2zM9.2 4.2c.5 0 .9.4.9.9s-.4.9-.9.9-.9-.4-.9-.9.4-.9.9-.9z"/><path fill="currentColor" d="M18.2 7.1v2.2c0 1.7-1.4 3-3 3H9.8c-1.3 0-2.4 1.1-2.4 2.4v3.5c0 1.3 1.1 2.1 2.4 2.5 1.5.4 3 .5 4.8 0 1.2-.3 2.4-1 2.4-2.5v-1.4h-5.9v-.8h8.8c1.4 0 1.9-1 2.4-2.4.5-1.5.5-2.9 0-4.8-.3-1.4-1-2.4-2.4-2.4h-1.7zm-3.3 12c.5 0 .9.4.9.9s-.4.9-.9.9-.9-.4-.9-.9.4-.9.9-.9z"/>`,
} as const;

export type IconName = keyof typeof ICONS;
