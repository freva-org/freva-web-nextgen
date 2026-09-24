// The Data Browser's shaping options, from `portal.yaml` to the widget. A gap between the two
// packages is invisible to either one's tests: the widget takes deployment-facing options - which
// view to land on, how to compose the overview, whether a fixed scope may be taken off - while
// the portal's component surface passes a fixed list of keys, everything type-checks, every suite
// passes, and a portal cannot ask for any of them. So these tests walk the WHOLE path each time:
// schema -> resolved model -> runtime projection -> the values the island mounts with. A test
// that stops at the model passes throughout.
//
// The second half is `defaultFlavour`. A flavour is a lens a deployment's own freva-rest instance
// serves - the widget types it as a plain string for that reason - so a closed enum in the portal
// schema leaves a portal whose backend serves `waterpark` unable to name it.

import { afterAll, describe, expect, it } from "vitest";
import {
  cleanupFixtures,
  codes,
  messages,
  resolveFixture,
  tempRoot,
  writeSite,
} from "../helpers/fixture.js";
import { generateEntryModule, projectRuntime } from "../../src/artifact/runtime-projection.js";
import type { DatabrowserOptions } from "../../src/model/types.js";

afterAll(cleanupFixtures);

/** The component + service stanza every fixture here needs, with `options` spliced in. */
const site = (options: string): string => `services:
  dataApi:
    kind: databrowser
    baseUrl: https://api.example.org/api/freva-nextgen/databrowser
    authentication: none
components:
  data:
    kind: databrowser
    enabled: true
    service: dataApi
    route: /data
${options}
`;

async function resolved(optionsYaml: string) {
  const root = tempRoot("db-options");
  writeSite(root, { extra: site(optionsYaml) });
  return resolveFixture(root);
}

/** The whole path in one call: resolve, project, and hand back both ends. */
async function projected(optionsYaml: string) {
  const result = await resolved(optionsYaml);
  expect(messages(result).match(/^FP11\d\d .*/gm) ?? []).toEqual([]);
  const model = result.model;
  expect(model).toBeDefined();
  const projection = projectRuntime(model!);
  const component = model!.enabledComponents.find((c) => c.kind === "databrowser");
  return { options: component!.options as DatabrowserOptions, runtime: projection.databrowser! };
}

describe("databrowser options reach the widget", () => {
  it("a portal that states none of them gets exactly today's behaviour", async () => {
    const { options, runtime } = await projected("");
    // Every default is the widget's own, so an existing portal.yaml builds byte-identically.
    expect(options).toMatchObject({
      defaultFlavour: "freva",
      fixedFacets: {},
      defaultLayout: "browse",
      overview: { order: [], mainFacets: null },
      scopeRemovable: false,
    });
    expect(runtime.defaultLayout).toBe("browse");
    expect(runtime.overview.mainFacets).toBeNull();
    expect(runtime.scopeRemovable).toBe(false);
  });

  it("carries the deployment's own composition through to the runtime", async () => {
    // Verbatim from the deployment that asked for this.
    const { runtime } = await projected(`    options:
      fixedFacets: { project: waterpark }
      defaultLayout: overview
      overview:
        mainFacets: [product, variable, time_frequency, healpix_level, experiment,
                     model, realm, ensemble, time_aggregation, __time, __bbox]
        order:      [product, variable, time_frequency, healpix_level, experiment,
                     model, realm, ensemble, time_aggregation, __time, __bbox]`);
    expect(runtime.fixedFacets).toEqual({ project: "waterpark" });
    expect(runtime.defaultLayout).toBe("overview");
    expect(runtime.overview.order[0]).toBe("product");
    // The two blocks that are not facets order in the same flow as the facets.
    expect(runtime.overview.order.slice(-2)).toEqual(["__time", "__bbox"]);
    expect(runtime.overview.mainFacets).toContain("healpix_level");
    // `project` is the locked scope, so it is deliberately NOT a main block: it belongs under
    // "Show additional facets" rather than occupying the first one.
    expect(runtime.overview.mainFacets).not.toContain("project");
  });

  it("…and reaches the generated island entry, not just the model", async () => {
    // The load-bearing link: the model knowing a value and the island mounting with it are
    // different facts, and everything upstream type-checks either way. The entry module is where
    // the projection becomes code, so this is where "the portal can ask for it" becomes true.
    const result = await resolved(`    options:
      fixedFacets: { project: waterpark }
      defaultLayout: overview
      overview:
        mainFacets: [product, variable, healpix_level, __time, __bbox]
        order: [product, variable, healpix_level, __time, __bbox]`);
    const entry = generateEntryModule(result.model!);
    expect(entry).toMatch(/"defaultLayout":\s*"overview"/);
    expect(entry).toContain("healpix_level");
    expect(entry).toContain("__bbox");
    expect(entry).toMatch(/"project":\s*"waterpark"/);
    expect(entry).toContain("mountDatabrowserIsland(RUNTIME.databrowser");
  });

  it("scopeRemovable is opt-in and travels on its own", async () => {
    const { runtime } = await projected(`    options:
      fixedFacets: { project: waterpark }
      scopeRemovable: true`);
    expect(runtime.scopeRemovable).toBe(true);
    expect(runtime.defaultLayout).toBe("browse"); // untouched by the option beside it
  });

  it("rejects a layout that is not one of the two views, and points at the line", async () => {
    const result = await resolved(`    options:
      defaultLayout: sideways`);
    const bad = result.diagnostics.items.find(
      (d) => d.code === "FP1104" && (d.pointer ?? "").endsWith("/defaultLayout"),
    );
    // The pointer is the useful half: with three components in a file, a message that only says
    // what the value must be does not say which line to change.
    expect(bad, messages(result)).toBeDefined();
    expect(bad!.message).toMatch(/"browse"/);
    expect(bad!.file).toBe("portal.yaml");
  });

  it("rejects a block key that could not be a facet", async () => {
    const result = await resolved(`    options:
      overview:
        order: ["Product Name"]`);
    expect(codes(result.diagnostics)).toContain("FP1104");
  });

  it("rejects an option the widget has no meaning for", async () => {
    const result = await resolved(`    options:
      overviewOrder: [project]`);
    expect(codes(result.diagnostics)).toContain("FP1104");
  });
});

describe("defaultFlavour names a lens the deployment's own service serves", () => {
  it("accepts a flavour this schema has never heard of", async () => {
    // `waterpark` is in no list here and does not need to be: flavours are a property of the
    // freva-rest instance, and the widget types them as `string`.
    const { runtime } = await projected(`    options:
      defaultFlavour: waterpark`);
    expect(runtime.flavour).toBe("waterpark");
  });

  it("still accepts every name the old closed list allowed", async () => {
    for (const flavour of ["freva", "cmip6", "cmip5", "cordex", "nextgems", "user", "default"]) {
      const { runtime } = await projected(`    options:\n      defaultFlavour: ${flavour}`);
      expect(runtime.flavour).toBe(flavour);
    }
  });

  it("still rejects something that could not be an identifier", async () => {
    // Opened, not abandoned: a typo, a path or an injected string is still caught.
    for (const bad of ["Waterpark", "water park", "../etc/passwd", ""]) {
      const result = await resolved(`    options:\n      defaultFlavour: ${JSON.stringify(bad)}`);
      expect(codes(result.diagnostics), `should reject ${JSON.stringify(bad)}`).toContain("FP1104");
    }
  });
});
