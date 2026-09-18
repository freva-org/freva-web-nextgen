// tests/fixtures/search-index.ts - synthetic search indexes owned by this package.
//
// Same rules as `fixtures/catalog.ts`: ordinary climate-science vocabulary, no real archive, no
// real deployment, no endpoint. The ids deliberately overlap the sample catalogue's in one place
// and diverge everywhere else, because the two interesting cases are "the index names something
// the tree has never loaded" and "the index and the tree name the same thing".

/**
 * An index that claims completeness and names objects the sample catalogue's lazy source will not
 * have listed - including one whose id is a loaded node's, so deduplication has something to do.
 */
export function completeIndex(): unknown {
  return {
    schemaVersion: 1,
    generatedAt: "2026-02-01T00:00:00Z",
    source: "https://example.test",
    complete: true,
    entries: [
      {
        id: "idx:reanalysis/surface/pr.zarr",
        kind: "dataset",
        name: "pr.zarr",
        title: "Precipitation flux",
        path: "example://reanalysis/surface/pr.zarr",
        size: 900_000_000,
        modifiedAt: "2026-01-20T08:00:00Z",
        ancestors: [
          { id: "cat:reanalysis", name: "reanalysis", title: "Global Reanalysis" },
          { id: "cat:reanalysis/surface", name: "surface" },
        ],
      },
      {
        id: "idx:downscaling/eur-11/tasmax.zarr",
        kind: "dataset",
        name: "tasmax.zarr",
        path: "example://downscaling/eur-11/tasmax.zarr",
        ancestors: [{ id: "idx:downscaling", name: "downscaling" }],
      },
      {
        id: "idx:downscaling",
        kind: "collection",
        name: "downscaling",
        title: "Regional downscaling",
        path: "example://downscaling",
      },
      {
        // The same identity the sample catalogue gives its temperature store, with poorer data:
        // no size, no inspect URL, a duller title. The loaded node must win.
        id: "cat:reanalysis/surface/tas",
        kind: "dataset",
        name: "tas.zarr",
        title: "tas",
        path: "example://reanalysis/surface/tas.zarr",
      },
    ],
  };
}

/** The same shape, admitting that it does not cover everything and stating no generation time. */
export function partialIndex(): unknown {
  return {
    schemaVersion: 1,
    complete: false,
    entries: [
      {
        id: "idx:downscaling/eur-11/tasmax.zarr",
        kind: "dataset",
        name: "tasmax.zarr",
        path: "example://downscaling/eur-11/tasmax.zarr",
      },
    ],
  };
}

/**
 * Strings chosen to be dangerous if anything in the path from JSON to screen ever parses them.
 *
 * They are valid data - a name may contain a bracket - so the parser must accept every one, and
 * the view must render every one as text.
 */
export function hostileIndex(): unknown {
  return {
    schemaVersion: 1,
    complete: false,
    entries: [
      {
        id: "hostile:1",
        kind: "dataset",
        name: "<img src=x onerror=alert(1)>.zarr",
        title: "</script><script>alert(2)</script>",
        path: "javascript:alert(3)",
        ancestors: [{ id: "hostile:root", name: "<b>bold</b>", title: '"><svg onload=alert(4)>' }],
      },
      {
        id: "hostile:2",
        kind: "file",
        name: "quote\"and'apostrophe.nc",
        path: "example://a/b/quote\"and'apostrophe.nc",
      },
    ],
  };
}

/** A large index, for the performance regression test. Deterministic, so failures reproduce. */
export function largeIndex(count: number): unknown {
  const entries = new Array(count);
  for (let i = 0; i < count; i += 1) {
    const project = `proj${i % 40}`;
    const variable = `var${i % 500}`;
    entries[i] = {
      id: `big:${project}/${variable}/${i}.zarr`,
      kind: "dataset",
      name: `${variable}_${i}.zarr`,
      title: `Variable ${variable} member ${i}`,
      path: `example://${project}/${variable}/${i}.zarr`,
      size: i * 1024,
      ancestors: [{ id: `big:${project}`, name: project }],
    };
  }
  return { schemaVersion: 1, complete: true, entries };
}
