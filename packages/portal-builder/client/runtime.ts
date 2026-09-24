/**
 * The public runtime projection: everything the browser is told at build time, and short on
 * purpose - public endpoints and non-secret options for the components that were enabled. Nothing
 * about routes, navigation, theme or content, because the site's structure is already HTML by the
 * time this loads.
 */

export interface DatabrowserRuntime {
  id: string;
  mountId: string;
  apiBase: string;
  flavour: string;
  fixedFacets: Record<string, string | string[]>;
  /** See `DatabrowserOptions` in the model - these are its three shaping options, projected. */
  defaultLayout: "browse" | "overview";
  overview: { order: string[]; mainFacets: string[] | null };
  scopeRemovable: boolean;
  authentication: "none" | "optional" | "required";
}

export interface StacRuntime {
  id: string;
  mountId: string;
}

export interface AuthRuntime {
  id: string;
  authBaseUrl: string;
  redirectUri: string;
  expectedIssuer?: string;
  allowedResourceOrigins: string[];
  callbackPath: string;
  basePath: string;
}

export interface PortalRuntime {
  siteId: string;
  basePath: string;
  databrowser?: DatabrowserRuntime;
  stac?: StacRuntime;
  auth?: AuthRuntime;
}

export interface AuthBridge {
  /** Current bearer, or null when anonymous. Never stored in build output. */
  token(): string | null;
  login(): void;
  logout(): void;
}
