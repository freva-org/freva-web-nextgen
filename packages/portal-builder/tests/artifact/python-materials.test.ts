// The Python playground's materials: as a build input, in the artifact, and under `verify`. A
// portal with no supported way to declare wheels and add-on artefacts gets them copied in by a
// deployment script AFTER the builder has written `checksums.sha256`, and the artifact's own
// verifier correctly refuses them:
//
//     error FP1603 freva-wheels/…whl: … is in the artifact but not in checksums.sha256.
//
// So the claims worth checking are not "the files are there" but: the files are there AND the
// manifests know about them AND `verify` passes AND removing or altering one makes it fail. A
// suite asserting only presence passes on the broken arrangement too.
//
// The materials are REAL, prepared by the shipped preparer (see `preparedPythonMaterials`),
// because the mechanism under test is digest verification and invented bytes verify nothing.

import { createHash } from "node:crypto";
import { appendFileSync, cpSync, existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupFixtures, tempRoot } from "../helpers/fixture.js";
import { PYTHON_MATERIALS, PYTHON_MATERIALS_PLAN, buildFixture } from "../helpers/site.js";
import { writeConsumerSite } from "../helpers/consumer.js";
import { verifyArtifact } from "../../src/verify/verify.js";
import {
  planPythonMaterials,
  pythonMaterialsCacheKey,
  verifyPythonMaterials,
} from "../../src/model/python-materials.js";
import type { BuildResult } from "../../src/artifact/index.js";

afterAll(cleanupFixtures);

// A checkout that has never prepared the add-on directory skips rather than fails, as the STAC
// suites do. `npm run --workspace @freva-org/browser-python prepare:addons` fills it.
const describeWithMaterials = PYTHON_MATERIALS ? describe : describe.skip;

async function build(
  options: Parameters<typeof writeConsumerSite>[0],
  prefix: string,
  materials?: string,
): Promise<{ out: string; result: BuildResult }> {
  const root = writeConsumerSite(options);
  const out = join(tempRoot(prefix), "site");
  return {
    out,
    result: await buildFixture(root, out, materials ? { pythonMaterials: materials } : {}),
  };
}

/** The portal these tests build: exactly what the shared materials directory was prepared for. */
const CONFIG = {
  playground: {
    profile: PYTHON_MATERIALS_PLAN.profile,
    addons: [...PYTHON_MATERIALS_PLAN.addons],
  },
  runnableDocs: true,
  pages: 1,
};

describe("1. the plan, which is what preparation and verification both read", () => {
  it("derives what a configuration needs, and nothing it does not", () => {
    const minimal = planPythonMaterials({
      profile: "minimal",
      addons: [],
      optionalAddons: [],
    } as never);
    expect(minimal.needsWheelhouse).toBe(false);
    expect(minimal.files).toEqual([]);

    // A wheelhouse is a property of the PROFILE, not of whether a URL was configured.
    const freva = planPythonMaterials({
      profile: "freva-client",
      addons: [],
      optionalAddons: [],
    } as never);
    expect(freva.needsWheelhouse).toBe(true);
    expect(freva.files.every((f) => f.path.startsWith("freva-wheels/"))).toBe(true);

    const withAddon = planPythonMaterials({
      profile: "xarray-zarr",
      addons: ["dask"],
      optionalAddons: [],
    } as never);
    expect(withAddon.needsWheelhouse).toBe(false);
    expect(withAddon.files.some((f) => f.path.includes("dask-"))).toBe(true);
    // The other add-on was not asked for, so none of its data is in the plan.
    expect(withAddon.files.some((f) => f.path.includes("cartopy"))).toBe(false);
  });

  it("says whether the runtime stays on the pinned CDN or is mirrored", () => {
    expect(
      planPythonMaterials({ profile: "minimal", addons: [], optionalAddons: [] } as never).runtime,
    ).toBe("pinned-cdn");
    expect(
      planPythonMaterials({
        profile: "minimal",
        addons: [],
        optionalAddons: [],
        runtimeIndexUrl: "https://runtime.example.org/pyodide/",
      } as never).runtime,
    ).toBe("mirror");
  });

  it("keys the cache on what changes the bytes, and not on where they are served", () => {
    const base = { profile: "xarray-zarr", addons: ["dask"], optionalAddons: [] };
    const key = (extra: object): string =>
      pythonMaterialsCacheKey(planPythonMaterials({ ...base, ...extra } as never));

    // A different place to serve them from is not a different set of files.
    expect(key({ addonBaseUrl: "https://a.example.org/x/" })).toBe(key({}));
    expect(key({ wheelhouseUrl: "https://b.example.org/y/" })).toBe(key({}));
    // Nor is a self-hosted runtime: `prepare-playground` does not mirror Pyodide either way, so
    // `runtimeIndexUrl` changes no byte of this directory. Keying on it makes a deployment that
    // self-hosts its runtime re-download a wheelhouse and an add-on set that are already correct.
    expect(key({ runtimeIndexUrl: "https://runtime.example.org/pyodide/" })).toBe(key({}));
    // A different add-on set or profile IS: those change which artefacts are fetched.
    expect(key({ addons: ["dask", "cartopy-natural-earth-110m"] })).not.toBe(key({}));
    expect(key({ profile: "freva-client" })).not.toBe(key({}));
  });
});

describeWithMaterials("2. a cache is validated by its bytes", () => {
  const materials = PYTHON_MATERIALS!;
  const plan = planPythonMaterials(PYTHON_MATERIALS_PLAN as never);

  it("accepts a directory that really is what the plan asks for", () => {
    expect(verifyPythonMaterials(materials, plan)).toEqual([]);
  });

  it("rejects a directory prepared for a different configuration", () => {
    // One add-on fewer: a directory that carries MORE than the plan is rejected too.
    const other = planPythonMaterials({
      profile: "xarray-zarr",
      addons: ["dask"],
      optionalAddons: [],
    } as never);
    const problems = verifyPythonMaterials(materials, other);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join("\n")).toMatch(
      /prepared for a different configuration|is missing|is not pinned/,
    );
  });

  it("rejects a directory whose bytes were altered, not merely one with no manifest", () => {
    // `if [ -f "$dir/MANIFEST.json" ]` is answered just as happily by a tampered directory as by
    // an intact one: the manifest is written by whoever wrote the files.
    const copy = join(tempRoot("portal-materials-tamper-"), "materials");
    cpSync(materials, copy, { recursive: true });
    const victim = join(copy, ...plan.files[0]!.path.split("/"));
    appendFileSync(victim, "tampered");
    const problems = verifyPythonMaterials(copy, plan);
    expect(problems.join("\n")).toContain("is not the artefact this build pinned");
    // …and the manifest is still there, which is why looking for it proves nothing.
    expect(existsSync(join(copy, "PYTHON-MATERIALS.json"))).toBe(true);
  });

  it("rejects a directory that is missing a file the plan requires", () => {
    const copy = join(tempRoot("portal-materials-missing-"), "materials");
    cpSync(materials, copy, { recursive: true });
    rmSync(join(copy, ...plan.files[0]!.path.split("/")));
    expect(verifyPythonMaterials(copy, plan).join("\n")).toContain("is missing");
  });
});

describeWithMaterials("3. incorporated into the artifact, before its manifests", () => {
  it("copies every planned file and covers it with the checksums", async () => {
    const { out, result } = await build(CONFIG, "portal-materials-in-", PYTHON_MATERIALS!);
    expect(result.diagnostics.errors).toEqual([]);

    const plan = planPythonMaterials(PYTHON_MATERIALS_PLAN as never);
    const checksums = readFileSync(join(out, "checksums.sha256"), "utf8");
    const manifest = JSON.parse(readFileSync(join(out, "portal-manifest.json"), "utf8")) as {
      files: { path: string; bytes: number }[];
    };

    for (const file of plan.files) {
      expect(existsSync(join(out, ...file.path.split("/"))), `${file.path} is absent`).toBe(true);
      expect(checksums, `${file.path} is not checksummed`).toContain(file.path);
      const entry = manifest.files.find((f) => f.path === file.path);
      expect(entry, `${file.path} is not in the manifest`).toBeDefined();
      // The checksum the artifact recorded is the PINNED digest, so the artifact's record and
      // the digest compiled into the interpreter's bundle are the same number: `verify` and the
      // running interpreter check the same bytes against the same expectation.
      expect(checksums).toContain(`${file.sha256}  ${file.path}`);
    }
    // The preparation record travels too, so the artifact says what it was prepared for.
    expect(checksums).toContain("PYTHON-MATERIALS.json");
  }, 300_000);

  it("passes verify with the materials present, which is the whole point", async () => {
    const { out } = await build(CONFIG, "portal-materials-verify-", PYTHON_MATERIALS!);
    const verified = verifyArtifact(out);
    expect(verified.errors).toEqual([]);
  }, 300_000);

  it("fails verify when one material is altered", async () => {
    const { out } = await build(CONFIG, "portal-materials-altered-", PYTHON_MATERIALS!);
    const wheel = join(out, "python-addons", "dask", "dask-2026.8.0-py3-none-any.whl");
    appendFileSync(wheel, "x");
    const verified = verifyArtifact(out);
    expect(verified.errors.map((d) => d.message).join("\n")).toContain(
      "does not match its recorded checksum",
    );
  }, 300_000);

  it("fails verify when one material is removed", async () => {
    const { out } = await build(CONFIG, "portal-materials-removed-", PYTHON_MATERIALS!);
    const wheel = join(out, "python-addons", "dask", "dask-2026.8.0-py3-none-any.whl");
    renameSync(wheel, `${wheel}.moved`);
    const verified = verifyArtifact(out);
    expect(verified.errors.length).toBeGreaterThan(0);
  }, 300_000);

  it("serves them from the artifact's own path, so no host is named in the configuration", async () => {
    const { out } = await build(CONFIG, "portal-materials-paths-", PYTHON_MATERIALS!);
    const html = readFileSync(join(out, "docs/page-0/index.html"), "utf8");
    const config = JSON.parse(
      /data-portal-python-playground="([^"]*)"/
        .exec(html)![1]!
        .replaceAll("&quot;", '"')
        .replaceAll("&amp;", "&"),
    ) as { addonBaseUrl?: string; wheelhouseUrl?: string; packagePolicy: { origins: string[] } };

    // ROOT-RELATIVE, which is the property that matters: the same artifact is correct on
    // 127.0.0.1:4321, on a staging host and in production, with nothing rewritten per
    // environment. The alternative is a source config with `http://127.0.0.1:4321/` committed.
    expect(config.addonBaseUrl).toBe("/python-addons/");
    expect(config.wheelhouseUrl).toBeUndefined();
    // …and because the assets are same-origin they contribute NO origin to the package policy:
    // `'self'` already covers them, so `connect-src` gains nothing.
    expect(config.packagePolicy.origins).toEqual(["https://cdn.jsdelivr.net"]);
  }, 300_000);

  it("hashes what it copied, so the artifact's record is of the real bytes", async () => {
    const { out } = await build(CONFIG, "portal-materials-hash-", PYTHON_MATERIALS!);
    const wheel = join(out, "python-addons", "dask", "dask-2026.8.0-py3-none-any.whl");
    const digest = createHash("sha256").update(readFileSync(wheel)).digest("hex");
    expect(readFileSync(join(out, "checksums.sha256"), "utf8")).toContain(digest);
  }, 300_000);
});

describe("4. absence, for a portal with no runnable Python", () => {
  it("emits no wheels, no add-on artefacts and no preparation record", async () => {
    // The capability is CONFIGURED here and used by nothing, which is the case that matters: a
    // portal that enables the stanza and marks no snippet must be provably free of an
    // interpreter and of everything it would need.
    const { out, result } = await build(
      {
        playground: {
          profile: PYTHON_MATERIALS_PLAN.profile,
          addons: [...PYTHON_MATERIALS_PLAN.addons],
        },
        pages: 1,
      },
      "portal-materials-absent-",
      PYTHON_MATERIALS ?? undefined,
    );
    expect(result.diagnostics.errors).toEqual([]);
    expect(existsSync(join(out, "python-addons"))).toBe(false);
    expect(existsSync(join(out, "freva-wheels"))).toBe(false);
    expect(existsSync(join(out, "PYTHON-MATERIALS.json"))).toBe(false);
    const checksums = readFileSync(join(out, "checksums.sha256"), "utf8");
    expect(checksums).not.toContain("python-addons/");
    expect(checksums).not.toContain("freva-wheels/");
  }, 300_000);
});
