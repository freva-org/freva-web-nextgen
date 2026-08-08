// commands.ts - the COPYABLE freva-client command builders.
//
// Kept out of state.ts for one concrete reason: state.ts is the shared, DOM-free search boundary
// the `/picker` entry depends on, and these builders are the only part of it that would need
// `shell.ts` at runtime. Keeping them here means the picker's module graph stops at the facet
// algebra instead of dragging in shell dialects it will never render - and
// `tests/picker-import-graph.test.ts` can assert that rather than hope for it.

import type { AppState } from "./types.js";
import { SHELLS, type Shell, type ShellId } from "./shell.js";
import { baseScopePairs, facetPairs } from "./state.js";

/**
 * Reproducible CLI command, copyable into a shell. Shell-aware quoting and an explicit
 * `--host` (so it runs on the user's LOCAL machine against the API). With no options it
 * renders the bash form with no host.
 */
export function cliCommand(state: AppState, opts?: { shell?: ShellId }): string {
  const shell = SHELLS[opts?.shell ?? "bash"];
  const parts = ["freva-client databrowser data-search"];
  if (state.flavour !== "freva") parts.push(`--flavour ${shell.quote(state.flavour)}`);
  // The base scope is part of every query the widget runs. Include it in the COPYABLE command (quoted
  // for the chosen shell) so a pasted command reproduces the scoped results instead of the whole
  // archive. The editable textarea still owns only user selections, so the gate can't be edited off.
  for (const [k, v] of baseScopePairs(state)) parts.push(`${k}=${shell.quote(v)}`);
  parts.push(cliFacetTokens(state, shell));
  return parts.filter(Boolean).join(" ").trim();
}

/** Read-only time/bbox tokens - they always come FIRST, before the editable facet tokens. */
export function cliFixedTokens(state: AppState, shell: Shell = SHELLS.bash): string {
  const q = shell.quote;
  const tokens: string[] = [];
  const t = state.time;
  if (t && (t.from || t.to)) {
    tokens.push(`time=${q(`${t.from || "1"} TO ${t.to || "9999"}`)}`);
    tokens.push(`time_select=${t.mode}`);
  }
  const b = state.bbox;
  if (b) {
    tokens.push(`bbox=${b.minLon},${b.maxLon},${b.minLat},${b.maxLat}`);
    tokens.push(`bbox_select=${b.mode}`);
  }
  return tokens.join(" ");
}

/** The facet/time/bbox tokens for the COPYABLE CLI command - shell-quoted (shell-safe). */
export function cliFacetTokens(state: AppState, shell: Shell = SHELLS.bash): string {
  const q = shell.quote;
  const fixed = cliFixedTokens(state, shell);
  const facets = facetPairs(state)
    .map(([k, v]) => `${k}=${q(v)}`)
    .join(" ");
  return [fixed, facets].filter(Boolean).join(" ");
}
