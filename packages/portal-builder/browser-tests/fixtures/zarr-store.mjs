// A real, readable Zarr v3 store, written by hand so the bytes are in the repository as code.
//
// Every Python recipe the tree shows must actually run in the configured browser profile, and a
// mock cannot settle that: a stubbed `open_dataset` proves the button is wired, not that the
// program works. The acceptance run starts a real Pyodide interpreter, hands it the exact source
// the panel displayed and reads what `xarray` printed, so there has to be a store to open. A
// committed `.zarr` directory would be a few dozen opaque binaries that nobody can review and that
// silently rot when a format detail changes; built here from plain JSON metadata and typed arrays
// it can be checked against the Zarr v3 specification line by line.
//
// Deliberately boring: uncompressed (`bytes` codec only, little-endian), one chunk per array, and
// consolidated metadata inline in the group's own `zarr.json` so that opening it needs no
// directory listing, because an object store cannot list and a store that only opens against a
// filesystem would prove nothing about the deployed case. The values are a fixed arithmetic ramp:
// an assertion on what the interpreter printed has to be able to name a number.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Four months, forty-eight cells: small enough to serve instantly, big enough to have a shape. */
export const SHAPE = { time: 4, cell: 48 };

/** `tas[t][c] = 273.15 + t + c/100`, so a printed value is checkable by eye and by assertion. */
function temperatures() {
  const out = new Float32Array(SHAPE.time * SHAPE.cell);
  for (let t = 0; t < SHAPE.time; t += 1) {
    for (let c = 0; c < SHAPE.cell; c += 1) out[t * SHAPE.cell + c] = 273.15 + t + c / 100;
  }
  return out;
}

function ints(count) {
  const out = new BigInt64Array(count);
  for (let i = 0; i < count; i += 1) out[i] = BigInt(i);
  return out;
}

const BYTES = { name: "bytes", configuration: { endian: "little" } };

function array(shape, dataType, dimensionNames, attributes, fillValue) {
  return {
    shape,
    data_type: dataType,
    chunk_grid: { name: "regular", configuration: { chunk_shape: shape } },
    chunk_key_encoding: { name: "default", configuration: { separator: "/" } },
    fill_value: fillValue,
    codecs: [BYTES],
    attributes,
    dimension_names: dimensionNames,
    zarr_format: 3,
    node_type: "array",
    storage_transformers: [],
  };
}

const TAS = array(
  [SHAPE.time, SHAPE.cell],
  "float32",
  ["time", "cell"],
  { units: "K", long_name: "near-surface air temperature" },
  "NaN",
);
const TIME = array([SHAPE.time], "int64", ["time"], {}, 0);
const CELL = array([SHAPE.cell], "int64", ["cell"], {}, 0);

/**
 * The store, as a map of key to bytes. Keys are relative and use `/`, which is what both a
 * filesystem and an object store want. The group's `zarr.json` carries `consolidated_metadata`, so
 * a reader fetches ONE metadata document and then only chunks.
 */
export function zarrStore() {
  const json = (value) => Buffer.from(JSON.stringify(value, null, 2), "utf8");
  const group = {
    attributes: { title: "level_0", source: "portal-builder acceptance fixture" },
    zarr_format: 3,
    node_type: "group",
    consolidated_metadata: {
      kind: "inline",
      must_understand: false,
      metadata: { cell: CELL, tas: TAS, time: TIME },
    },
  };
  return new Map([
    ["zarr.json", json(group)],
    ["tas/zarr.json", json(TAS)],
    ["time/zarr.json", json(TIME)],
    ["cell/zarr.json", json(CELL)],
    ["tas/c/0/0", Buffer.from(temperatures().buffer)],
    ["time/c/0", Buffer.from(ints(SHAPE.time).buffer)],
    ["cell/c/0", Buffer.from(ints(SHAPE.cell).buffer)],
  ]);
}

/** The same store on disk, for a test that wants to serve it as static files. */
export function writeZarrStore(dir) {
  for (const [key, bytes] of zarrStore()) {
    const target = join(dir, ...key.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  return dir;
}
