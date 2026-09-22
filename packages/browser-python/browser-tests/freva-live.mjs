/**
 * The live Freva deployment, from a real browser origin. OPT-IN, and never part of CI.
 *
 *     BROWSER_PYTHON_NETWORK=1 FREVA_HOST=https://eve.dkrz.de node browser-tests/freva-live.mjs
 *
 * WHY THIS CANNOT BE A DETERMINISTIC TEST. CORS is the deployment's decision, not this package's,
 * and cannot be repaired from inside the page; a server that answers `curl` has proved nothing,
 * because `curl` sends no Origin and enforces no policy. So this runs from a real origin in a
 * real browser and produces an ACCEPTANCE result about someone else's server. It reports the
 * exact URL, the status, and whether the browser refused a response it did receive, because "it
 * does not work" is the least useful possible bug report for a CORS problem.
 */
import {
  bundleConsole,
  ensureFrevaWheelhouse,
  fixturePage,
  FREVA_WHEELHOUSE,
  inBrowser,
  report,
  requireDist,
  requireRuntimeFor,
  serve,
} from "./harness.mjs";

requireDist();
// The freva-client profile needs its wheel; without this the suite FAILED on an incomplete
// runtime instead of reporting NOT RUN, which is a missing wheel wearing the costume of a bad server.
requireRuntimeFor("freva-client against a live deployment", "freva-live.mjs");
bundleConsole();

const HOST = process.env.FREVA_HOST ?? "https://eve.dkrz.de";

if (process.env.BROWSER_PYTHON_NETWORK !== "1") {
  // THROUGH `report()`, like every other exit. Printing a SKIPPED line and exiting 0 by hand is
  // the fail-open shape in miniature: one more place that can produce a zero without `report()`
  // ever seeing the result. An opt-in suite that was not opted into has not failed - it just says
  // so through the one function that may.
  process.exit(
    report("freva-client against a live deployment", {
      status: "skipped",
      detail:
        `set BROWSER_PYTHON_NETWORK=1 to run this against a real server; ` +
        `it would talk to ${HOST} from a real browser origin.`,
      checks: [],
    }),
  );
}

/** The derived wheel, served same-origin exactly as a deployment serves it. */
const WHEELHOUSE = "/freva-wheels/";
// Built before the browser starts. This suite reports on someone else's server, so a missing
// wheel must not be able to masquerade as that server refusing the browser.
try {
  await ensureFrevaWheelhouse();
} catch (error) {
  // THROUGH `report()`, like every other exit. An unhandled rejection here would leave `run.mjs`
  // with a non-zero exit and no result line, which reads as the suite crashing rather than as the
  // one thing that went wrong: the wheel could not be built.
  process.exit(
    report("freva-client against a live deployment", {
      status: "fail",
      checks: [
        {
          name: "the derived Freva wheel can be built",
          pass: false,
          detail: String(error?.message ?? error),
        },
      ],
    }),
  );
}

const result = await inBrowser(async (page) => {
  const server = await serve(fixturePage({ profile: "freva-client", wheelhouseURL: WHEELHOUSE }), {
    roots: { [WHEELHOUSE]: FREVA_WHEELHOUSE },
  });
  const checks = [];
  try {
    await page.goto(server.url);
    await page.waitForFunction(() => window.__py !== undefined);
    await page.evaluate(() => window.__py.start());
    await page.waitForFunction(() => window.__py.state() === "ready", null, { timeout: 300000 });

    const run = (code) =>
      page.evaluate(async (src) => {
        window.__py.drain();
        const r = await window.__py.run(src);
        await new Promise((z) => setTimeout(z, 300));
        return { error: r.error ?? null, stdout: window.__py.text("stdout").trim() };
      }, code);

    // The plain browser fetch first, and separately from Python. If this fails, everything below
    // fails for the same reason, and telling "the origin is not allowed" apart from "the package
    // is broken" is exactly what this run exists to establish.
    const raw = await page.evaluate(async (host) => {
      const url = `${host}/api/freva-nextgen/databrowser/overview`;
      try {
        const response = await fetch(url);
        return { url, ok: response.ok, status: response.status };
      } catch (error) {
        return { url, ok: false, corsOrNetwork: String(error).slice(0, 200) };
      }
    }, HOST);
    checks.push({
      name: `the browser may read ${HOST} at all (CORS)`,
      pass: raw.ok === true,
      detail: JSON.stringify(raw),
    });

    const overview = await run(
      [
        "import json",
        "from freva_client import databrowser",
        `db = databrowser(host="${HOST}")`,
        "try:",
        "    n = len(db)",
        "    print(json.dumps({'ok': True, 'count': n}))",
        "except Exception as exc:",
        "    print(json.dumps({'ok': False, 'error': type(exc).__name__ + ': ' + str(exc)[:300]}))",
        "",
      ].join("\n"),
    );
    checks.push({
      name: "databrowser reaches the live deployment and counts results",
      pass: overview.stdout.includes('"ok": true'),
      detail: overview.stdout || String(overview.error).split("\n").pop(),
    });

    const device = await run(
      [
        "import json, httpx",
        "try:",
        `    r = httpx.post("${HOST}/api/freva-nextgen/auth/v2/device", timeout=30)`,
        "    print(json.dumps({'status': r.status_code}))",
        "except Exception as exc:",
        "    print(json.dumps({'error': type(exc).__name__ + ': ' + str(exc)[:300]}))",
        "",
      ].join("\n"),
    );
    checks.push({
      name: "the device-authorization endpoint answers a browser request",
      pass: device.stdout.includes('"status"'),
      detail: device.stdout || String(device.error).split("\n").pop(),
    });

    return checks;
  } finally {
    await server.close();
  }
});

process.exit(report(`freva-client against ${HOST}`, result));
