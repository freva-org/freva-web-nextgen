// A recipe's hole is filled literally and as the body of a Python string literal.
import { describe, expect, it } from "vitest";

import {
  bindStore,
  pythonStringBody,
  renderRecipe,
} from "../../client/components/tree-recipes-core.js";

const recipe = {
  template: 'import xarray as xr\nds = xr.open_dataset("{{STORE}}", engine="zarr")\n',
  parameter: "https-url" as const,
};
const config = {
  endpoint: "https://s3.example.org",
  style: "path" as const,
  roots: [{ bucket: "bucket", prefix: "data/" }],
};

describe("renderRecipe", () => {
  it("inserts a valid store name literally: `$&` and `$'` are text, not replacement patterns", () => {
    const binding = bindStore("s3://bucket/data/a$&b$'c$$d.zarr/", config)!;
    expect(renderRecipe(recipe, binding, config.endpoint)).toBe(
      'import xarray as xr\nds = xr.open_dataset("https://s3.example.org/bucket/data/a$&b$\\\'c$$d.zarr/", engine="zarr")\n',
    );
  });

  it("escapes what could end or bend a Python string literal", () => {
    expect(pythonStringBody(`a"b'c\\d\ne\u0000`)).toBe(`a\\"b\\'c\\\\d\\x0ae\\x00`);
  });
});
