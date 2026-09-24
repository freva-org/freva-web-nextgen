// A consumer-shaped portal in the shape the Dataset Tree defect was reported against.
//
// Cosmos preset, a header with real navigation, a dataset-tree block over a catalogue with the
// same shape as the reported one - collection folders with nested paths, and a long run of
// `.zarr` datasets - a footer, and the Freva badge. That combination is what the defect needs:
// the block is only wrong in relation to the things AROUND it, and a bare fixture with no header,
// no footer and no scene cannot show it. Shared by the visual suite and the screenshot script so
// both photograph the same portal.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><title>Mark</title><circle cx="16" cy="16" r="14" fill="#7c5cff"/><path d="M10 20l6-10 6 10z" fill="#fff"/></svg>`;

/** A collection whose members are folders with a path inside, like the reported catalogue. */
function pathCollection(id, title, description, leaves) {
  return {
    id,
    kind: "collection",
    name: id,
    title,
    description,
    children: leaves.map((leaf) => ({
      id: `${id}/${leaf.name}`,
      kind: "directory",
      name: leaf.name,
      children: [
        {
          id: `${id}/${leaf.name}/${leaf.inner}`,
          kind: "directory",
          name: leaf.inner,
          path: leaf.path,
          availability: "available",
        },
      ],
    })),
  };
}

/**
 * The reported archive's own depth, as a snapshot.
 *
 * `CMIP6 -> healpix -> cmip6 -> historical-r10i1p1f2 -> cnrm-cm6-1 -> P1M -> level_0.zarr` is the
 * path the report walked: seven levels. A fixture two levels deep cannot show an indentation rule
 * that only goes wrong from the first child down, which is why the shallow `pathCollection` above
 * stays beside this one. The same path exists in the live S3 gateway fixture, so the depth rule
 * is proved against both source kinds rather than against one catalogue's shape.
 */
function deepCollection(id, title, description) {
  const store = (parent, name) => ({
    id: `${parent}/${name}`,
    kind: "dataset",
    name,
    path: `s3://${id}/${parent.split("/").slice(1).join("/")}/${name}/`,
    size: 1024 * 1024 * 512,
    availability: "available",
    inspect: `https://inspect.example.org/#/${parent}/${name}`,
    examples: [
      {
        id: "python",
        label: "Python",
        language: "python",
        description: "Open the store directly.",
        code: `import xarray as xr\n\nds = xr.open_zarr("s3://${id}/${name}")\nprint(ds)\n`,
        executable: true,
      },
    ],
  });
  const dir = (parent, name, children) => ({
    id: `${parent}/${name}`,
    kind: "directory",
    name,
    children,
  });
  const freq = (parent, name) =>
    dir(
      parent,
      name,
      [0, 1, 2].map((n) => store(`${parent}/${name}`, `level_${n}.zarr`)),
    );
  const model = (parent, name) =>
    dir(parent, name, [freq(`${parent}/${name}`, "P1D"), freq(`${parent}/${name}`, "P1M")]);
  const member = (parent, name) =>
    dir(parent, name, [
      model(`${parent}/${name}`, "cnrm-cm6-1"),
      model(`${parent}/${name}`, "icon-esm-lr"),
    ]);
  const inner = dir(`${id}/healpix`, "cmip6", [
    member(`${id}/healpix/cmip6`, "historical-r10i1p1f2"),
    member(`${id}/healpix/cmip6`, "ssp585-r1i1p1f2"),
  ]);
  return {
    id,
    kind: "collection",
    name: id,
    title,
    description,
    children: [dir(id, "healpix", [inner])],
  };
}

/** A long run of `.zarr` stores, which is what makes the maximized list dense. */
function zarrCollection(id, title, description, prefixes, count) {
  const children = [];
  for (const prefix of prefixes) {
    for (let i = 0; i < count; i += 1) {
      children.push({
        id: `${id}/${prefix}_${i}.zarr`,
        kind: "dataset",
        name: `${prefix}_${i}.zarr`,
        path: `s3://${id}/${prefix}_${i}.zarr`,
        size: 1024 * 1024 * (i + 3),
        availability: "available",
        // Inert without the portal adapter's `onInspect`; the control is gated on BOTH.
        inspect: `https://inspect.example.org/#/${id}/${prefix}_${i}.zarr`,
        examples: [
          {
            id: "python",
            label: "Python",
            language: "python",
            description: "Open the store directly.",
            code: `import xarray as xr\n\nds = xr.open_zarr("s3://${id}/${prefix}_${i}.zarr")\nprint(ds)\n`,
            executable: true,
          },
        ],
      });
    }
  }
  return { id, kind: "collection", name: id, title, description, children };
}

export const CATALOG = {
  schemaVersion: 1,
  generatedAt: "2026-06-18T09:00:00Z",
  source: "s3://hub.example.org",
  roots: [
    deepCollection(
      "cmip6",
      "Coupled Model Intercomparison Project Phase 6",
      "Model output on a HEALPix grid.",
    ),
    pathCollection(
      "cordex",
      "Coordinated Regional Downscaling Experiment",
      "Regional downscaling output.",
      [{ name: "healpix", inner: "cordex", path: "s3://cordex/healpix/cordex/" }],
    ),
    pathCollection(
      "dyamond",
      "Global storm-resolving intercomparison",
      "Storm-resolving simulations.",
      [{ name: "healpix", inner: "dyamond", path: "s3://dyamond/healpix/dyamond/" }],
    ),
    zarrCollection(
      "eerie",
      "Eddy-Rich Earth System Models",
      "Monthly means, published per member.",
      ["eerie-future-ssp245-v20240618_P1M_mean", "eerie-hist-1950-v20240618_P1M_mean"],
      10,
    ),
    zarrCollection(
      "nextgems",
      "Next Generation Earth Modelling Systems",
      "Cycle 3 output.",
      ["nextgems_cycle3_P1D_mean"],
      8,
    ),
  ],
};

/**
 * Write and build the fixture.
 *
 * `python` adds the playground, which the layering test needs: the terminal has to stay above the
 * maximized tree. `s3` swaps the block from a build-time catalogue to the live adapter, against a
 * gateway whose origin the caller already knows - it has to, because the origin goes into the
 * artifact's recorded `connect-src` at build time. Nothing is auto-expanded in that mode ON
 * PURPOSE: the live suite's first claim is that a freshly loaded page has asked the gateway for
 * nothing at all, and a pre-expanded root would issue a request before the test could look.
 */
export function buildWaterparkShaped({
  python = false,
  s3 = null,
  canonicalUrl = "https://waterpark.example.org/",
  outDir = null,
  buckets = null,
} = {}) {
  // `python` is either `true` for the stubbed suites or an OPTIONS OBJECT for the ones that start
  // a real interpreter. The object carries `runtimeIndexUrl` - a locally served copy of the
  // pinned Pyodide distribution - because the alternative reaches a CDN, which this sandbox
  // cannot do and which would make the result depend on somebody else's uptime.
  const py = python === true ? {} : python || null;
  const root = mkdtempSync(join(tmpdir(), "wp-shaped-"));
  const put = (rel, body) => {
    const target = join(root, ...rel.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
  };
  put("assets/logo.svg", LOGO);
  put("assets/favicon.svg", LOGO);
  put("data/archive.json", JSON.stringify(CATALOG, null, 2));
  // ONE RUNNABLE BLOCK, when the caller asked for add-ons. The portal-level `pythonPlayground`
  // stanza is where add-ons are configured, and it is only in force for a page that has a marked
  // code block - the dataset tree's own `python:` stanza overrides it for the tree. Same shape as
  // Waterpark: a prose fragment with a `try-in-python` fence beside the tree.
  put(
    "content/_fragments/runnable.md",
    [
      "A one-line read, so the page has something the playground is for.",
      "",
      "```python try-in-python",
      "print('hello from the fixture')",
      "```",
      "",
    ].join("\n"),
  );
  // THE REPORTED ARCHIVE'S OWN ROOTS, in its own order, with its own titles and project pages.
  // Taken from the deployment's `waterpark-datasets.json`: eleven collections, four with no
  // project page, and exactly one - `xspies` - locked with the words "coming soon". Every state
  // this suite has to show is here and none of them is invented:
  //
  //   cmip6, dyamond, …  populated, and the probe says so by saying nothing
  //   cordex             a valid listing that came back empty - "no data yet"
  //   icdc               a bucket that refuses anonymous listing - a 403 with a message
  //   palmod             a bucket that is not there at all - a 404 with the name in it
  //   xspies             announced, not browsable, no chevron, no request
  const ROOTS = [
    [
      "cmip6",
      "healpix/cmip6/",
      "CMIP6",
      "Coupled Model Intercomparison Project Phase 6",
      "https://wcrp-cmip.org/cmip-phase-6-cmip6",
      null,
    ],
    [
      "cordex",
      "healpix/cordex/",
      "CORDEX",
      "Coordinated Regional Climate Downscaling Experiment",
      "https://cordex.org",
      null,
    ],
    [
      "dyamond",
      "healpix/dyamond/",
      "DYAMOND",
      "Global storm-resolving intercomparison",
      "https://easy.gems.dkrz.de/DYAMOND/index.html",
      null,
    ],
    [
      "eerie",
      "",
      "EERIE",
      "Eddy-Rich Earth System Models",
      "https://dataviewer.eerie-project.eu/home/eddy-rich",
      null,
    ],
    [
      "icdc",
      "",
      "ICDC",
      "Integrated Climate Data Center",
      "https://www.cen.uni-hamburg.de/en/icdc",
      null,
    ],
    [
      "icon-dream",
      "",
      "ICON-DREAM",
      "DWD ICON Reanalysis",
      "https://opendata.dwd.de/climate_environment/CDC/help/landing_pages/doi_landingpage_ICON-DREAM_v1-en.html",
      null,
    ],
    [
      "nextgems",
      "",
      "nextGEMS",
      "next Generation Earth Modelling Systems",
      "https://nextgems-h2020.eu",
      null,
    ],
    [
      "obs",
      "",
      "Observations",
      "Various observational datasets, grid and swath products",
      null,
      null,
    ],
    ["palmod", "", "PalMod", "Paleoclimate Modelling initiative", null, null],
    [
      "reanalysis",
      "",
      "Reanalysis",
      "Reanalysis data for Ocean and Atmosphere",
      "https://www.ecmwf.int/en/forecasts/dataset/ecmwf-reanalysis-v5",
      null,
    ],
    ["xspies", "", "XSpies", "km scale flagship ICON simulations", null, "coming soon"],
  ];
  // `buckets` narrows the archive to a named subset, in the archive's own order. The traffic
  // suite needs a fixture whose every root is populated and reachable, so that "the page asked
  // for exactly this and nothing else" stays a statement about the code rather than about which
  // of eleven buckets happens to be forbidden. It is always a subset of the real roots: nothing
  // here invents a collection the deployment does not have.
  const chosen = buckets ? ROOTS.filter(([bucket]) => buckets.includes(bucket)) : ROOTS;
  if (buckets && chosen.length !== buckets.length) {
    throw new Error(`buildWaterparkShaped: unknown bucket in ${JSON.stringify(buckets)}`);
  }
  const rootYaml = chosen
    .map(([bucket, prefix, title, label, href, planned]) =>
      [
        `        - name: ${bucket}`,
        `          bucket: ${bucket}`,
        prefix ? `          prefix: ${prefix}` : null,
        `          title: ${title}`,
        `          description: ${label}`,
        href ? `          link:\n            href: ${href}\n            label: Project page` : null,
        planned ? `          planned: ${planned}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n");

  const source = s3
    ? `    s3:
      endpoint: ${s3.endpoint}
      style: path
      roots:
${rootYaml}
${s3.maxKeys ? `      maxKeys: ${s3.maxKeys}\n` : ""}${s3.retries !== undefined ? `      retries: ${s3.retries}\n` : ""}`
    : `    catalog: ../data/archive.json
    expand:
      - cmip6
      - eerie
`;
  put(
    "landings/home.yaml",
    `schemaVersion: 1
title: The HEALPix data hub on S3
blocks:
  - type: hero
    heading: Waterpark
    summary: Petabytes of climate model output on object storage, in one place, with the tools to read it.
${
  py && py.addons
    ? `  - type: prose
    heading: Working with data
    source: ../content/_fragments/runnable.md
`
    : ""
}  - type: dataset-tree
    heading: Currently available datasets
    summary: Collections published on the hub. Expand a row for its endpoint, an example read, and where the project is documented.
${source}${
      // THE TREE'S OWN STANZA, or the portal-level one - never both. A block-level `python:`
      // OVERRIDES the portal stanza for that block, and add-ons are not configurable there: they
      // belong where their artefacts are resolved. So a fixture that asks for add-ons gets the
      // portal-level stanza alone - exactly how Waterpark is configured, its dataset-tree block
      // carrying no `python:` at all - and a runnable prose block below turns the playground on.
      py && !py.addons
        ? `    python:
      enabled: true
      profile: ${py.profile ?? "minimal"}
      autostart: ${py.autostart ?? "never"}
      maxSessions: ${py.maxSessions ?? 2}
${py.playgroundOrigin ? `      playgroundOrigin: ${py.playgroundOrigin}\n` : ""}${py.runtimeIndexUrl ? `      runtimeIndexUrl: ${py.runtimeIndexUrl}\n` : ""}${py.network ? `      network: ${py.network}\n` : ""}      terminal:
        style: freva-client-terminal
        osControls: linux
        alwaysOnTop: true
        rememberAppearance: false
`
        : ""
    }`,
  );
  put(
    "portal.yaml",
    `schemaVersion: 1
site:
  id: waterpark-shaped
  title: Waterpark
  subtitle: The HEALPix data hub on S3
  language: en
  canonicalUrl: ${canonicalUrl}
  identity:
    logo: ./assets/logo.svg
    favicon: ./assets/favicon.svg
theme:
  preset: cosmos
${
  py && (py.addons || py.network)
    ? `pythonPlayground:
  enabled: true
  profile: ${py.profile ?? "minimal"}
${py.network ? `  network: ${py.network}\n` : ""}${py.addons ? `  addons:\n${py.addons.map((a) => `    - ${a}`).join("\n")}\n` : ""}${py.optionalAddons ? `  optionalAddons:\n${py.optionalAddons.map((a) => `    - ${a}`).join("\n")}\n` : ""}${py.runtimeIndexUrl ? `  runtimeIndexUrl: ${py.runtimeIndexUrl}\n` : ""}`
    : ""
}landings:
  home:
    path: /
    source: ./landings/home.yaml
navigation:
  header:
    - landing: home
      label: Data Browser
    - landing: home
      label: STAC Browser
    - landing: home
      label: Storage concepts
    - landing: home
      label: Working with data
`,
  );
  const mode = s3 ? (py ? "s3py" : "s3") : py ? "py" : "plain";
  const out = outDir ?? join(root, "..", `wp-shaped-site-${mode}-${process.pid}`);
  execFileSync(
    process.execPath,
    [
      join(PKG, "bin", "freva-portal-builder.mjs"),
      "build",
      "--source-root",
      root,
      "--config",
      join(root, "portal.yaml"),
      "--out",
      out,
      "--quiet",
    ],
    { stdio: "inherit", env: { ...process.env, SOURCE_DATE_EPOCH: "1760000000" } },
  );
  return out;
}
