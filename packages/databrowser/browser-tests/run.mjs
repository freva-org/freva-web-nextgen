/**
 * One documented entry point for the real-Chromium suites: `npm run test:browser`.
 *
 * Each suite is a standalone driver that owns its own fixture page, server and browser, so they run
 * as separate processes: a crashed engine in one cannot take the rest of the run with it, and any
 * suite stays individually runnable (`node browser-tests/layout.mjs`) while you debug it.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const SUITES = [
  "terminal-wrapping.mjs",
  "terminal-behaviour.mjs",
  "layout.mjs",
  "time-card.mjs",
  "search-dropdown.mjs",
  "filters-and-chrome.mjs",
  "overview-order.mjs",
  "embedded-host.mjs",
  "export-menu.mjs",
  "picker.mjs",
  "picker-scope.mjs",
  "picker-scale.mjs",
  "picker-compact.mjs",
];

let failed = 0;
for (const suite of SUITES) {
  const r = spawnSync(process.execPath, [path.join(HERE, suite)], { stdio: "inherit" });
  if (r.status !== 0) failed++;
}

console.log(
  failed === 0
    ? `\nAll ${SUITES.length} browser suites pass.`
    : `\n${failed} of ${SUITES.length} browser suites FAILED.`,
);
process.exit(failed === 0 ? 0 : 1);
