/**
 * Copy the console stylesheet into `dist/`. Published as a real file as well as embedded as a
 * string, because the two serve different consumers: the shadow root uses the string, while a host
 * that wants to READ the tokens, or renders the console in light DOM, wants a stylesheet it can
 * link. `tsc` does not copy assets, so this does.
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const from = join(HERE, "..", "src", "console", "styles.css");
const to = join(HERE, "..", "dist", "console", "styles.css");
mkdirSync(dirname(to), { recursive: true });
copyFileSync(from, to);
console.log("console styles.css copied to dist/console/");
