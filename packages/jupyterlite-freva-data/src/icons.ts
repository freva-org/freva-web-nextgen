// The panel's icons: line icons for the actions (the colour of the text around them), and the
// launcher cards' logos, drawn in the site's own colour (the first colour of its icon).

import { LabIcon } from "@jupyterlab/ui-components";
import type { CommandRegistry } from "@lumino/commands";

const PACKAGE = "@freva-org/jupyterlite-freva-data";

const line = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

const actionIcon = (name: string, body: string) =>
  new LabIcon({ name: `${PACKAGE}:${name}`, svgstr: line(body) });

export const openIcon = actionIcon(
  "open-in-notebook",
  '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 3v18M12.5 8h3.5M12.5 11.5h3.5"/>',
);
export const insertIcon = actionIcon(
  "insert",
  '<path d="M4 4.5h16M4 9h16"/><rect x="4" y="13" width="16" height="7.5" rx="1.5" stroke-dasharray="2.6 2.2"/><path d="M12 14.7v4.1M9.9 16.8h4.2"/>',
);
export const inspectIcon = actionIcon(
  "inspect",
  '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.3 15.3 20.5 20.5M7.8 9h5.4M7.8 12h3.6"/>',
);
export const globeIcon = actionIcon(
  "view-on-globe",
  '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.4 3.7 5.2 3.7 8.5s-1.2 6.1-3.7 8.5c-2.5-2.4-3.7-5.2-3.7-8.5S9.5 5.9 12 3.5z"/>',
);
export const askIcon = actionIcon(
  "ask",
  '<path d="M5 5h14a1.5 1.5 0 0 1 1.5 1.5v8.5a1.5 1.5 0 0 1-1.5 1.5h-7.5L7 20v-3.5H5A1.5 1.5 0 0 1 3.5 15V6.5A1.5 1.5 0 0 1 5 5z"/><path d="m12 7.8.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8z"/>',
);
export const linkIcon = actionIcon(
  "copy-url",
  '<path d="M10.2 13.8a4 4 0 0 0 5.6 0l3-3a4 4 0 0 0-5.6-5.6l-1.1 1.1"/><path d="M13.8 10.2a4 4 0 0 0-5.6 0l-3 3a4 4 0 0 0 5.6 5.6l1.1-1.1"/>',
);
export const codeIcon = actionIcon(
  "copy-code",
  '<path d="M8.5 7.5 4 12l4.5 4.5M15.5 7.5 20 12l-4.5 4.5M13.5 5l-3 14"/>',
);

/** The first colour a site icon draws with, unless it is a grey (a theme-neutral icon). */
export function accentOf(svg: string): string | null {
  for (const match of svg.matchAll(
    /(?:fill|stroke)\s*[:=]\s*["']?\s*#([0-9a-f]{6}|[0-9a-f]{3})\b/gi,
  )) {
    const hex = match[1]!.length === 3 ? [...match[1]!].map((c) => c + c).join("") : match[1]!;
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    if (Math.max(r!, g!, b!) - Math.min(r!, g!, b!) > 24) return `#${hex.toLowerCase()}`;
  }
  return null;
}

/** A launcher card's logo: 48 units square, in `accent` (or the theme's brand colour). */
function logo(accent: string | null, body: string): string {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="52" height="52" viewBox="0 0 48 48">' +
    body.replace(/\$A/g, accent ?? "var(--jp-brand-color1)") +
    "</svg>"
  );
}

/** The site's launcher logos: a new notebook, the example notebooks, and a chat. */
export function launcherIcons(siteIconSvg: string) {
  const accent = accentOf(siteIconSvg);
  return {
    newNotebook: new LabIcon({
      name: `${PACKAGE}:launcher-new-notebook`,
      svgstr: logo(
        accent,
        '<rect x="8" y="5" width="26" height="36" rx="4" style="fill:$A;fill-opacity:.16;stroke:$A;stroke-width:2.4"/>' +
          '<path d="M14 5v36" style="stroke:$A;stroke-width:2.4"/>' +
          '<path d="M19 14h9M19 20h9M19 26h5" style="stroke:$A;stroke-width:2.4;stroke-linecap:round"/>' +
          '<circle cx="35" cy="35" r="9" style="fill:$A"/>' +
          '<path d="M35 30.5v9M30.5 35h9" style="stroke:var(--jp-layout-color0,#fff);stroke-width:2.6;stroke-linecap:round"/>',
      ),
    }),
    examples: new LabIcon({
      name: `${PACKAGE}:launcher-examples`,
      svgstr: logo(
        accent,
        '<rect x="15" y="4" width="25" height="32" rx="4" style="fill:$A;fill-opacity:.12;stroke:$A;stroke-width:2.2;stroke-opacity:.55"/>' +
          '<rect x="8" y="11" width="25" height="33" rx="4" style="fill:var(--jp-layout-color1,#fff);stroke:$A;stroke-width:2.4"/>' +
          '<rect x="8" y="11" width="25" height="33" rx="4" style="fill:$A;fill-opacity:.16"/>' +
          '<path d="m20.5 19.5 2.3 4.7 5.2.8-3.8 3.6.9 5.1-4.6-2.4-4.6 2.4.9-5.1-3.8-3.6 5.2-.8z" style="fill:$A"/>',
      ),
    }),
    ask: new LabIcon({
      name: `${PACKAGE}:launcher-ask`,
      svgstr: logo(
        accent,
        '<path d="M9 8h30a4 4 0 0 1 4 4v17a4 4 0 0 1-4 4H23l-9 7v-7H9a4 4 0 0 1-4-4V12a4 4 0 0 1 4-4z" style="fill:$A;fill-opacity:.16;stroke:$A;stroke-width:2.4;stroke-linejoin:round"/>' +
          '<path d="m24 13.5 1.8 4.2 4.2 1.8-4.2 1.8-1.8 4.2-1.8-4.2-4.2-1.8 4.2-1.8z" style="fill:$A"/>',
      ),
    }),
  };
}

/** Another command's icon (ClimateClaw's logo for Ask), or `fallback` while it has none. */
export function borrowedIcon(commands: CommandRegistry, id: string, fallback: LabIcon) {
  return () => (commands.hasCommand(id) && commands.icon(id)) || fallback;
}
