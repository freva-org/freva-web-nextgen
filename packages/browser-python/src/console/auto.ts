/**
 * @freva-org/browser-python/console/auto - register the element and get out of the way.
 *
 * BROWSER ONLY, and deliberately the only module in the package with a side effect. Importing it
 * during server-side rendering will not throw - `defineBrowserPythonConsole` returns immediately
 * where `customElements` does not exist - but it is pointless there; import `../console` instead.
 *
 *     <script type="module">
 *       import "@freva-org/browser-python/console/auto";
 *     </script>
 *     <freva-python-console profile="xarray-zarr" autostart></freva-python-console>
 */

import { defineBrowserPythonConsole } from "./browser-python-console.js";

defineBrowserPythonConsole();

export { BrowserPythonConsole, defineBrowserPythonConsole } from "./browser-python-console.js";
