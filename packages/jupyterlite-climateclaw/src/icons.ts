// ClimateClaw's icons: simple line drawings, stroked in the theme's icon colour (`jp-icon3`).

import { LabIcon } from "@jupyterlab/ui-components";

import { LOGO_DATA_URL } from "./logo.js";

const svg = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none"><g class="jp-icon3" stroke="#616161" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</g></svg>`;

export const historyIcon = new LabIcon({
  name: "climateclaw:history",
  svgstr: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
});

export const contextIcon = new LabIcon({
  name: "climateclaw:add-context",
  svgstr: svg('<path d="M12 5v14M5 12h14"/>'),
});

export const promptsIcon = new LabIcon({
  name: "climateclaw:prompts",
  svgstr: svg(
    '<path d="M12 3.5l1.9 5 5 1.9-5 1.9-1.9 5-1.9-5-5-1.9 5-1.9z"/><path d="M19 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
  ),
});

export const codeIcon = new LabIcon({
  name: "climateclaw:code",
  svgstr: svg('<path d="M9 8l-4 4 4 4M15 8l4 4-4 4"/>'),
});

export const conversationIcon = new LabIcon({
  name: "climateclaw:conversation",
  svgstr: svg('<path d="M5 6.5h14v9H10l-4 3v-3H5z"/>'),
});

export const moreIcon = new LabIcon({
  name: "climateclaw:more",
  svgstr: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"><g class="jp-icon3" fill="#616161"><circle cx="12" cy="5.5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="18.5" r="1.7"/></g></svg>`,
});

/** Code, struck through: the code toggle while code is hidden. */
export const codeOffIcon = new LabIcon({
  name: "climateclaw:code-off",
  svgstr: svg('<path d="M9 8l-4 4 4 4M15 8l4 4-4 4"/><path d="M5 19L19 5"/>'),
});

/** A cell with a target: context that follows the active cell. */
export const followIcon = new LabIcon({
  name: "climateclaw:follow-cell",
  svgstr: svg('<rect x="4" y="6" width="16" height="12" rx="2"/><circle cx="12" cy="12" r="2.2"/>'),
});

/** An arrow into a cell: go to the cell a reply wrote. */
export const jumpIcon = new LabIcon({
  name: "climateclaw:jump-to-cell",
  svgstr: svg('<rect x="9" y="6" width="11" height="12" rx="2"/><path d="M3 12h9M9 9l3 3-3 3"/>'),
});

/** Half a brain seen from above: a scalloped outline and its folds (mirrored for the other). */
const HEMISPHERE = [
  '<path d="M12 5.3C11.6 3.7 8.9 3.4 7.9 5.2 5.9 5.1 4.6 7.2 5.4 9.1 3.9 10.2 3.9 12.9 5.4 14 4.6 16.3 6.3 18.6 8.6 18.5 9.6 20.3 11.6 20.1 12 18.7"/>',
  '<path d="M7.9 5.2c.2 1.1 1 1.8 2.1 1.9M5.4 9.1c1 .3 2 0 2.6-.8M5.4 14c.9-.7 2.1-.8 3-.2M8.6 18.5c0-1 .6-1.9 1.5-2.3M12 11.4c-1.1.1-2-.4-2.5-1.3"/>',
  '<path d="M7.9 5.2c.3 1 1.1 1.6 2.1 1.6M5.4 9.1c.9.5 2 .4 2.7-.3M5.4 14c1-.5 2.2-.4 3 .3M8.6 18.5c.1-1 .7-1.7 1.5-2M12 13.4c-1-.3-1.6-1-1.8-1.9"/>',
];

/** A brain: the model a chat talks to, beside its name. Finer strokes, for its detail. */
export const modelIcon = new LabIcon({
  name: "climateclaw:model",
  svgstr: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none"><g class="jp-icon3" stroke="#616161" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${HEMISPHERE[0]}${HEMISPHERE[1]}<g transform="matrix(-1 0 0 1 24 0)">${HEMISPHERE[0]}${HEMISPHERE[2]}</g><path d="M12 5.3v13.4"/></g></svg>`,
});

/** A filled square: stop the reply. */
export const stopIcon = new LabIcon({
  name: "climateclaw:stop",
  svgstr: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"/></svg>`,
});

/** A cell with a play mark: Run at DKRZ. */
export const runAtIcon = new LabIcon({
  name: "climateclaw:run-at-dkrz",
  svgstr: svg('<path d="M8 5.5v13l10-6.5z"/>'),
});

/** ClimateClaw's logo, for its side panel's tab. */
export const logoIcon = new LabIcon({
  name: "climateclaw:logo",
  svgstr: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"><image href="${LOGO_DATA_URL}" width="24" height="24"/></svg>`,
});

/** A microphone: speak a message. */
export const micIcon = new LabIcon({
  name: "climateclaw:mic",
  svgstr: svg(
    '<rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5"/>',
  ),
});
