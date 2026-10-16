// The shared access recipes: store validation, escaping and the examples a live tree shows.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  STORE_PLACEHOLDER,
  TREE_RECIPES,
  bindStore,
  pythonStringBody,
  recipeAccessExamples,
  recipeExampleId,
  renderRecipe,
  resolveRecipeRun,
  runnableRecipes,
} from "../src/recipes.js";

const STORE = {
  endpoint: "https://s3.example.org",
  style: "path" as const,
  roots: [{ bucket: "reanalysis" }, { bucket: "models", prefix: "healpix/" }],
};
const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

test("the shipped recipe is the xarray-over-HTTPS one, byte for byte", () => {
  assert.equal(TREE_RECIPES.length, 1);
  const [http] = TREE_RECIPES;
  assert.equal(http.id, "http");
  assert.ok(http.template.includes(STORE_PLACEHOLDER));
  // The digest every host registers. Changing the template changes it, deliberately.
  assert.equal(
    sha(http.template),
    sha(
      'import xarray as xr\n\nds = xr.open_dataset(\n    "{{STORE}}",\n    engine="zarr",\n)\nprint(ds)\n',
    ),
  );
  assert.ok(Object.isFrozen(TREE_RECIPES) && Object.isFrozen(http));
});

test("bindStore accepts declared roots and builds both address styles", () => {
  assert.deepEqual(bindStore("s3://reanalysis/era5/P1M/level_4.zarr", STORE), {
    s3Path: "s3://reanalysis/era5/P1M/level_4.zarr",
    httpsUrl: "https://s3.example.org/reanalysis/era5/P1M/level_4.zarr",
  });
  assert.equal(
    bindStore("s3://reanalysis/x.zarr", { ...STORE, style: "virtual-host" })?.httpsUrl,
    "https://reanalysis.s3.example.org/x.zarr",
  );
});

test("bindStore refuses rather than escapes", () => {
  for (const bad of [
    undefined,
    42,
    "https://s3.example.org/reanalysis/x.zarr",
    "s3://other/x.zarr",
    "s3://models/not-under-prefix/x.zarr",
    "s3://reanalysis/../models/x.zarr",
    's3://reanalysis/a"b.zarr',
    "s3://reanalysis/a\\b.zarr",
    "s3://reanalysis/a\nb.zarr",
    "s3:///x.zarr",
  ]) {
    assert.equal(bindStore(bad, STORE), null, String(bad));
  }
  assert.equal(bindStore("s3://reanalysis/x.zarr", { ...STORE, endpoint: "ftp://x" }), null);
});

test("pythonStringBody cannot end a string literal", () => {
  assert.equal(pythonStringBody(`a"b'c\\d\n\x7f`), `a\\"b\\'c\\\\d\\x0a\\x7f`);
  assert.equal(pythonStringBody("$&"), "$&");
});

test("renderRecipe fills each hole once, from the configured endpoint", () => {
  const binding = bindStore("s3://reanalysis/x.zarr", STORE)!;
  const code = renderRecipe(
    { template: 'a("{{STORE}}", "{{ENDPOINT}}")', parameter: "s3-path" },
    binding,
    STORE.endpoint,
  );
  assert.equal(code, 'a("/reanalysis/x.zarr", "https://s3.example.org")');
  assert.ok(renderRecipe(TREE_RECIPES[0], binding, STORE.endpoint).includes(binding.httpsUrl));
});

test("runnableRecipes follows the interpreter's packages", () => {
  assert.deepEqual(runnableRecipes(["xarray", "zarr", "fsspec", "numpy"]), ["http"]);
  assert.deepEqual(runnableRecipes(["xarray"]), []);
});

test("recipeAccessExamples: a run control only with a digest AND a runnable recipe", () => {
  const node = { kind: "dataset" as const, path: "s3://reanalysis/x.zarr" };
  const digest = sha(TREE_RECIPES[0].template);
  const shown = recipeAccessExamples(node, { store: STORE });
  assert.equal(shown.length, 1);
  assert.equal(shown[0].id, recipeExampleId("http"));
  assert.equal(shown[0].executable, undefined);
  const runnable = recipeAccessExamples(node, {
    store: STORE,
    digests: { http: digest },
    runnable: ["http"],
  });
  assert.equal(runnable[0].executable, true);
  assert.equal(runnable[0].digest, digest);
  assert.deepEqual(
    recipeAccessExamples({ kind: "directory", path: "s3://reanalysis/" }, { store: STORE }),
    [],
  );
  assert.deepEqual(
    recipeAccessExamples({ kind: "dataset", path: "s3://nope/x.zarr" }, { store: STORE }),
    [],
  );
});

test("resolveRecipeRun re-validates the id, the digest and the store", () => {
  const digest = sha(TREE_RECIPES[0].template);
  const options = { store: STORE, digests: { http: digest }, runnable: ["http"] };
  const ok = resolveRecipeRun(
    { exampleId: "recipe:http", digest: digest.toUpperCase(), datasetId: "s3://reanalysis/x.zarr" },
    options,
  );
  assert.ok(ok);
  assert.ok(ok.source.includes("https://s3.example.org/reanalysis/x.zarr"));
  assert.equal(
    resolveRecipeRun(
      { exampleId: "recipe:http", digest: "0".repeat(64), datasetId: "s3://reanalysis/x.zarr" },
      options,
    ),
    null,
  );
  assert.equal(
    resolveRecipeRun(
      { exampleId: "recipe:other", digest, datasetId: "s3://reanalysis/x.zarr" },
      options,
    ),
    null,
  );
  assert.equal(
    resolveRecipeRun({ exampleId: "recipe:http", digest, datasetId: "s3://evil/x.zarr" }, options),
    null,
  );
  assert.equal(
    resolveRecipeRun(
      { exampleId: "recipe:http", digest, datasetId: "s3://reanalysis/x.zarr" },
      { ...options, runnable: [] },
    ),
    null,
  );
});
