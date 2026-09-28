/**
 * Ambient types for the browser islands. The globals below are the prepared STAC Browser's
 * contract, written only by the generated adapter; declaring them lets `tsconfig.client.json`
 * check the island sources without `any` at the boundary.
 */

declare module "virtual:portal-stac-adapter" {
  export function mountStacBrowser(): Promise<void>;
  export function stacConfig(): Record<string, unknown>;
  export function preprocessSTAC(document: unknown): unknown;
}

interface Window {
  /** Read once by the prepared upstream entry while it is first evaluated. */
  STAC_BROWSER_CONFIG?: Record<string, unknown>;
  /** Exposed by the pinned patch series so a re-entered route can remount. */
  STAC_BROWSER_INIT?: () => Promise<unknown>;
}

/**
 * A stylesheet imported for its bytes, not its effect (see `client/components/*-styles.ts`).
 * `?inline` is Vite's query for the processed CSS as a string with no asset emitted, so a sheet
 * for client-drawn markup rides inside its island's chunk instead of a `<link>` in every head.
 */
declare module "*.css?inline" {
  const css: string;
  export default css;
}

/**
 * The three Prism entry points the snippet editor imports - the same subset, and the same narrow
 * shape, `@freva-org/browser-python` declares for its console. Prism's `components/*` deep imports
 * have no declarations of their own, and narrowing to what is used keeps a typo an error.
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
