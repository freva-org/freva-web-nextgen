/**
 * Module declarations for the Prism entry points this package imports. Prism's `components/*`
 * deep imports have no declarations at all: `@types/prismjs` describes the bundled entry point,
 * not the three-file subset this package imports to keep the highlighter at 4.8 KiB gzipped.
 * (jquery.terminal ships its own types, so only its factory signature is adapted, at the single
 * call site in the adapter.) Both are narrowed to exactly what is used, so a typo in a call is
 * still an error.
 */

declare module "prismjs/components/prism-core.js" {
  interface PrismLanguages {
    python?: unknown;
    [language: string]: unknown;
  }
  interface PrismStatic {
    languages: PrismLanguages;
    tokenize(text: string, grammar: unknown): unknown[];
  }
  const Prism: PrismStatic;
  export default Prism;
}

declare module "prismjs/components/prism-clike.js";
declare module "prismjs/components/prism-python.js";
