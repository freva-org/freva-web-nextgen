import { defineConfig } from "vite";
import dts from "vite-plugin-dts";
import { resolve } from "path";

// Which entry this invocation builds: `npm run build` runs one per entry.
const ENTRY = process.env.DATA_INSPECTOR_ENTRY ?? "index";

export default defineConfig({
  plugins: [
    dts({
      include: ["src"],
      insertTypesEntry: ENTRY === "index",
    }),
  ],
  build: {
    // ONE ENTRY PER BUILD, so every emitted file is self-contained.
    //
    // Three entries in one build would let rollup hoist what they share into a
    // sibling chunk, and a deployment that copies `index.mjs` on its own would then
    // be copying half a package. The cost is that shared code is emitted more than
    // once on disk; a consumer loads one entry, so it is not paid at runtime.
    emptyOutDir: ENTRY === "index",
    lib: {
      entry: resolve(__dirname, `src/${ENTRY}.ts`),
      formats: ["es", "cjs"],
      fileName: (format) => `${ENTRY}.${format === "es" ? "mjs" : "cjs"}`,
    },
  },
});
