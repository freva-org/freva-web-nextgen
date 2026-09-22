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
    files: ["**/scripts/**/*.mjs", "*.config.js"],
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
      // Deliberately plain, unbundled browser JavaScript
      "packages/*/demo/**/*.js",
    ],
    languageOptions: { globals: { ...globals.browser } },
    rules: { "no-console": "off" },
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
    ],
  },
);
