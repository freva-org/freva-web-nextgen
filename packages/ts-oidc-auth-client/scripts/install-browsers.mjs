/**
 * Install exactly the engines this platform's commands will actually run.
 *
 * `playwright install <names>` only ever ADDS to the shared cache in
 * ~/.cache/ms-playwright. Nothing here uninstalls or prunes: that cache is
 * shared with every other project on the machine, and "we do not run WebKit
 * here" is not a reason to delete someone else's.
 */
import { spawnSync } from "node:child_process";
import { selectInstallBrowsers } from "../browser-tests/browsers.mjs";

let selection;
try {
  selection = selectInstallBrowsers({
    platform: process.platform,
    override: process.env.BROWSERS,
  });
} catch (e) {
  console.error(e.message);
  process.exit(2);
}

for (const note of selection.notes) console.log(`[browsers] ${note}`);
console.log(`[browsers] installing: ${selection.browsers.join(", ")}`);

const result = spawnSync("npx", ["playwright", "install", ...selection.browsers], {
  stdio: "inherit",
});
if (result.error) {
  console.error(`[browsers] could not start playwright: ${result.error.message}`);
  process.exit(2);
}
process.exit(result.status ?? 2);
