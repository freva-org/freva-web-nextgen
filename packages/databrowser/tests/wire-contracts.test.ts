// Pure-function coverage of the wire/command boundary. No DOM here:
// these lock the contract decisions (unbracketed time, bbox order, per-value URL encoding,
// OR-merge token parsing, the empty-[] = N/A rule, filename-only time derivation).

import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MAP_CONFIG } from "../src/map.js";

import {
  buildFacets,
  buildFlavourMaps,
  buildUrlQuery,
  cliCommand,
  createInitialState,
  facetQueryString,
  filterCommittable,
  metaFromFacetsBlock,
  parseFacetTokens,
  parseUrlQuery,
  pythonCommand,
  shellQuote,
  timeRangeFromFilename,
  tokenize,
  toggleSelected,
  translateKey,
  translateSelection,
} from "../src/state.js";
import { escapeHtml } from "../src/dom.js";
import type { AppState, ResolvedConfig, SearchResult } from "../src/types.js";

function cfg(over: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    map: DEFAULT_MAP_CONFIG,
    inspectorUrl: "",

    apiBase: "/api/freva-nextgen/databrowser",
    flavour: "freva",
    devNotes: false,
    authEnabled: false,
    enableHeavyOps: false,
    syncUrl: false,
    enableStrictBBoxModes: false,

    metadata: {},
    metadataScriptUrl: null,
    features: {
      themeToggle: true,
      terminal: true,
      overview: true,
      export: true,
      details: true,
      search: true,
      lensSwitcher: true,
      inspect: true,
      brand: true,
    },
    theme: {},
    brand: { title: "Freva", mark: "≈", description: "" },
    terminal: { host: null, shell: null, os: null },
    getAuthToken: () => null,
    getCsrfToken: () => null,
    ...over,
  };
}

function state(over: Partial<AppState> = {}): AppState {
  return { ...createInitialState(cfg()), ...over };
}

test("facetQueryString: time is UNBRACKETED with a separate time_select", () => {
  const s = state({ time: { from: "2000", to: "2010", mode: "flexible" } });
  const q = facetQueryString(s);
  assert.match(q, /time=2000(%20| )TO(%20| )2010/);
  assert.doesNotMatch(decodeURIComponent(q), /\[/, "no opening bracket anywhere");
  assert.doesNotMatch(decodeURIComponent(q), /\]/, "no closing bracket anywhere");
  assert.match(q, /time_select=flexible/);
});

test("facetQueryString: bbox order is minLon,maxLon,minLat,maxLat + bbox_select", () => {
  const s = state({ bbox: { minLon: -10, maxLon: 10, minLat: -5, maxLat: 5, mode: "flexible" } });
  const q = decodeURIComponent(facetQueryString(s));
  assert.match(q, /bbox=-10,10,-5,5/);
  assert.match(q, /bbox_select=flexible/);
});

test("facetQueryString: each value is URL-encoded and multi-value repeats the key (OR)", () => {
  const s = state();
  toggleSelected(s, "experiment", "rcp 8.5");
  toggleSelected(s, "experiment", "a&b");
  const q = facetQueryString(s);
  assert.match(q, /experiment=rcp%208\.5/);
  assert.match(q, /experiment=a%26b/);
  assert.equal(q.match(/experiment=/g)?.length, 2, "repeated key for OR");
});

test("cliCommand: --flavour only emitted when != freva", () => {
  const s = state();
  toggleSelected(s, "variable", "tas");
  assert.doesNotMatch(cliCommand(s), /--flavour/);
  const s2 = state({ flavour: "cmip6" });
  toggleSelected(s2, "variable", "tas");
  assert.match(cliCommand(s2), /--flavour cmip6/);
});

test("pythonCommand: multi-line call; multi-value -> list; flavour omitted for freva", () => {
  const s = state();
  toggleSelected(s, "model", "A");
  toggleSelected(s, "model", "B");
  const py = pythonCommand(s);
  assert.match(py, /from freva_client import databrowser/);
  assert.match(py, /\ndatabrowser\(/);
  assert.doesNotMatch(py, /db = /);
  assert.match(py, /model=\["A", "B"\]/);
  assert.doesNotMatch(py, /host=/);
  assert.doesNotMatch(py, /flavour=/);
});

test("parsePyConfig: tolerant multi-line/comma parse -> key=value tokens; drops host/time", async () => {
  const { parsePyConfig } = await import("../src/state.js");
  assert.equal(parsePyConfig('project="cordex"'), "project=cordex");
  assert.equal(
    parsePyConfig('project="cordex",\nproduct="was-44i"'),
    "project=cordex product=was-44i",
  );
  assert.equal(parsePyConfig('variable=["tas", "pr"]'), "variable=tas variable=pr");
  assert.equal(parsePyConfig("project: cordex"), "project=cordex"); // colon also accepted
  assert.equal(parsePyConfig('project="x",\nhost="https://h"'), "project=x"); // host dropped
});

test("tokenize: respects double-quoted runs and treats newlines as spaces", () => {
  assert.deepEqual(tokenize('a=1  b="two words"\nc=3'), ["a=1", "b=two words", "c=3"]);
});

test("parseFacetTokens: OR-merges repeats, lowercases keys, drops valueless/keyless tokens", () => {
  const m = parseFacetTokens("Project=cmip6 project=cmip5 bad nokeyhere= =noval Project=cmip6");
  assert.deepEqual(m, { project: ["cmip6", "cmip5"] });
});

test("escapeHtml: neutralises all five significant characters", () => {
  assert.equal(
    escapeHtml(`<img src=x onerror="alert('x')">&`),
    "&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;",
  );
});

test("buildFacets: primary order is API-driven, then the remaining keys", () => {
  const res: SearchResult = {
    total_count: 3,
    facets: { variable: ["tas", 2, "pr", 1], project: ["cmip6", 3], extra: ["x", 3] },
    primary_facets: ["project", "variable"],
    facet_mapping: { variable: "Variable" },
    search_results: [],
  };
  const facets = buildFacets(res);
  assert.deepEqual(
    facets.map((f) => f.key),
    ["project", "variable", "extra"],
  );
  assert.equal(facets[1].label, "Variable");
  // 'variable' is in KNOWN_LARGE -> hasMore even with a tiny sample
  assert.equal(facets[1].hasMore, true);
  assert.equal(facets[0].hasMore, false);
  assert.deepEqual(facets[0].values, [{ value: "cmip6", count: 3 }]);
});

test("metaFromFacetsBlock: empty [] = not applicable (skipped); single vs multi collapse", () => {
  const meta = metaFromFacetsBlock({
    variable: ["tas", 1],
    realm: [],
    sensor: ["a", 1, "b", 1],
  });
  assert.deepEqual(meta, { variable: "tas", sensor: ["a", "b"] });
  assert.ok(!("realm" in meta), "empty facet array is dropped");
});

test("shellQuote round-trip: a chosen value with whitespace parses back to one exact value", () => {
  const token = `ensemble=${shellQuote("not set")}`;
  assert.equal(token, 'ensemble="not set"', "whitespace value is quoted on insert");
  assert.deepEqual(
    parseFacetTokens(token),
    { ensemble: ["not set"] },
    "round-trips to a single token",
  );
  // a value without whitespace is left bare
  assert.equal(shellQuote("cmip6"), "cmip6");
});

test("facetQueryString: the real value 'not set' is sent verbatim, never as a negation", () => {
  const s = state();
  toggleSelected(s, "ensemble", "not set");
  const q = facetQueryString(s);
  assert.match(q, /(^|&)ensemble=not%20set(&|$)/, "value encoded verbatim");
  assert.doesNotMatch(q, /ensemble_not_/, "must not be misread as a negated key");
});

test("copied commands carry the base scope (fail-closed) - cli + python", async () => {
  const { cliCommand, pythonCommand } = await import("../src/state.js");
  const s = state({ baseFilters: { project: ["waterpark"] }, selected: { variable: ["tas"] } });
  const cli = cliCommand(s);
  assert.match(
    cli,
    /project=waterpark/,
    "CLI command carries the base scope, not just the user selection",
  );
  assert.match(cli, /variable=tas/, "and the user selection too");
  const py = pythonCommand(s);
  assert.match(py, /project=/, "Python command carries the base scope");
  assert.match(py, /waterpark/, "with the scope value");
});

test("timeRangeFromFilename: derives from filename, never fabricates", () => {
  assert.equal(
    timeRangeFromFilename("tas_day_MODEL_rcp85_r1i1p1_20060101-21001231.nc"),
    "2006-01-01 → 2100-12-31",
  );
  assert.equal(timeRangeFromFilename("pr_mon_MODEL_200601-210012.nc"), "2006-01 → 2100-12");
  assert.equal(timeRangeFromFilename("some_file_without_dates.nc"), null);
  // impossible calendar dates are not fabricated into a range
  assert.equal(timeRangeFromFilename("x_20240231-20240301.nc"), null, "Feb 31 rejected");
  assert.equal(timeRangeFromFilename("x_20240431-20240501.nc"), null, "Apr 31 rejected");
  assert.equal(timeRangeFromFilename("x_20230229-20230301.nc"), null, "non-leap Feb 29 rejected");
  assert.equal(
    timeRangeFromFilename("x_20240229-20240301.nc"),
    "2024-02-29 → 2024-03-01",
    "leap Feb 29 accepted",
  );
  // reversed ranges are rejected
  assert.equal(timeRangeFromFilename("x_21000101-20000101.nc"), null, "reversed range rejected");
});

test("parsePyConfig round-trips through the tokenizer without corrupting values", async () => {
  const { parsePyConfig, parseFacetTokens, pyKwargLines, createInitialState } =
    await import("../src/state.js");
  // direct edge cases
  assert.deepEqual(parseFacetTokens(parsePyConfig('ensemble="not set",')), {
    ensemble: ["not set"],
  });
  assert.deepEqual(parseFacetTokens(parsePyConfig('model="a,b"')), { model: ["a,b"] });
  assert.deepEqual(parseFacetTokens(parsePyConfig('x="foo\\"bar"')), { x: ['foo"bar'] });
  assert.deepEqual(parseFacetTokens(parsePyConfig('v=["a,b", "c"]')), { v: ["a,b", "c"] });
  // property: pyKwargLines -> parsePyConfig -> parseFacetTokens === state.selected
  const s = createInitialState({ apiBase: "/api", flavour: "freva" } as never);
  s.selected = {
    project: ["cordex"],
    ensemble: ["not set"],
    model: ["a,b"],
    variable: ["tas", "pr"],
  };
  assert.deepEqual(parseFacetTokens(parsePyConfig(pyKwargLines(s))), s.selected);
});

test("bbox is rounded at the source, so the query and the copied command agree", async () => {
  const { roundBbox, cliFixedTokens, pyFixedLines, createInitialState } =
    await import("../src/state.js");
  // what a map drag produces before rounding
  const raw = {
    minLon: -12.3456789,
    maxLon: 4.98765,
    minLat: 35.111119,
    maxLat: 60.5,
    mode: "flexible",
  };
  const b = roundBbox(raw as never);
  assert.deepEqual(
    { minLon: b!.minLon, maxLon: b!.maxLon, minLat: b!.minLat, maxLat: b!.maxLat },
    { minLon: -12.35, maxLon: 4.99, minLat: 35.11, maxLat: 60.5 },
    "rounded to 2 decimals (~1 km)",
  );
  assert.equal(roundBbox(null), null);
  // and because the rounding happens at the source, the rendered command carries no decimal noise
  const s = createInitialState({ apiBase: "/api", flavour: "freva" } as never);
  s.bbox = b;
  assert.doesNotMatch(cliFixedTokens(s), /\d\.\d{3,}/, "no long decimal tails in the CLI tokens");
  assert.doesNotMatch(pyFixedLines(s).join("\n"), /\d\.\d{3,}/, "nor in the python kwargs");
});

test("time/bbox are real tokens: parsed into state, not committed as fake facets", async () => {
  const { parseControlTokens, parseFacetTokens, terminalTokens, createInitialState } =
    await import("../src/state.js");
  const P = (t: string) => parseControlTokens(parseFacetTokens(t));

  // `bbox=10,1,1,1` must not fall through to the facet path and make a fake chip
  const bad = P("bbox=10,1,1,1");
  assert.equal(bad.bbox, null, "an invalid bbox is NOT accepted");
  assert.deepEqual(bad.rest, {}, "and it never reaches the facet path");
  assert.ok(bad.errors.length, "it explains why");

  const ok = P("project=cmip6 bbox=-10,10,35,60 bbox_select=strict");
  assert.deepEqual(ok.bbox, { minLon: -10, maxLon: 10, minLat: 35, maxLat: 60, mode: "strict" });
  assert.deepEqual(ok.rest, { project: ["cmip6"] }, "facets still flow to the facet path");

  // *_select defaults rather than silently guessing
  assert.equal(P("bbox=-10,10,35,60").bbox?.mode, "flexible", "bbox_select defaults to flexible");
  assert.equal(P('time="2000 TO 2010"').time?.mode, "flexible", "time_select defaults to flexible");
  assert.deepEqual(P('time="2000 TO 2010" time_select=file').time, {
    from: "2000",
    to: "2010",
    mode: "file",
  });

  // validation
  assert.ok(P("bbox=-10,10,35,600").errors.length, "latitude out of range is rejected");
  assert.ok(P("bbox=10,-10,35,60").errors.length, "minLon > maxLon is rejected");
  assert.ok(P("time=2000").errors.length, "time needs a TO range");
  // the terminal parser shares the editor's real-calendar validation + ordering check
  assert.ok(P('time="2025 TO 2000"').errors.length, "reversed range (from after to) is rejected");
  assert.equal(P('time="2025 TO 2000"').time, null, "reversed range does not commit");
  assert.ok(
    P('time="2023-02-31 TO 2023-03-01"').errors.length,
    "Feb 31 (impossible date) is rejected",
  );
  assert.ok(P('time="2000-99 TO 2001"').errors.length, "month 99 is rejected");
  assert.deepEqual(
    P('time="2000-02-29 TO 2001"').time,
    { from: "2000-02-29", to: "2001", mode: "flexible" },
    "a real leap day is accepted",
  );
  assert.equal(P('time="* TO 2010"').time?.from, "", "open start still allowed");
  // an early-year range must not appear reversed (0001 must not sort as 1901)
  assert.deepEqual(
    P('time="0001 TO 1000"').time,
    { from: "0001", to: "1000", mode: "flexible" },
    "early-year range is valid and in order",
  );
  assert.ok(
    P("bbox=-10,10,35,60 bbox_select=nonsense").errors.length,
    "unknown select mode is rejected",
  );

  // removable: dropping the token clears the selection
  assert.equal(P("project=cmip6").bbox, null, "no bbox token -> no bbox");
  assert.equal(P("project=cmip6").time, null, "no time token -> no time");

  // round-trip: state -> tokens -> state
  const s = createInitialState({ apiBase: "/api", flavour: "freva" } as never);
  s.selected = { project: ["cmip6"] };
  s.bbox = { minLon: -10, maxLon: 10, minLat: 35, maxLat: 60, mode: "flexible" };
  s.time = { from: "2000", to: "2010", mode: "strict" };
  const rt = P(terminalTokens(s));
  assert.deepEqual(rt.bbox, s.bbox, "bbox round-trips through the terminal text");
  assert.deepEqual(rt.time, s.time, "time round-trips too");
  assert.deepEqual(rt.rest, s.selected, "and the facets survive alongside them");
});

test("python round-trip keeps time/bbox (a focus+blur must not silently clear them)", async () => {
  const {
    parsePyConfig,
    parseControlTokens,
    parseFacetTokens,
    pyEditableLines,
    pythonCommand,
    createInitialState,
  } = await import("../src/state.js");
  const s = createInitialState({ apiBase: "/api", flavour: "freva" } as never);
  s.selected = { project: ["cmip6"] };
  s.time = { from: "2000", to: "2010", mode: "strict" };
  s.bbox = { minLon: -10, maxLon: 10, minLat: 35, maxLat: 60, mode: "file" };

  // what the python editor shows -> what a blur commits
  const back = parseControlTokens(parseFacetTokens(parsePyConfig(pyEditableLines(s))));
  assert.deepEqual(back.time, s.time, "time survives the python round-trip");
  assert.deepEqual(back.bbox, s.bbox, "bbox survives the python round-trip");
  assert.deepEqual(back.rest, s.selected, "and so do the facets");

  // the COPIED call must show the same query the tab shows
  const py = pythonCommand(s);
  assert.match(py, /time="2000 TO 2010"/, "copied python carries time");
  assert.match(py, /time_select="strict"/);
  assert.match(py, /bbox="-10,10,35,60"/, "copied python carries bbox");
  assert.match(py, /bbox_select="file"/);
  assert.match(py, /project="cmip6"/);
});

test("open-ended time ranges round-trip canonically (never a literal *)", async () => {
  const {
    terminalTokens,
    parseControlTokens,
    parseFacetTokens,
    facetQueryString,
    createInitialState,
  } = await import("../src/state.js");
  const s = createInitialState({ apiBase: "/api", flavour: "freva" } as never);
  s.time = { from: "", to: "2010", mode: "flexible" };
  const text = terminalTokens(s);
  assert.doesNotMatch(text, /\*/, "the terminal shows the canonical open bound, not a literal *");
  assert.match(text, /time="1 TO 2010"/, "same form the query and the copied command already use");
  // and a user typing the Solr-style * gets an OPEN bound, not the literal character
  const parsed = parseControlTokens(parseFacetTokens('time="* TO 2010"'));
  assert.deepEqual(
    parsed.time,
    { from: "", to: "2010", mode: "flexible" },
    "* becomes an open bound",
  );
  const s2 = createInitialState({ apiBase: "/api", flavour: "freva" } as never);
  s2.time = parsed.time;
  assert.doesNotMatch(facetQueryString(s2), /%2A|\*/, "no literal * ever reaches the query");
});

test("per-file extent: Solr ENVELOPE + time range parse (absent -> keep the default)", async () => {
  const { parseEnvelope, parseSolrTimeRange } = await import("../src/state.js");
  // exactly what the API returns for a GLOBAL store - note the 0…360 longitude convention, which
  // must be normalised to -180…180 or the map paints only the eastern half.
  assert.deepEqual(
    parseEnvelope(["ENVELOPE(0, 360, 90, -90)"]),
    { minLon: -180, maxLon: 180, minLat: -90, maxLat: 90 },
    "global 0…360 -> -180…180",
  );
  assert.deepEqual(parseEnvelope("ENVELOPE(-10,10,60,35)"), {
    minLon: -10,
    maxLon: 10,
    minLat: 35,
    maxLat: 60,
  });
  assert.equal(
    parseSolrTimeRange("[0001-01-01T00:00:00 TO 9999-12-31T23:59:00]"),
    "0001-01-01 → 9999-12-31",
  );
  // absent / unparseable -> null, so the caller keeps whatever default it had
  assert.equal(parseEnvelope(undefined), null);
  assert.equal(parseEnvelope([]), null);
  assert.equal(parseEnvelope("nonsense"), null);
  assert.equal(parseSolrTimeRange(undefined), null);
  assert.equal(parseSolrTimeRange("not a range"), null);
});

test("bbox longitudes are normalised: 0…360 conventions, global extents, antimeridian wraps", async () => {
  const { normalizeBboxLon } = await import("../src/state.js");
  const N = (minLon: number, maxLon: number, minLat = -90, maxLat = 90) =>
    normalizeBboxLon({ minLon, maxLon, minLat, maxLat });

  // the case from the API: a global zarr store, published as 0…360
  const g = N(0, 360);
  assert.equal(g.global, true, "a full 360° sweep is global, whatever the convention");
  assert.deepEqual([g.minLon, g.maxLon], [-180, 180], "and is drawn edge to edge");
  assert.equal(N(-180, 180).global, true, "the same box in the -180…180 convention is global too");

  // an eastern-hemisphere box in the 0…360 convention
  const e = N(200, 300);
  assert.deepEqual([e.minLon, e.maxLon], [-160, -60], "0…360 longitudes shift into -180…180");
  assert.equal(e.wraps, false);

  // a box straddling the dateline must be flagged (it paints as TWO rectangles, not one)
  const w = N(150, 210);
  assert.deepEqual([w.minLon, w.maxLon], [150, -150]);
  assert.equal(w.wraps, true, "crossing the antimeridian is detected");

  // an ordinary box is left alone
  const o = N(-10, 10, 35, 60);
  assert.deepEqual([o.minLon, o.maxLon, o.global, o.wraps], [-10, 10, false, false]);
});

test("flavour maps: builder + selection re-keying pivots through freva (cmip6 model⇄source_id)", () => {
  const maps = buildFlavourMaps([
    {
      flavour_name: "freva",
      mapping: { project: "project", model: "model", variable: "variable" },
    },
    {
      flavour_name: "cmip6",
      mapping: { project: "mip_era", model: "source_id", variable: "variable_id" },
    },
    { flavour_name: "bad", mapping: null as unknown as Record<string, string> }, // skipped, not thrown
  ]);
  assert.equal(maps.cmip6.forward.model, "source_id", "freva->cmip6");
  assert.equal(maps.cmip6.backward.source_id, "model", "cmip6->freva");
  assert.ok(!("bad" in maps), "malformed entry skipped");

  const st = createInitialState({} as ResolvedConfig);
  st.flavourMaps = maps;
  // freva -> cmip6
  assert.equal(translateKey(st, "model", "freva", "cmip6"), "source_id");
  // cmip6 -> freva
  assert.equal(translateKey(st, "source_id", "cmip6", "freva"), "model");
  // a key with no mapping passes through (flavour-specific / unknown)
  assert.equal(translateKey(st, "rcm_name", "freva", "cmip6"), "rcm_name");
  // whole selection re-keyed, values untouched
  assert.deepEqual(
    translateSelection(st, { model: ["icon"], variable: ["tas"] }, "freva", "cmip6"),
    { source_id: ["icon"], variable_id: ["tas"] },
  );
});

test("URL deep-link: build/parse round-trips flavour + facets + time + bbox", () => {
  const st = createInitialState({} as ResolvedConfig);
  st.flavour = "cmip6";
  st.selected = { mip_era: ["waterpark"], source_id: ["icon", "mpi"] };
  st.time = { from: "2000", to: "2010", mode: "flexible" };
  st.bbox = { minLon: -10, maxLon: 10, minLat: -5, maxLat: 5, mode: "strict" };

  const q = buildUrlQuery(st);
  assert.match(q, /flavour=cmip6/, "flavour encoded");
  assert.match(q, /mip_era=waterpark/, "flavour-named facet encoded");

  const parsed = parseUrlQuery(q);
  assert.equal(parsed.flavour, "cmip6");
  assert.deepEqual(
    parsed.selected,
    { mip_era: ["waterpark"], source_id: ["icon", "mpi"] },
    "multi-value facets round-trip",
  );
  assert.deepEqual(parsed.time, { from: "2000", to: "2010", mode: "flexible" });
  assert.deepEqual(parsed.bbox, { minLon: -10, maxLon: 10, minLat: -5, maxLat: 5, mode: "strict" });

  // a bare freva link omits the flavour param and still parses
  const freva = parseUrlQuery("project=icdc");
  assert.equal(freva.flavour, null, "no flavour param -> default (freva)");
  assert.deepEqual(freva.selected, { project: ["icdc"] });
});

test("baseFilters: filterCommittable rejects a gated key so the terminal cannot set the scope", () => {
  const st = createInitialState({} as ResolvedConfig);
  st.attributeKeys = ["project", "variable"];
  st.baseFilters = { project: ["waterpark"] };
  const r = filterCommittable(st, { project: ["other"], variable: ["tas"] });
  assert.ok(!("project" in r.accepted), "the gated key is rejected from terminal input");
  assert.deepEqual(r.accepted.variable, ["tas"], "a non-gated key still commits");
});

test("baseFilters: the wire query drops a stray same-key selection, keeping only the gate (defense in depth)", () => {
  const st = createInitialState({} as ResolvedConfig);
  st.baseFilters = { project: ["waterpark"] };
  st.selected = { project: ["other"], variable: ["tas"] }; // a stray gated selection from any bypass
  const q = facetQueryString(st);
  assert.match(q, /project=waterpark/, "the gate value is on the wire");
  assert.ok(!/project=other/.test(q), "the stray user value on the gated key is dropped");
  assert.match(q, /variable=tas/, "a non-gated selection is retained");
});
