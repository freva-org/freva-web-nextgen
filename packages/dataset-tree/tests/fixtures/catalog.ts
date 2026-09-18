// tests/fixtures/catalog.ts - synthetic catalogs owned by this package.
//
// The names are ordinary climate-science vocabulary (CMIP-style experiment and variable names, a
// reanalysis, a regional downscaling) because that is what the component is for. They describe no
// real archive, name no real deployment, and contain no endpoint: nothing here is Waterpark, ESGF
// or any other operator's data. `tests/external-consumer.test.ts` is the one place a real-world
// shape appears, and it says so in its own header.

/** A three-level catalog with one of everything the view can render. */
export function sampleCatalog(): unknown {
  return {
    schemaVersion: 1,
    generatedAt: "2026-01-06T10:00:00Z",
    source: "https://example.test",
    roots: [
      {
        id: "cat:reanalysis",
        kind: "collection",
        name: "reanalysis",
        title: "Global Reanalysis",
        description: "Hourly atmospheric reanalysis on a regular grid",
        path: "example://reanalysis",
        link: { href: "https://example.test/reanalysis", label: "Project page" },
        children: [
          {
            id: "cat:reanalysis/surface",
            kind: "directory",
            name: "surface",
            children: [
              {
                id: "cat:reanalysis/surface/tas",
                kind: "dataset",
                name: "tas.zarr",
                title: "Near-surface air temperature",
                path: "example://reanalysis/surface/tas.zarr",
                size: 1_503_238_553,
                mediaType: "application/vnd.zarr",
                modifiedAt: "2026-02-11T09:14:00Z",
                metrics: [{ label: "L", value: "7" }],
                inspect: "https://example.test/reanalysis/surface/tas.zarr",
                details: [
                  {
                    label: "DIMS",
                    values: [
                      { text: "time", value: "350 640" },
                      { text: "lat", value: "721" },
                      { text: "lon", value: "1440" },
                    ],
                  },
                  { label: "VARS", values: [{ text: "tas" }, { text: "tas_min" }] },
                ],
                // Carried for a consumer or an inspector; the view must never render it.
                metadata: {
                  dims: { time: 350_640, lat: 721, lon: 1440 },
                  vars: ["tas", "tas_min", "tas_max"],
                  title: "2 m air temperature",
                },
                access: [
                  { label: "HTTPS", href: "https://example.test/reanalysis/surface/tas.zarr" },
                  { label: "S3", value: "s3://example/reanalysis/surface/tas.zarr" },
                ],
              },
              {
                id: "cat:reanalysis/surface/readme",
                kind: "file",
                name: "README.md",
                path: "example://reanalysis/surface/README.md",
                size: 4096,
                mediaType: "text/markdown",
              },
            ],
          },
          {
            id: "cat:reanalysis/pressure",
            kind: "directory",
            name: "pressure-levels",
            // Declares itself knowably empty: it opens, and says so.
            children: [],
          },
        ],
      },
      {
        id: "cat:downscaling",
        kind: "collection",
        name: "downscaling",
        title: "Regional Downscaling",
        availability: "planned",
        availabilityNote: "coming soon",
        hasChildren: false,
      },
      {
        id: "cat:scenarios",
        kind: "collection",
        name: "scenarios",
        title: "Scenario Ensemble",
        children: [
          {
            id: "cat:scenarios/ssp245",
            kind: "dataset",
            name: "ssp245.zarr",
            path: "example://scenarios/ssp245.zarr",
            size: 812_000,
          },
          {
            id: "cat:scenarios/ssp585",
            kind: "dataset",
            name: "ssp585.zarr",
            path: "example://scenarios/ssp585.zarr",
            size: 934_000,
          },
        ],
      },
    ],
  };
}

/** The smallest document the schema accepts. */
export function emptyCatalog(): unknown {
  return { schemaVersion: 1, roots: [] };
}

/** Deliberately hostile values, none of which may ever become markup or a live link. */
export function hostileCatalog(): unknown {
  return {
    schemaVersion: 1,
    roots: [
      {
        id: "evil:1",
        kind: "collection",
        name: "<img src=x onerror=alert(1)>",
        title: "</span><script>alert('title')</script>",
        description: "<b>not bold</b>",
        path: "javascript:alert('path')",
        link: { href: "javascript:alert('link')", label: "<script>link</script>" },
        metrics: [{ label: "<script>k</script>", value: "<script>v</script>" }],
        details: [
          {
            label: "<script>field</script>",
            values: [{ text: "<script>t</script>", value: "<script>v</script>" }],
          },
        ],
        metadata: {
          "<script>k</script>": "<script>v</script>",
          nested: { deeper: { deepest: "dropped" } },
        },
        access: [
          { label: "<script>l</script>", href: "javascript:alert(1)" },
          { label: "data", href: "data:text/html,<script>alert(1)</script>" },
          { label: "vb", href: "vbscript:msgbox(1)" },
          { label: "ok", href: "https://example.test/safe" },
        ],
        children: [
          {
            id: "evil:2",
            kind: "file",
            name: "\u001b[31mansi",
            path: "s3://bucket/ok",
          },
        ],
      },
    ],
  };
}
