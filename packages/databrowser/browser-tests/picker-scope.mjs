/**
 * Fail-closed scoping, observed at the network layer in a real engine.
 *
 * A hosted instance scoped with `baseFilters: { project: "waterpark" }` under a CUSTOM flavour must
 * not ask the server anything until it knows how that flavour renames `project`. Sending the
 * freva-canonical key immediately - `.../extended-search/custom/file?…&project=waterpark` - asks a
 * custom index for a key it simply does not have, and nothing ever retries with the mapped
 * `dataset=waterpark`. A silently unscoped or mis-scoped hosted instance is the worst possible
 * failure for this feature, so the evidence is the REQUEST LOG, not a rendered state.
 *
 * This suite records every URL the page requests and prints them, so the "captured first request"
 * is a measurement rather than an assertion about one.
 */
import { IMPORT_MAP, inChromium, report, requireDist, serve } from "./harness.mjs";

requireDist();

/**
 * A backend that records requests and holds `/flavours` open until the page releases it, so the
 * "before the mapping arrives" window is real rather than a race.
 */
const recordingApi = `<script>
  window.__requests = [];
  window.__releaseFlavours = null;
  const held = new Promise((r) => { window.__releaseFlavours = r; });
  const json = (o) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
  window.fetch = async (url) => {
    const u = String(url);
    window.__requests.push(u);
    if (u.includes("/overview")) return json({ flavours: ["freva", "custom"], attributes: { freva: ["project"] } });
    if (u.includes("/flavours")) {
      const mode = await held;                       // the page decides when (and whether) this lands
      if (mode === "fail") throw new TypeError("network down");
      return json({ flavours: [{ flavour_name: "custom", mapping: { project: "dataset" } }] });
    }
    return json({
      total_count: 2, facets: { dataset: ["waterpark", 2] }, primary_facets: ["dataset"],
      facet_mapping: {}, search_results: [
        { file: "/archive/wp/a.nc", fs_type: "posix" },
        { file: "/archive/wp/b.nc", fs_type: "posix" },
      ],
    });
  };
</script>`;

const page = (mode) => `<!doctype html><html><head><meta charset="utf-8">${IMPORT_MAP}
<style>html,body{margin:0;height:100%} #app{height:100vh}</style></head><body><div id="app"></div>
${recordingApi}
<script type="module">
  const { mountDataPicker } = await import("@freva-org/databrowser/picker");
  window.__p = mountDataPicker(document.getElementById("app"), {
    apiBase: "/api/x", flavour: "custom", debounceMs: 5,
    baseFilters: { project: "waterpark" },
  });
  await new Promise(r => setTimeout(r, 400));   // ample time for a premature request to appear
  window.__mode = ${JSON.stringify(mode)};
  window.__ready = true;
</script></body></html>`;

const searches = (reqs) => reqs.filter((u) => u.includes("/extended-search/"));

const result = await inChromium(async (browser) => {
  const checks = [];

  // The mapping eventually arrives
  {
    const server = await serve(page("ok"));
    try {
      await browser.goto(server.url);
      await browser.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });

      const before = await browser.evaluate(() => ({
        requests: [...window.__requests],
        state: document.querySelector(".fp-state")?.textContent ?? "",
        rows: document.querySelectorAll(".fp-row").length,
      }));
      checks.push({
        name: "BEFORE the mapping: zero search requests, and the wait is stated",
        pass:
          searches(before.requests).length === 0 && /Preparing scoped browsing/.test(before.state),
        detail: JSON.stringify(before),
      });
      console.log(`  captured requests before the mapping: ${JSON.stringify(before.requests)}`);

      const after = await browser.evaluate(async () => {
        window.__releaseFlavours("ok");
        await new Promise((r) => setTimeout(r, 400));
        return {
          requests: [...window.__requests],
          rows: document.querySelectorAll(".fp-row").length,
          err: document.querySelector(".fp-state.err")?.textContent ?? "",
        };
      });
      const s = searches(after.requests);
      console.log(`  captured first search AFTER the mapping: ${s[0] ?? "(none)"}`);
      checks.push({
        name: "AFTER the mapping: exactly one search, keyed by the MAPPED facet",
        pass:
          s.length === 1 &&
          s[0].includes("/extended-search/custom/file") &&
          s[0].includes("dataset=waterpark") &&
          !s[0].includes("project=waterpark"),
        detail: s.join(" | ") || "(no search)",
      });
      checks.push({
        name: "…and the correctly scoped results are rendered",
        pass: after.rows === 2 && after.err === "",
        detail: JSON.stringify({ rows: after.rows, err: after.err }),
      });
    } finally {
      await server.close();
    }
  }

  // The mapping never arrives
  {
    const server = await serve(page("fail"));
    try {
      await browser.goto(server.url);
      await browser.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });
      const failed = await browser.evaluate(async () => {
        window.__releaseFlavours("fail");
        await new Promise((r) => setTimeout(r, 400));
        const state = document.querySelector(".fp-state");
        return {
          requests: [...window.__requests],
          err: state?.classList.contains("err") ?? false,
          text: state?.textContent ?? "",
          addDisabled: document.querySelector(".fp-add")?.disabled ?? false,
        };
      });
      console.log(`  captured requests after a FAILED mapping: ${JSON.stringify(failed.requests)}`);
      checks.push({
        name: "a failed mapping issues NO search at all",
        pass: searches(failed.requests).length === 0,
        detail: JSON.stringify(failed.requests),
      });
      checks.push({
        name: "…and says so visibly, with the action disabled",
        pass:
          failed.err && /Scoped browsing is unavailable/.test(failed.text) && failed.addDisabled,
        detail: JSON.stringify(failed),
      });
    } finally {
      await server.close();
    }
  }

  return checks;
});

process.exit(report("picker: fail-closed scoping for a custom flavour", result));
