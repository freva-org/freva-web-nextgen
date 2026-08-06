// The query-revision invalidation race.
// A query mutation changes state.selected synchronously, but the replacement request id is not
// minted until the debounced runSearch begins 250 ms later. In that window an in-flight OLD
// search/recount must NOT settle into state - otherwise, transiently, the visible filters describe
// a different query than the displayed rows/counts. commitSearch() bumps a queryRevision AND
// aborts in-flight search+recount immediately; a response must match the revision to write state.
// These tests SAMPLE the window (after the old response would have settled, before the replacement
// settles), because the final state is correct either way (the replacement overwrites).

import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  installFetch,
  makeHost,
  overviewResponse,
  pickValue,
  searchResponse,
  wait,
} from "./helpers.js";
import { mountDataBrowser } from "../src/index.js";

function q<T extends Element = Element>(root: ParentNode, sel: string): T | null {
  return root.querySelector<T>(sel);
}
async function mount(
  router: Parameters<typeof installFetch>[0],
): Promise<{ handle: ReturnType<typeof mountDataBrowser>; root: HTMLElement }> {
  installFetch(router);
  const host = makeHost();
  const handle = mountDataBrowser(host, {});
  await wait(30);
  return { handle, root: q<HTMLElement>(host, ".freva-db") as HTMLElement };
}

test("a previous-query search settling before the replacement starts must not commit", async () => {
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview")) return { body: overviewResponse(["freva"], {}) };
    if (call.url.includes("/metadata-search/"))
      return {
        body: searchResponse({ total: 3, facets: { project: ["cmip6", 3], model: ["m1", 3] } }),
      };
    if (call.url.includes("/extended-search/")) {
      const hasModel = /[?&]model=/.test(call.url);
      const hasProject = /[?&]project=/.test(call.url);
      if (hasModel)
        return {
          body: searchResponse({
            total: 5,
            rows: [{ file: "/both.nc" }],
            facets: { project: ["cmip6", 5], model: ["m1", 5] },
            primary: ["project", "model"],
          }),
        };
      if (hasProject)
        return {
          body: searchResponse({
            total: 111,
            rows: [{ file: "/project-only.nc" }],
            facets: { project: ["cmip6", 111], model: ["m1", 111] },
            primary: ["project", "model"],
          }),
          delayMs: 150,
        };
      return {
        body: searchResponse({
          total: 3,
          rows: [{ file: "/init.nc" }],
          facets: { project: ["cmip6", 3], model: ["m1", 3] },
          primary: ["project", "model"],
        }),
      };
    }
    return { body: {} };
  };
  const { handle, root } = await mount(router);

  pickValue(root, "cmip6"); // t0: commits project=cmip6 -> search A scheduled (+250), A settles ~+400
  await wait(300); // A is in flight
  pickValue(root, "m1"); // +300: query changes -> abort A, bump revision; B scheduled (+550)
  await wait(190); // ~+490: A would have settled (+400); B has NOT (+550) - the stale window

  const mid = handle.getState();
  assert.notEqual(
    mid.totalCount,
    111,
    "the stale project-only count did not commit during the window",
  );
  assert.ok(
    !mid.rows.some((r) => r.file === "/project-only.nc"),
    "the stale project-only row did not commit",
  );

  await wait(500); // B settles
  const st = handle.getState();
  assert.equal(st.totalCount, 5, "final count is the current query");
  assert.deepEqual(st.selected, { project: ["cmip6"], model: ["m1"] });
  handle.destroy();
});

test("a previous-query recount settling before the replacement search starts must not commit", async () => {
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview")) return { body: overviewResponse(["freva"], {}) };
    if (call.url.includes("/metadata-search/")) {
      return {
        body: searchResponse({
          total: 1,
          facets: { project: ["cmip6", 999999], model: ["m1", 999999] },
        }),
        delayMs: 150,
      };
    }
    if (call.url.includes("/extended-search/")) {
      const filtered = /[?&]project=/.test(call.url);
      return {
        body: searchResponse({
          total: filtered ? 7 : 3,
          rows: [{ file: "/x.nc" }],
          facets: { project: ["cmip6", filtered ? 7 : 3], model: ["m1", filtered ? 7 : 3] },
          primary: ["project", "model"],
        }),
      };
    }
    return { body: {} };
  };
  const { handle, root } = await mount(router);
  q<HTMLButtonElement>(root, '[aria-label="Overview"]')?.click(); // t0: overview -> recount scheduled (+300), settles ~+450
  await wait(330); // recount in flight
  pickValue(root, "cmip6"); // +330: query changes -> abort recount; search B scheduled (+580)
  await wait(190); // ~+520: recount would have settled (+450); B has NOT (+580)

  const mid = handle.getState();
  const p0 = mid.facets.find((f) => f.key === "project");
  assert.ok(
    p0 && p0.values[0].count !== 999999,
    "the stale recount counts did not commit during the window",
  );

  await wait(500); // B settles
  const st = handle.getState();
  const p1 = st.facets.find((f) => f.key === "project");
  assert.equal(p1?.values[0].count, 7, "final counts come from the current-query search");
  handle.destroy();
});

test('"Load next" refuses to paginate a dead result set during the replacement debounce', async () => {
  const seen: string[] = [];
  const router = (call: { url: string }) => {
    if (call.url.includes("/overview")) return { body: overviewResponse(["freva"], {}) };
    if (call.url.includes("/metadata-search/"))
      return { body: searchResponse({ total: 200, facets: { project: ["cmip6", 200] } }) };
    if (call.url.includes("/extended-search/")) {
      seen.push(call.url);
      const filtered = /[?&]project=/.test(call.url);
      const rows = filtered
        ? [{ file: "/new_1.nc" }]
        : [{ file: "/old_1.nc" }, { file: "/old_2.nc" }];
      return {
        body: searchResponse({
          total: 200,
          rows,
          facets: { project: ["cmip6", 200] },
          primary: ["project"],
        }),
      };
    }
    return { body: {} };
  };
  const { handle, root } = await mount(router);
  const before = handle.getState().rows.length;
  assert.ok(before > 0, "the old query has rows loaded");

  pickValue(root, "cmip6"); // query changes -> replacement search is 250 ms away
  const during = seen.length;
  // click "load next" inside the debounce window
  const more = root.querySelector(".load-next") as HTMLButtonElement | null;
  assert.ok(more, 'the "Load next 100" button is still on screen during the debounce window');
  more!.click();
  await wait(60);
  const appendIssued = seen.slice(during).some((u) => /[?&]start=[1-9]/.test(u));
  assert.equal(appendIssued, false, "no append request is issued against the superseded row set");

  await wait(500); // the replacement lands
  const rows = handle.getState().rows.map((r) => r.file);
  assert.ok(
    !rows.some((f) => f.startsWith("/old_")),
    "no old-query rows survive under the new query",
  );
  handle.destroy();
});
