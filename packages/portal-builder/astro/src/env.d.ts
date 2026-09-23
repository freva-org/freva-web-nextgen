/// <reference types="astro/client" />

declare module "virtual:portal-model" {
  const model: import("../../src/model/types.js").ResolvedPortalModel;
  export default model;
}
declare module "virtual:portal-theme.css" {}
declare module "virtual:portal-code.css" {}
declare module "virtual:portal-math.css" {}
declare module "virtual:portal-stac.css" {}
declare module "virtual:portal-databrowser.css" {}
declare module "virtual:portal-entry" {}
declare module "virtual:portal-stac-adapter" {
  export function mountStacBrowser(): Promise<void>;
  export function stacConfig(): Record<string, unknown>;
  export function preprocessSTAC(doc: unknown): unknown;
}
