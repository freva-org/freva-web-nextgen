// Per-session setup choices and the notebook, as configuration: the policy a page's chooser
// validates against, the diagnostics for a policy that cannot be honoured (each at the key that
// is wrong), the agreement check that keeps one page's chooser single, and the materials and
// network policy covering every allowed setup rather than only the default one.

import { validateSetup } from "@freva-org/browser-python/session";
import { describe, expect, it } from "vitest";
import { notebookSeedPath as clientSeedPath } from "../../client/notebook-paths.js";
import type { RawPythonPlaygroundBase } from "../../src/config/types.js";
import { DiagnosticBag } from "../../src/diagnostics.js";
import { notebookSeedPath, planNotebook } from "../../src/model/notebook.js";
import { planPythonMaterials } from "../../src/model/python-materials.js";
import {
  allowedAddons,
  checkPlaygroundAgreement,
  resolvePlaygroundSettings,
  sessionPolicyOf,
} from "../../src/model/python-playground.js";
import type { PlaygroundArtifactData, PlaygroundSettings } from "../../src/model/types.js";

const WHERE = { file: "portal.yaml", pointer: "/pythonPlayground" };

function resolve(raw: Partial<RawPythonPlaygroundBase>): {
  settings: PlaygroundSettings | undefined;
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

const CHOICES = {
  profiles: {
    minimal: {},
    "xarray-zarr": { allowedAddons: ["dask", "cartopy-natural-earth-110m"] },
  },
  allowSkipStarter: true,
};

describe("without sessionChoices", () => {
  it("resolves exactly what it did before: no policy, live sessions = sessions, no notebook", () => {
    const { settings, bag } = resolve({ addons: ["dask"] });
    expect(bag.errors).toEqual([]);
    expect(settings?.sessionChoices).toBeUndefined();
    expect(settings?.notebook).toBe(false);
    expect(settings?.maxLiveSessions).toBe(settings?.maxSessions);
    // The implicit policy is the one configured setup.
    const policy = sessionPolicyOf(settings!);
    expect(Object.keys(policy.profiles)).toEqual(["xarray-zarr"]);
    expect(validateSetup(policy, policy.defaults).ok).toBe(true);
    const notebook = resolve({
      addons: ["dask"],
      playgroundOrigin: "https://py.example.org",
      notebook: { enabled: true },
    }).settings!;
    const plan = planNotebook(notebook, {
      origin: "https://py.example.org",
      hostOrigin: "https://portal.example.org",
      profile: "xarray-zarr",
      protocolVersion: 3,
      runtimeIndexUrl: "https://py.example.org/pyodide/",
      examples: [],
    } as PlaygroundArtifactData);
    expect(plan.settings.setups).toEqual([
      expect.objectContaining({ id: "default", profile: "xarray-zarr", addons: ["dask"] }),
    ]);
  });
});

describe("sessionChoices", () => {
  it("builds the policy, its fingerprint and the default setup", () => {
    const { settings, bag } = resolve({
      addons: ["dask"],
      initialSource: "import xarray",
      sessionChoices: CHOICES,
    });
    expect(bag.errors).toEqual([]);
    const choices = settings!.sessionChoices!;
    expect(choices.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(choices.policy).toMatchObject({
      profiles: {
        minimal: { allowedAddons: [] },
        "xarray-zarr": { allowedAddons: ["cartopy-natural-earth-110m", "dask"] },
      },
      starter: true,
      starterProfiles: ["xarray-zarr"],
      allowSkipStarter: true,
      defaults: { profile: "xarray-zarr", addons: ["dask"], runStarter: true, frontend: "console" },
    });
    expect(validateSetup(choices.policy, choices.policy.defaults).ok).toBe(true);
    expect(
      validateSetup(choices.policy, {
        profile: "minimal",
        addons: [],
        runStarter: false,
        frontend: "console",
      }).ok,
    ).toBe(true);
  });

  it.each([
    [
      "an unknown profile",
      { profiles: { conda: {}, "xarray-zarr": {} } },
      "/pythonPlayground/sessionChoices/profiles/conda",
      /'conda' is not a profile/,
    ],
    [
      "an add-on on a profile it does not work with",
      { profiles: { minimal: { allowedAddons: ["dask"] }, "xarray-zarr": {} } },
      "/pythonPlayground/sessionChoices/profiles/minimal/allowedAddons/0",
      /'dask' add-on does not work with the 'minimal' profile/,
    ],
    [
      "a policy without the configured profile",
      { profiles: { minimal: {} } },
      "/pythonPlayground/sessionChoices/profiles",
      /does not offer the configured profile 'xarray-zarr'/,
    ],
    [
      "starter profiles that are not offered",
      { profiles: { "xarray-zarr": {} }, starterProfiles: ["minimal"] },
      "/pythonPlayground/sessionChoices/starterProfiles/0",
      /names 'minimal', which sessionChoices does not offer/,
    ],
  ])("refuses %s, at the key", (_name, sessionChoices, pointer, message) => {
    const { bag } = resolve({ initialSource: "x = 1", sessionChoices: sessionChoices as never });
    const found = bag.errors.find((d) => d.pointer === pointer);
    expect(found?.code).toBe("FP1219");
    expect(found?.message).toMatch(message);
  });

  it("refuses a configured add-on the policy does not allow, at the add-on", () => {
    const { bag } = resolve({
      addons: ["dask"],
      sessionChoices: { profiles: { "xarray-zarr": {} } },
    });
    expect(bag.errors.map((d) => [d.pointer, d.code])).toEqual([
      ["/pythonPlayground/addons/0", "FP1219"],
    ]);
  });

  it("refuses starter profiles without starter code", () => {
    const { bag } = resolve({
      sessionChoices: { profiles: { "xarray-zarr": {} }, starterProfiles: ["xarray-zarr"] },
    });
    expect(bag.errors[0]?.message).toMatch(/there is no initialSource/);
  });

  it("caps live sessions at the session count", () => {
    expect(
      resolve({ maxSessions: 1, resources: { maxLiveSessions: 2 } }).settings?.maxLiveSessions,
    ).toBe(1);
    expect(
      resolve({ maxSessions: 2, resources: { maxLiveSessions: 1 } }).settings?.maxLiveSessions,
    ).toBe(1);
  });

  it("covers the union of allowed setups in the prepared materials", () => {
    const { settings } = resolve({ sessionChoices: CHOICES });
    expect(allowedAddons(settings!)).toEqual(["cartopy-natural-earth-110m", "dask"]);
    const plan = planPythonMaterials(settings!);
    expect(plan.addons).toEqual(["cartopy-natural-earth-110m", "dask"]);
    expect(plan.needsWheelhouse).toBe(false);
    const freva = resolve({
      sessionChoices: { profiles: { "xarray-zarr": {}, "freva-client": {} } },
    });
    expect(planPythonMaterials(freva.settings!).needsWheelhouse).toBe(true);
    // The package index a freva-client session installs from is in the page's policy too.
    expect(freva.settings!.packagePolicy.packageIndex).toBe(true);
  });
});

describe("the page's one playground (FP1215)", () => {
  it("compares the choice policy, the notebook and the live-session limit", () => {
    const a = resolve({ sessionChoices: CHOICES }).settings!;
    const b = resolve({}).settings!;
    const bag = new DiagnosticBag();
    checkPlaygroundAgreement(
      [
        { describe: "the portal's pythonPlayground", pointer: "/a", settings: a },
        { describe: "a dataset tree", pointer: "/b", settings: b },
      ],
      "portal.yaml",
      bag,
    );
    expect(bag.errors.map((d) => d.code)).toEqual(["FP1215"]);
    expect(bag.errors[0]?.message).toMatch(/'sessionChoices'/);
  });
});

describe("the notebook", () => {
  it("requires the playground's own origin (FP1235)", () => {
    const { settings, bag } = resolve({ notebook: { enabled: true } });
    expect(bag.errors.map((d) => [d.code, d.pointer])).toEqual([
      ["FP1235", "/pythonPlayground/notebook/enabled"],
    ]);
    expect(settings?.notebook).toBe(false);
  });

  it("offers one kernel per allowed setup, the default first, and a seed per example", () => {
    const { settings } = resolve({
      addons: ["dask"],
      initialSource: "import xarray",
      playgroundOrigin: "https://py.example.org",
      notebook: { enabled: true },
      sessionChoices: { profiles: { minimal: {}, "xarray-zarr": { allowedAddons: ["dask"] } } },
    });
    expect(settings?.notebook).toBe(true);
    const playground = {
      origin: "https://py.example.org",
      hostOrigin: "https://portal.example.org",
      profile: "xarray-zarr",
      protocolVersion: 3,
      runtimeIndexUrl: "https://py.example.org/pyodide/",
      examples: [
        {
          id: "a",
          title: "Open a store",
          source: "import xarray\nxarray.__version__\n",
          sha256: "ab".repeat(32),
        },
        {
          id: "b",
          title: "Same source",
          source: "import xarray\nxarray.__version__\n",
          sha256: "ab".repeat(32),
        },
      ],
    } as PlaygroundArtifactData;
    const plan = planNotebook(settings!, playground);
    const setups = plan.settings.setups as {
      id: string;
      profile: string;
      addons: string[];
      runStarter: boolean;
    }[];
    expect(setups.map((s) => s.id)).toEqual(["default", "minimal-no-starter", "xarray-zarr"]);
    expect(setups[0]).toMatchObject({ profile: "xarray-zarr", addons: ["dask"], runStarter: true });
    expect(plan.settings).toMatchObject({ maxLiveInterpreters: 2, starter: "import xarray" });
    expect(plan.seeds.map((s) => s.name)).toEqual([notebookSeedPath("ab".repeat(32))]);
    const notebook = JSON.parse(plan.seeds[0]!.text);
    expect(notebook.nbformat).toBe(4);
    expect(notebook.cells[1]).toMatchObject({
      cell_type: "code",
      outputs: [],
      execution_count: null,
    });
    expect(notebook.cells[1].source.join("")).toBe("import xarray\nxarray.__version__\n");
    expect(plan.settingsSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("names a seed the same way in the build and in the portal's window", () => {
    const digest = "0123456789abcdef".repeat(4);
    expect(clientSeedPath(digest)).toBe(notebookSeedPath(digest));
  });
});
