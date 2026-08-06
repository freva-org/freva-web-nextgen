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
  // verdict to stdout.
  {
    files: ["**/scripts/**/*.mjs", "*.config.js"],
    languageOptions: { globals: globals.node },
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
    ignores: ["**/dist/**", "**/dist-test/**", "**/node_modules/**", "docs/"],
  },
);
