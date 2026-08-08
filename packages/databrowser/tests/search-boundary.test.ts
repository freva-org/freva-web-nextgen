// The contract that makes the picker safe to ship inside this package: the FULL BROWSER and the
// PICKER must turn the same serialised search state into the same effective REST query.
//
// This is not a style preference. freva-rest's negation contract is a key suffix (`project_not_`),
// its flavour translation is a server-side pivot, and its base-scope merge has a dedupe rule -
// every one of those is a place where a second, independently-evolving implementation would agree
// on the day it was written and diverge silently afterwards.
//
// So the comparison here is deliberately end-to-end and asymmetric: the browser is driven through
// a REAL deep link and its ACTUAL network request is captured, while the picker builds its URL from
// the same state through `effectiveSearchQuery` + `buildSearchUrl`. Two entirely different objects
// hold the question; one string has to come out.

import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  fetchCalls,
  installFetch,
  makeHost,
  overviewResponse,
  searchResponse,
  wait,
  window as win,
} from "./helpers.js";
import { mountDataBrowser } from "../src/index.js";
import { buildSearchUrl, effectiveSearchQuery, emptyScope } from "../src/search/query.js";
import { normalizePickerState, toQueryScope } from "../src/picker/state.js";
import { BUILTIN_FLAVOUR_MAPS } from "../src/state.js";
import type { PickerState } from "../src/picker/types.js";

const API = "/api/freva-nextgen/databrowser";

const FACETS = {
  project: ["cmip6", 40, "cordex", 12, "waterpark", 7],
  mip_era: ["cmip6", 40, "cmip5", 9],
  variable: ["tas", 30, "pr", 22],
  variable_id: ["tas", 30],
  model: ["mpi-esm", 18],
};

function route(): () => void {
  return installFetch(({ url }) => {
    if (url.includes("/overview")) {
      return {
        body: overviewResponse(["freva", "cmip6"], {
          freva: ["project", "variable", "model", "mip_era", "variable_id"],
        }),
      };
    }
    if (url.includes("/flavours")) return { body: { flavours: [] } };
    return {
      body: searchResponse({
        total: 40,
        rows: [{ file: "/archive/tas.nc" }],
        facets: FACETS,
        primary: ["project", "variable", "model"],
      }),
    };
  });
}

/** The FIRST extended-search URL the mounted browser sent - the one the deep link produced. */
function firstSearchUrl(): string {
  const hits = fetchCalls.filter((c) => c.url.includes("/extended-search/"));
  assert.ok(hits.length, "the browser sent no extended-search request");
  return hits[0].url;
}

interface Case {
  name: string;
  /** The deep link the user arrived on - the browser's serialised search state. */
  link: string;
  /** The same question as picker state. */
  state: Partial<PickerState>;
  baseFilters?: Record<string, string | string[]>;
}

const CASES: Case[] = [
  {
    name: "a plain positive selection",
    link: "?project=cmip6&variable=tas",
    state: { selected: { project: ["cmip6"], variable: ["tas"] } },
  },
  {
    name: "an exclusion (the `_not_` key form)",
    link: "?project_not_=cmip6",
    state: { selected: { project_not_: ["cmip6"] } },
  },
  {
    name: "mixed include + exclude across facets",
    link: "?project=cordex&variable_not_=pr",
    state: { selected: { project: ["cordex"], variable_not_: ["pr"] } },
  },
  {
    name: "multi-value OR on one key",
    link: "?project=cmip6&project=cordex",
    state: { selected: { project: ["cmip6", "cordex"] } },
  },
  {
    name: "time + bbox controls",
    link: "?variable=tas&time=2000+TO+2010&time_select=flexible&bbox=-10%2C10%2C40%2C60&bbox_select=flexible",
    state: {
      selected: { variable: ["tas"] },
      time: { from: "2000", to: "2010", mode: "flexible" },
      bbox: { minLon: -10, maxLon: 10, minLat: 40, maxLat: 60, mode: "flexible" },
    },
  },
  {
    name: "a positive base scope, which OWNS its key (the link's project= is refused by both)",
    link: "?variable=tas&project=cmip6",
    state: { selected: { variable: ["tas"], project: ["cmip6"] } },
    baseFilters: { project: "waterpark" },
  },
  {
    name: "a negative base scope, which does NOT own its key (both merge the narrowing)",
    link: "?project=cordex",
    state: { selected: { project: ["cordex"] } },
    baseFilters: { project_not_: "cmip6" },
  },
  {
    name: "a translated flavour, where the negation suffix must survive re-keying",
    link: "?flavour=cmip6&mip_era_not_=cmip5&variable_id=tas",
    state: { flavour: "cmip6", selected: { mip_era_not_: ["cmip5"], variable_id: ["tas"] } },
  },
];

for (const c of CASES) {
  test(`browser and picker build the same REST query: ${c.name}`, async () => {
    const reset = route();
    // installFetch resets the URL, so the deep link has to be written AFTERWARDS.
    win.history.replaceState(null, "", `/${c.link}`);
    const host = makeHost();
    const handle = mountDataBrowser(host, {
      syncUrl: true,
      apiBase: API,
      ...(c.baseFilters ? { baseFilters: c.baseFilters } : {}),
    });
    try {
      await wait(60);
      const browserUrl = firstSearchUrl();

      const normalized = normalizePickerState(c.state, c.state.flavour ?? "freva");
      const q = effectiveSearchQuery(
        toQueryScope(normalized, c.baseFilters, structuredClone(BUILTIN_FLAVOUR_MAPS)),
      );
      const pickerUrl = buildSearchUrl(
        API,
        "extended-search",
        q.flavour,
        q.uniqKey,
        q.queryString,
        {
          maxResults: 100,
        },
      );

      assert.equal(pickerUrl, browserUrl);
    } finally {
      handle.destroy();
      host.remove();
      win.history.replaceState(null, "", "/");
      reset();
    }
  });
}

test("effectiveSearchQuery separates the WIRE query from the shareable selection", () => {
  const q = effectiveSearchQuery(
    emptyScope({ selected: { variable: ["tas"] }, baseFilters: { project: ["waterpark"] } }),
  );
  // The invisible base scope is on the wire…
  assert.deepEqual(q.params, [
    ["project", "waterpark"],
    ["variable", "tas"],
  ]);
  // …and NOT in what a shareable link would carry.
  assert.deepEqual(q.selectionParams, [["variable", "tas"]]);
});

test("a NEGATIVE base scope does not own its key - further narrowing is merged, not dropped", () => {
  const q = effectiveSearchQuery(
    emptyScope({
      selected: { project: ["cordex"], project_not_: ["cmip5"] },
      baseFilters: { project_not_: ["cmip6"] },
    }),
  );
  assert.deepEqual(q.params, [
    ["project_not_", "cmip6"],
    ["project_not_", "cmip5"],
    ["project", "cordex"],
  ]);
});

test("buildSearchUrl always sends translate=true, and start only when non-zero", () => {
  assert.equal(
    buildSearchUrl(`${API}/`, "extended-search", "cmip6", "file", "variable_id=tas", {
      maxResults: 100,
      start: 0,
    }),
    `${API}/extended-search/cmip6/file?translate=true&max-results=100&variable_id=tas`,
  );
  assert.equal(
    buildSearchUrl(API, "metadata-search", "freva", "uri", "", {}),
    `${API}/metadata-search/freva/uri?translate=true`,
  );
});
