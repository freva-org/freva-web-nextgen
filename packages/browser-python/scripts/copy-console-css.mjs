// Copy the console stylesheet into `dist/`. Published as a real file as well as embedded as a
// string, because the two serve different consumers: the shadow root uses the string, while a host
// that wants to READ the tokens, or renders the console in light DOM, wants a stylesheet it can
// link. `tsc` does not copy assets, so this does.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (...parts) => readFileSync(join(HERE, "..", "src", ...parts), "utf8");
const display = src("display", "display.css");
const to = join(HERE, "..", "dist", "console", "styles.css");
mkdirSync(dirname(to), { recursive: true });
// The same rules, in the same order, as the shadow root's string.
writeFileSync(to, [src("console", "styles.css"), src("console", "notice-card.css")].join("\n"));
const displayTo = join(HERE, "..", "dist", "display", "display.css");
mkdirSync(dirname(displayTo), { recursive: true });
writeFileSync(displayTo, display);
console.log("console styles.css and display.css copied to dist/");
