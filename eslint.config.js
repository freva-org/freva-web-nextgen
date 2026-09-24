// @ts-check
import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-expressions": ["error", { allowTernary: true }],
      "@typescript-eslint/consistent-type-imports": "error",
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
  {
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "no-console": "off",
    },
  },
  // Build/release tooling: plain Node ESM scripts whose whole job is to print a
  // verdict to stdout. A few of them install jsdom globals and then drive the component, so both
  // global sets are legitimate here for the same reason they are in browser-tests.
  {
    files: ["**/scripts/**/*.mjs", "*.config.js", "**/astro.config.mjs"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: { "no-console": "off" },
  },
  // Browser-test drivers: Node on the outside, page callbacks evaluated inside a
  // real browser on the inside, so both global sets are legitimate here.
  {
    files: ["**/browser-tests/**/*.mjs"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: { "no-console": "off" },
  },

  {
    files: ["**/tests/**/*.mjs", "**/bin/*.mjs"],
    languageOptions: { globals: { ...globals.node } },
    rules: { "no-console": "off" },
  },
  // A package's playground page
  {
    files: [
      "packages/*/playground/**/*.js",
      // The fictional consumer sites carry their own page scripts, written the way a
      // consumer would write them.
      "examples/**/*.js",
      // Deliberately plain, unbundled browser JavaScript
      "packages/*/demo/**/*.js",
    ],
    languageOptions: { globals: { ...globals.browser } },
    rules: { "no-console": "off" },
  },
  // A CommonJS preload: it must be CJS, because it monkeypatches Node's own modules before any
  // ESM graph is evaluated.
  {
    files: ["**/*.cjs"],
    languageOptions: { sourceType: "commonjs", globals: { ...globals.node } },
    rules: { "@typescript-eslint/no-require-imports": "off", "no-console": "off" },
  },
  {
    files: ["packages/portal-builder/client/components/cosmos/scene.js"],
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
      "no-empty": "off",
      "no-console": "off",
    },
  },
  {
    files: ["packages/portal-builder/client/components/cosmos/art/*.mjs"],
    languageOptions: { globals: { ...globals.browser } },
    rules: { "no-empty": "off", "no-console": "off" },
  },
  {
    ignores: [
      "**/dist/**",
      "**/dist-test/**",
      "**/node_modules/**",
      "docs/",
      // browser-python's bundling gate writes a bundle here.
      "packages/browser-python/.testbundle/**",
      // The pinned Pyodide distribution, assembled locally for the browser suites and the demo.
      "packages/browser-python/.runtime/**",
      // A fetched third-party checkout and the prepared STAC tree: neither is ours to lint.
      "packages/stac-browser/.upstream/**",
      "packages/stac-browser/materials/**",
      // Astro's generated type shims, written by `astro check`.
      "packages/portal-builder/.astro/**",
      "packages/portal-builder/astro/.astro/**",
      "packages/portal-builder/astro/src/env.d.ts",
      "packages/portal-builder/.portal-build/**",
      "packages/portal-builder/reports/**",
      // The RST helper's virtualenv from `npm run bootstrap`: docutils ships its own JavaScript.
      "**/.venv/**",
    ],
  },
);
