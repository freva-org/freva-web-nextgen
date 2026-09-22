/**
 * A stand-in suite that reaches the exact reporting path the gate is about, and needs nothing.
 *
 * The gate's question is whether a suite that cannot launch a browser exits non-zero under
 * `BROWSER_STRICT=1`. Answering it with a REAL suite makes the answer depend on the developer's
 * workspace - `dist/` present or not, `.runtime/` complete or not - because those prerequisites
 * are checked before a browser is ever launched and each exits with a different code for a
 * different reason. So the prerequisites are removed and the path is kept: this calls the
 * harness's own `inBrowser` and `report`, the same functions every suite calls, with a browser
 * path that cannot exist. Nothing here reads `dist/`, `.runtime/`, or the network.
 */
import { inBrowser, report } from "../../../browser-tests/harness.mjs";

const result = await inBrowser(async () => {
  // Unreachable: the launch above fails first. If it ever runs, an empty checks array is still
  // not a pass, which is the other half of what `report()` guarantees.
  return { status: "pass", checks: [] };
});

process.exit(report("a suite whose browser cannot launch", result));
