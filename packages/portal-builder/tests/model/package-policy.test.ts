// Where a playground may fetch a package from, and the one place that answer is written. A help
// panel advertising `await micropip.install("name")` and naming PyPI, beside a
// Content-Security-Policy that names the runtime, the services and the data origins and no
// package index, documents a capability the policy forbids: the command fails at metadata lookup
// with `ValueError: Can't fetch metadata for …`, raised BEFORE wheel compatibility is considered,
// so the visitor is not even told the honest thing.
//
// The answer is not a wider policy but one value: `resolvePackagePolicy` produces the origins,
// and that single result writes the parent `connect-src`, the separate-origin child's
// `connect-src`, and the page configuration the help panel renders from. So this checks that the
// value is right, that a public package index cannot enter it by any configured route, and that
// the refusal is a build error naming the field rather than a silent drop.
//
// What lands in `host-policy.json` and the child's `deploy.json` is checked from built bytes in
// `tests/artifact/package-policy.test.ts`, because a guarantee about what a browser will permit
// is a guarantee about files.

import { describe, expect, it } from "vitest";
import { DEFAULT_PYODIDE_INDEX_URL } from "@freva-org/browser-python";
import { DiagnosticBag } from "../../src/diagnostics.js";
import {
  REFUSED_PACKAGE_ORIGINS,
  isRefusedPackageOrigin,
  resolvePackagePolicy,
} from "../../src/model/package-policy.js";
import { resolvePlaygroundSettings } from "../../src/model/python-playground.js";
import type { RawPythonPlaygroundBase } from "../../src/config/types.js";

const WHERE = { file: "landings/home.yaml", pointer: "/pythonPlayground" };

function resolve(raw: Partial<RawPythonPlaygroundBase>): {
  settings: ReturnType<typeof resolvePlaygroundSettings>;
  bag: DiagnosticBag;
} {
  const bag = new DiagnosticBag();
  const settings = resolvePlaygroundSettings(
    { enabled: true, profile: "xarray-zarr", ...raw } as RawPythonPlaygroundBase,
    WHERE,
    bag,
  );
  return { settings, bag };
}

const runtimeOrigin = new URL(DEFAULT_PYODIDE_INDEX_URL).origin;

describe("1. the resolved policy", () => {
  it("is curated, and names the pinned runtime when a deployment mirrors nothing", () => {
    const policy = resolvePackagePolicy({}, DEFAULT_PYODIDE_INDEX_URL);
    expect(policy.kind).toBe("curated");
    expect(policy.origins).toEqual([runtimeOrigin]);
    expect(policy.sources.runtime).toBe(runtimeOrigin);
    // Absent rather than defaulted to the runtime's origin: otherwise the help panel says
    // "wheels from …" about a directory a `minimal` portal never fetches from.
    expect(policy.sources.wheelhouse).toBeUndefined();
    expect(policy.sources.addons).toBeUndefined();
  });

  it("collapses three directories on one host into one origin, sorted and deduplicated", () => {
    const policy = resolvePackagePolicy(
      {
        runtimeIndexUrl: "https://static.example.org/pyodide/",
        wheelhouseUrl: "https://static.example.org/python-wheels/",
        addonBaseUrl: "https://static.example.org/python-addons/",
      },
      DEFAULT_PYODIDE_INDEX_URL,
    );
    expect(policy.origins).toEqual(["https://static.example.org"]);
    // The SOURCES still distinguish them, because the help panel says them in words.
    expect(policy.sources).toEqual({
      runtime: "https://static.example.org",
      wheelhouse: "https://static.example.org",
      addons: "https://static.example.org",
    });
  });

  it("carries every distinct host, in a stable order", () => {
    const policy = resolvePackagePolicy(
      {
        runtimeIndexUrl: "https://runtime.example.org/pyodide/",
        wheelhouseUrl: "https://b-wheels.example.org/w/",
        addonBaseUrl: "https://a-addons.example.org/a/",
      },
      DEFAULT_PYODIDE_INDEX_URL,
    );
    expect(policy.origins).toEqual([
      "https://a-addons.example.org",
      "https://b-wheels.example.org",
      "https://runtime.example.org",
    ]);
    // Sorted, so one input produces one artifact whatever order the fields were read in.
    expect([...policy.origins].sort()).toEqual(policy.origins);
  });
});

describe("2. a public package index cannot get into the policy", () => {
  it("names the three that are refused outright", () => {
    expect([...REFUSED_PACKAGE_ORIGINS]).toEqual([
      "https://pypi.org",
      "https://files.pythonhosted.org",
      "https://test.pypi.org",
    ]);
    for (const origin of REFUSED_PACKAGE_ORIGINS) expect(isRefusedPackageOrigin(origin)).toBe(true);
    expect(isRefusedPackageOrigin("https://static.example.org")).toBe(false);
  });

  for (const field of ["runtimeIndexUrl", "wheelhouseUrl", "addonBaseUrl"] as const) {
    it(`drops it from the origins when '${field}' names one, whatever a deployment wrote`, () => {
      const policy = resolvePackagePolicy(
        { [field]: "https://files.pythonhosted.org/packages/" },
        DEFAULT_PYODIDE_INDEX_URL,
      );
      expect(policy.origins).not.toContain("https://files.pythonhosted.org");
      // The runtime is not optional: a policy with no runtime origin gives a page whose
      // interpreter cannot load at all, which is a second, more confusing failure.
      expect(policy.origins).toContain(runtimeOrigin);
    });

    it(`refuses it as a build ERROR naming '${field}', rather than dropping it silently`, () => {
      const { bag } = resolve({ [field]: "https://pypi.org/simple/" });
      const refusal = bag.errors.find((d) => d.message.includes(field));
      expect(refusal, `no error mentioned ${field}`).toBeDefined();
      expect(refusal?.code).toBe("FP1219");
      expect(refusal?.message).toContain("public package index");
      expect(refusal?.pointer).toBe(`/pythonPlayground/${field}`);
      // …and it says what to do instead, because "refused" without a next step is a dead end.
      expect(refusal?.hint).toMatch(/prepare-runtime|prepare-freva-wheelhouse|prepare-addons/);
    });
  }

  it("refuses a package index smuggled in through connectOrigins", () => {
    // The door an index would actually come in through. `connectOrigins` is for the services a
    // snippet legitimately reads - a Freva instance, an S3 archive - and lands verbatim in
    // `connect-src`, so naming an index here turns the documented refusal into arbitrary
    // visitor-chosen code running with this origin's authority.
    const { settings, bag } = resolve({
      connectOrigins: ["https://freva.example.org", "https://pypi.org"],
    });
    expect(settings?.connectOrigins).toEqual(["https://freva.example.org"]);
    const refusal = bag.errors.find((d) => d.message.includes("pypi.org"));
    expect(refusal?.code).toBe("FP1219");
    expect(refusal?.message).toContain("public package index");
  });

  it("still refuses the other shapes of not-an-origin", () => {
    const { settings, bag } = resolve({
      connectOrigins: ["https://*.example.org", "http://plain.example.org", "https:"],
    });
    expect(settings?.connectOrigins).toEqual([]);
    expect(bag.errors.length).toBeGreaterThanOrEqual(3);
  });
});

describe("3. the settings a portal is resolved to", () => {
  it("carry the policy, so the page and the header are written from one value", () => {
    const { settings } = resolve({
      wheelhouseUrl: "https://wheels.example.org/python-wheels/",
    });
    expect(settings?.packagePolicy.kind).toBe("curated");
    expect(settings?.packagePolicy.origins).toEqual(
      ["https://wheels.example.org", runtimeOrigin].sort(),
    );
    expect(settings?.packagePolicy.sources.wheelhouse).toBe("https://wheels.example.org");
  });

  it("has exactly one kind, so a public-index mode has to be a reviewed second value", () => {
    const { settings } = resolve({});
    // Documented, not implemented - see docs/python-playground.md.
    expect(settings?.packagePolicy.kind).toBe("curated");
  });
});
