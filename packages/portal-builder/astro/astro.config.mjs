// @ts-check
/**
 * Configuration for `astro check` only. A consumer build never reads it: `buildSite()`
 * calls Astro's programmatic API with `configFile: false` and maps the `virtual:portal-*`
 * specifiers itself. The aliases below let the page templates type-check in isolation,
 * with the real `ResolvedPortalModel` behind the model import.
 */
import { defineConfig } from "astro/config";
import { fileURLToPath } from "node:url";

const stub = (name) => fileURLToPath(new URL(`./src/dev-stubs/${name}`, import.meta.url));

export default defineConfig({
  srcDir: "./src",
  output: "static",
  trailingSlash: "always",
  build: { format: "directory", assets: "_portal", inlineStylesheets: "never" },
  vite: {
    resolve: {
      alias: {
        "virtual:portal-model": stub("portal-model.ts"),
        "virtual:portal-theme.css": stub("empty.css"),
        "virtual:portal-code.css": stub("empty.css"),
        "virtual:portal-math.css": stub("empty.css"),
        "virtual:portal-entry": stub("portal-model.ts"),
      },
    },
  },
});
