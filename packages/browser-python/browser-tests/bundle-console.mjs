/** Build `.testbundle/console.js` on demand, for the demo server. */
import { bundleConsole } from "./harness.mjs";
console.log(`console bundled to ${bundleConsole()}`);
