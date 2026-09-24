// A dataset-tree block over a LIVE object store, at build time. The browser half - what the page
// asks the gateway for, and when - is a claim about network traffic and is settled in
// `browser-tests/dataset-tree-s3.mjs`. Settled here is everything the build decides first: which
// source a block has, what a malformed gateway configuration does, what the recorded policy may
// widen, and whether the adapter is in the artifact at all.
//
// THE ONE-SOURCE RULE IS THE CENTRE OF IT. `catalog` and `s3` are alternatives, not options that
// combine: a block with both has two answers for the same rows and the build would have to pick
// one silently. Exactly one is required, and both mistakes - both keys, neither key - are
// diagnostics against the block rather than a default.

import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  cleanupFixtures,
  codes,
  resolveFixture,
  tempRoot,
  write,
  writeSite,
} from "../helpers/fixture.js";
import { buildFixture } from "../helpers/site.js";
import { projectRuntime, generateEntryModule } from "../../src/artifact/runtime-projection.js";

afterAll(cleanupFixtures);

const ENDPOINT = "https://s3.eu-dkrz-1.example.cloud";

/** The gateway stanza the reported archive needs: an endpoint and the buckets it is known to hold. */
const S3_BLOCK = `  - type: dataset-tree
    heading: Currently available datasets
    s3:
      endpoint: ${ENDPOINT}
      style: path
      roots:
        - name: cmip6
          bucket: cmip6
          prefix: healpix/cmip6/
          title: CMIP6 on HEALPix
        - name: cordex
          bucket: cordex
          prefix: healpix/cordex/
`;

const CATALOG = JSON.stringify({
  schemaVersion: 1,
  roots: [{ id: "cmip6", kind: "collection", name: "CMIP6", children: [] }],
});

function landing(blockYaml: string): string {
  return `schemaVersion: 1
title: Test Site
blocks:
  - type: hero
    heading: Hello
${blockYaml}`;
}

/** A site carrying one dataset-tree block, plus a catalogue file for the tests that want one. */
function site(blockYaml: string, options: { extra?: string; runnable?: boolean } = {}): string {
  const root = tempRoot("portal-dt-s3-");
  // `runnable` puts a marked snippet on the page: the portal's own stanza joins the agreement
  // check only for a page that uses it, which is the case the inheritance tests are about.
  const prose = options.runnable
    ? "  - type: prose\n    heading: Read it\n    source: ../content/_fragments/run.md\n"
    : "";
  writeSite(root, {
    landing: `${landing(blockYaml)}${prose}`,
    ...(options.extra ? { extra: options.extra } : {}),
    ...(options.runnable
      ? {
          content: {
            "content/_fragments/run.md": "```python try-in-python\nprint('hi')\n```\n",
          },
        }
      : {}),
  });
  write(root, "data/archive.json", CATALOG);
  return root;
}

describe("choosing a source", () => {
  it("accepts a live `s3` block and records it as live", async () => {
    const result = await resolveFixture(site(S3_BLOCK));
    expect(result.diagnostics.errors).toEqual([]);
    const block = result.model!.landings[0]!.blocks.find((b) => b.type === "dataset-tree")!;
    expect(block.datasetTree!.mode).toBe("s3");
    // No catalogue, and specifically an EMPTY string rather than a placeholder. The page emits
    // the catalogue script only in snapshot mode; an empty-looking catalogue here would put an
    // empty `<script type="application/json">` on the page for the island to parse into zero
    // roots - a tree that renders nothing and reports no error.
    expect(block.datasetTree!.catalogScriptJson).toBe("");
    expect(block.datasetTree!.nodeCount).toBe(0);
    expect(block.datasetTree!.rootCount).toBe(2);
    expect(block.datasetTree!.statusLabel).toBe("LIVE");
    expect(block.datasetTree!.s3!.origin).toBe(ENDPOINT);
    expect(block.datasetTree!.s3!.roots.map((r) => r.bucket)).toEqual(["cmip6", "cordex"]);
  });

  it("still accepts a snapshot block, unchanged", async () => {
    const result = await resolveFixture(
      site(`  - type: dataset-tree\n    catalog: ../data/archive.json\n`),
    );
    expect(result.diagnostics.errors).toEqual([]);
    const block = result.model!.landings[0]!.blocks.find((b) => b.type === "dataset-tree")!;
    expect(block.datasetTree!.mode).toBe("snapshot");
    expect(block.datasetTree!.s3).toBeUndefined();
  });

  // Both keys is a SCHEMA error, deliberately not a model one. `oneOf` makes the two sources
  // alternatives rather than combinable options, so a block carrying both never reaches the
  // model; the resolver's own "either `catalog` or `s3`, not both" is the second line of defence
  // for a caller that builds a model without the schema in front of it.
  it("refuses a block that declares both sources", async () => {
    const both = `  - type: dataset-tree
    catalog: ../data/archive.json
${S3_BLOCK.split("\n").slice(1).join("\n")}`;
    const result = await resolveFixture(site(both));
    expect(codes(result.diagnostics)).toContain("FP1104");
    expect(result.model).toBeUndefined();
  });

  it("refuses a block that declares neither", async () => {
    const result = await resolveFixture(site(`  - type: dataset-tree\n    heading: Nothing\n`));
    expect(codes(result.diagnostics)).toContain("FP1104");
  });
});

describe("the gateway configuration", () => {
  const withS3 = (stanza: string) =>
    resolveFixture(site(`  - type: dataset-tree\n    s3:\n${stanza}`));
  const ROOTS = `      roots:\n        - name: cmip6\n          bucket: cmip6\n`;

  it("refuses an endpoint that is not a URL", async () => {
    const result = await withS3(`      endpoint: not-a-url\n${ROOTS}`);
    expect(codes(result.diagnostics)).toContain("FP1205");
  });

  it("refuses a plaintext endpoint that is not on loopback", async () => {
    const result = await withS3(`      endpoint: http://s3.example.org\n${ROOTS}`);
    expect(codes(result.diagnostics)).toContain("FP1205");
  });

  // Loopback http is the only plaintext exception. Every acceptance run in this repository puts
  // a gateway on 127.0.0.1, and admitting no plaintext at all would leave the live path testable
  // only against a mock. The exception cannot describe a deployment: a published portal whose
  // endpoint is loopback reaches the visitor's own machine, not an archive.
  it("allows an http endpoint on loopback, because that is where a test gateway is", async () => {
    const result = await withS3(`      endpoint: http://127.0.0.1:9000\n${ROOTS}`);
    expect(result.diagnostics.errors).toEqual([]);
  });

  it("refuses an endpoint carrying credentials, a query or a fragment", async () => {
    const result = await withS3(`      endpoint: https://key:secret@s3.example.org\n${ROOTS}`);
    expect(codes(result.diagnostics)).toContain("FP1210");
  });

  it("refuses a prefix that does not end with a separator", async () => {
    const result = await withS3(
      `      endpoint: ${ENDPOINT}\n      roots:\n        - name: cmip6\n          bucket: cmip6\n          prefix: healpix/cmip6\n`,
    );
    expect(codes(result.diagnostics)).toContain("FP1201");
  });

  it("refuses two roots that resolve to the same location", async () => {
    const result = await withS3(
      `      endpoint: ${ENDPOINT}\n      roots:\n        - name: one\n          bucket: cmip6\n          prefix: healpix/\n        - name: two\n          bucket: cmip6\n          prefix: healpix/\n`,
    );
    expect(codes(result.diagnostics)).toContain("FP1201");
  });

  // A live block registers recipe TEMPLATES. What must never happen is source composed in the
  // page reaching an interpreter; a fixed recipe with one hole satisfies that while still
  // letting a reader run the store in front of them, even though a node discovered in a browser
  // has no build-time hash of its own. The store's identifier is a parameter, checked against
  // the configured endpoint and roots before it fills the hole.
  it("registers recipe templates for a live block, hashed by the build", async () => {
    const result = await resolveFixture(
      site(`${S3_BLOCK}    python:\n      enabled: true\n      profile: xarray-zarr\n`),
    );
    expect(result.diagnostics.errors).toEqual([]);
    const block = result.model!.landings[0]!.blocks.find((b) => b.type === "dataset-tree")!;
    const python = block.datasetTree!.python!;
    // One recipe ships, and this profile can run it.
    expect(python.recipes).toEqual(["http"]);
    expect(Object.keys(python.recipeDigests ?? {}).sort()).toEqual(["http"]);
    expect(python.examples.map((e) => e.id)).toEqual(["recipe:http"]);
    // Every digest is a real sha256 of the template, in BARE HEX. `@freva-org/browser-python`'s
    // registry and the component's eligibility check both accept lowercase hex and nothing else,
    // so a `sha256:`-prefixed value does not fail loudly: it removes the Try control silently.
    for (const digest of Object.values(python.recipeDigests ?? {})) {
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
    }
    // The allowlist the RUNNER checks a store against travels with it.
    expect(python.store?.endpoint).toBe(ENDPOINT);
    expect(python.store?.roots.map((r) => r.bucket)).toEqual(["cmip6", "cordex"]);
  });

  // A block INHERITS the portal's playground, which is what makes `enabled: true` mean anything.
  // A `dataset-tree` block's stanza cannot name add-ons, connect origins, credential persistence
  // or asset locations - they are portal-wide decisions - so a block resolved on its own takes
  // the default for each, and a page with both stanzas then fails its own agreement check: the
  // portal says `addons: [dask]`, the block says `[]`, about one interpreter. The visible symptom
  // is a tree with no run control on a page whose prose has one.
  it("inherits the portal's playground, and overrides only what the block wrote", async () => {
    const result = await resolveFixture(
      site(`${S3_BLOCK}    python:\n      enabled: true\n`, {
        // `addonBaseUrl` because this fixture hands the build no prepared materials: an add-on
        // whose artefacts nothing can serve is `FP1223`, a different subject.
        extra:
          "pythonPlayground:\n  enabled: true\n  profile: xarray-zarr\n  addons:\n    - dask\n" +
          "  addonBaseUrl: https://assets.example.org/python-addons/\n" +
          "  network: https\n  autostart: never\n",
        runnable: true,
      }),
    );
    expect(result.diagnostics.errors).toEqual([]);
    const block = result.model!.landings[0]!.blocks.find((b) => b.type === "dataset-tree")!;
    const python = block.datasetTree!.python!;
    expect(python.profile).toBe("xarray-zarr");
    expect(python.addons).toEqual(["dask"]);
    expect(python.network).toBe("https");
    // Inherited profile carries xarray, zarr and fsspec, so the recipe is runnable in the tree.
    expect(python.recipes).toEqual(["http"]);
    expect(python.examples.map((e) => e.id)).toEqual(["recipe:http"]);
  });

  it("a field the block DID write still has to agree with the portal", async () => {
    const result = await resolveFixture(
      site(`${S3_BLOCK}    python:\n      enabled: true\n      profile: minimal\n`, {
        extra: "pythonPlayground:\n  enabled: true\n  profile: xarray-zarr\n  autostart: never\n",
        runnable: true,
      }),
    );
    const codes = result.diagnostics.items.map((d) => d.code);
    expect(codes).toContain("FP1215");
    const clash = result.diagnostics.items.find((d) => d.code === "FP1215")!;
    expect(clash.message).toMatch(/'profile' is "minimal" .* "xarray-zarr"|'profile'/);
  });

  // A profile that cannot run a recipe is REPORTED, not silently short of a button. `minimal`
  // loads no packages, so the recipe is shown copy-only - a legitimate configuration, but one a
  // maintainer cannot otherwise distinguish from Try in Python being broken.
  it("says which recipes the configured profile cannot run", async () => {
    const result = await resolveFixture(
      site(`${S3_BLOCK}    python:\n      enabled: true\n      profile: minimal\n`),
    );
    expect(result.diagnostics.errors).toEqual([]);
    expect(codes(result.diagnostics)).toContain("FP1217");
    const note = result.diagnostics.items.find((d) => d.code === "FP1217")!;
    expect(note.message).toMatch(/HTTP \(needs xarray, zarr, fsspec\)/);
    const block = result.model!.landings[0]!.blocks.find((b) => b.type === "dataset-tree")!;
    expect(block.datasetTree!.python!.recipes).toEqual([]);
    expect(block.datasetTree!.python!.examples).toEqual([]);
  });
});

describe("what a live block puts in the artifact", () => {
  function files(dir: string): string[] {
    const out: string[] = [];
    const walk = (at: string): void => {
      for (const entry of readdirSync(at, { withFileTypes: true })) {
        const full = join(at, entry.name);
        if (entry.isDirectory()) walk(full);
        else out.push(relative(dir, full).split(sep).join("/"));
      }
    };
    walk(dir);
    return out.sort();
  }
  const read = (dir: string, file: string) => readFileSync(join(dir, ...file.split("/")), "utf8");

  it("names the endpoint's origin in `connect-src`, and widens nothing else", async () => {
    const liveOut = join(tempRoot("portal-dt-s3-live-"), "site");
    const snapOut = join(tempRoot("portal-dt-s3-snap-"), "site");
    await buildFixture(site(S3_BLOCK), liveOut);
    await buildFixture(
      site(`  - type: dataset-tree\n    catalog: ../data/archive.json\n`),
      snapOut,
    );

    const live = JSON.parse(read(liveOut, "host-policy.json")).csp.portal as Record<string, string>;
    const snap = JSON.parse(read(snapOut, "host-policy.json")).csp.portal as Record<string, string>;
    expect(snap["connect-src"]).toBe("'self'");
    expect(live["connect-src"]).toBe(`'self' ${ENDPOINT}`);
    for (const key of Object.keys(snap)) {
      if (key === "connect-src") continue;
      expect(`${key}: ${live[key]}`).toBe(`${key}: ${snap[key]}`);
    }
    expect(Object.keys(live).sort()).toEqual(Object.keys(snap).sort());

    // The ADAPTER, in the build that asked for it and in no other. Matched on string literals
    // the adapter must contain - the XML element names it parses - not a function name, which
    // the bundler renames. Not the query string either: the minifier splits `list-type=2` across
    // two literals, so a test looking for it never matches anything and never says so.
    const code = (dir: string) =>
      files(dir)
        .filter((f) => f.endsWith(".js"))
        .map((f) => read(dir, f))
        .join("\n");
    for (const fingerprint of ["ListBucketResult", "CommonPrefixes", "continuation-token"]) {
      expect(code(liveOut)).toContain(fingerprint);
      expect(code(snapOut)).not.toContain(fingerprint);
    }

    // And no catalogue travels in a live page, because there is none to travel.
    expect(read(liveOut, "index.html")).not.toContain("data-portal-dataset-tree-catalog");
    expect(read(liveOut, "index.html")).toContain('data-portal-dataset-tree-mode="s3"');
  });

  // One loader per mode, decided in the generated entry. The island cannot import either adapter
  // itself: a module that so much as MENTIONS the S3 specifier puts the adapter in the graph,
  // which is how a snapshot-only portal ends up shipping an object-store client. The entry names
  // the loader the build needs and no other.
  it("wires only the loaders the page's blocks use", async () => {
    const liveModel = (await resolveFixture(site(S3_BLOCK))).model!;
    const snapModel = (
      await resolveFixture(site(`  - type: dataset-tree\n    catalog: ../data/archive.json\n`))
    ).model!;

    expect(projectRuntime(liveModel).datasetTree).toMatchObject({ s3: true, snapshot: false });
    expect(projectRuntime(snapModel).datasetTree).toMatchObject({ s3: false, snapshot: true });

    const liveEntry = generateEntryModule(liveModel);
    const snapEntry = generateEntryModule(snapModel);

    expect(liveEntry).toContain("tree-source-s3");
    expect(liveEntry).not.toContain("tree-source-snapshot");
    expect(snapEntry).toContain("tree-source-snapshot");
    expect(snapEntry).not.toContain("tree-source-s3");
  });

  // The playground is prepared after the mount SETTLES. `preparePythonPlayground()` reads the
  // blocks the island registered and returns silently if none has - correct for a portal with no
  // block, a silent no-op for one whose blocks have not registered YET. The mount is
  // asynchronous, because a live block's adapter arrives through an import of its own, so one
  // microtask of slack gives a Try control that renders, is pressed, and does nothing: no
  // launcher, no handler, no error. Markup checks cannot see that, so the order is asserted here
  // as well as in the browser.
  it("prepares the Python playground only after every block has mounted", async () => {
    const root = tempRoot("portal-dt-s3-py-");
    writeSite(root, {
      landing: landing(
        `  - type: dataset-tree\n    catalog: ../data/archive.json\n    python:\n      enabled: true\n      profile: minimal\n`,
      ),
    });
    write(root, "data/archive.json", CATALOG);
    const entry = generateEntryModule((await resolveFixture(root)).model!);

    const mount = entry.indexOf("mountDatasetTreeBlocks");
    const prepare = entry.indexOf("preparePythonPlayground(load");
    expect(mount).toBeGreaterThan(-1);
    expect(prepare).toBeGreaterThan(mount);
    // Chained on the mount's own promise, not merely written after it inside the same callback.
    expect(entry).toMatch(
      /\.then\(\(m\) => m\.mountDatasetTreeBlocks\([^)]*\)\)\n\s*\.then\(\(\) => preparePythonPlayground\(/,
    );
  });
});
