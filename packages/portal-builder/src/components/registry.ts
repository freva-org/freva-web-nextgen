// The closed built-in component registry. Registration is what makes "disabled" provable: each
// entry names the modules and static roots the component owns, so the build can look at the
// real Rollup graph and the real copy manifest and fail if anything owned by a disabled
// component is present - through a barrel, a CSS import, a shared chunk or a stray copy.

import type { ComponentKind, ServiceKind } from "../model/types.js";

export interface ComponentRegistration {
  kind: ComponentKind;
  /** The service kind this component requires when enabled, if any. */
  requiredServiceKind: ServiceKind;
  /** Does it own a user-facing route? */
  routed: boolean;
  /** Default route when the consumer does not set one. */
  defaultRoute?: string;
  /** Technical routes it owns when enabled, such as the auth callback. */
  technicalRoutes: (options: Record<string, unknown>) => string[];
  /** Client island entry, relative to the builder package. */
  browserEntry: string;
  /**
   * Normalized module-id prefixes this component owns. Nothing matching these may appear in the
   * graph when the component is disabled.
   */
  ownedModuleRoots: string[];
  /** Static roots copied only for this component. */
  ownedStaticRoots: string[];
  /** Output asset namespaces attributable to this component. */
  assetNamespaces: string[];
  /** Shared modules it may legitimately retain when enabled. */
  allowedSharedModules: string[];
  /** Theme tokens the component is allowed to read. */
  allowedThemeTokens: string[];
  /**
   * Content Security Policy directives this component's *shipped code* needs beyond the portal
   * baseline. It exists so the recorded policy describes the artifact honestly: a policy the
   * artifact cannot satisfy is worse than none, because it would be switched off in production
   * the first time it broke a page.
   */
  cspRequirements: Record<string, string[]>;
  /**
   * Directives this component's OWN service origin must appear in, beyond `connect-src`. Every
   * service origin reaches `connect-src`, because that is how the artifact talks to it; for one
   * component the answer also contains URLs the browser is then asked to LOAD, a STAC
   * document's imagery on the service's own origin being the common case. Declared per
   * component rather than derived for every service, because it is not true of every service:
   * an auth broker's origin has no business in `img-src`.
   */
  serviceOriginDirectives: string[];
  /** v1 allows at most one instance of each kind (page-global state upstream). */
  maxInstances: number;
  defaultTitle: string;
  defaultDescription: string;
}

export const COMPONENT_REGISTRY: Record<ComponentKind, ComponentRegistration> = {
  databrowser: {
    kind: "databrowser",
    requiredServiceKind: "databrowser",
    routed: true,
    defaultRoute: "/data/",
    technicalRoutes: () => [],
    browserEntry: "client/components/databrowser.ts",
    ownedModuleRoots: [
      "pkg:npm/%40freva-org/databrowser",
      "pkg:npm/%40freva-org/freva-client-terminal",
      "builder:client/components/databrowser.ts",
    ],
    ownedStaticRoots: [],
    assetNamespaces: ["assets/portal-databrowser"],
    allowedSharedModules: [
      "builder:client/shell.ts",
      "builder:client/runtime.ts",
      // Reached from here too: the Data Browser imports the packaged inspector dependency on
      // first Inspect rather than fetching it from a CDN. Owned by neither this plan nor the
      // dataset tree's - see the note in `src/model/dataset-tree.ts`.
      "pkg:npm/%40freva-org/data-inspector",
    ],
    allowedThemeTokens: ["colorAccent", "colorSurface", "colorText", "colorBorder"],
    // The component injects its own stylesheet as a `<style>` element, a deliberate part of
    // its embedding contract rather than authored content.
    cspRequirements: { "style-src": ["'unsafe-inline'"] },
    // The Data Browser renders its own results as markup. It loads no image the API points at, so
    // its origin has no reason to be anywhere but `connect-src`.
    serviceOriginDirectives: [],
    maxInstances: 1,
    defaultTitle: "Data Browser",
    defaultDescription: "Search and inspect published datasets.",
  },
  "stac-browser": {
    kind: "stac-browser",
    requiredServiceKind: "stac",
    routed: true,
    defaultRoute: "/catalog/",
    technicalRoutes: () => [],
    browserEntry: "client/components/stac.ts",
    ownedModuleRoots: [
      "builder:client/components/stac.ts",
      "builder:generated/stac-adapter",
      "stac-materials:",
    ],
    ownedStaticRoots: ["stac"],
    assetNamespaces: ["assets/portal-stac", "stac"],
    allowedSharedModules: ["builder:client/shell.ts", "builder:client/runtime.ts"],
    allowedThemeTokens: ["colorAccent", "colorSurface", "colorText"],
    // What the pinned upstream build needs that the portal baseline does not grant.
    //
    // `'unsafe-inline'` for styles because the application sets element styles at runtime - a
    // property of the pinned build, not a consumer setting, so the artifact records it rather
    // than shipping a policy it cannot satisfy; removing it is an upstream or adapter change.
    // `blob:` for images because the map, the GeoTIFF preview and the code box all render
    // through `URL.createObjectURL`. `data:` is deliberately NOT listed: the baseline already
    // grants `img-src data:` for the inline SVG icons in upstream's stylesheets. Nor is
    // `font-src data:`: the prepared tree contains no font file and no `@font-face` at all.
    // `tests/artifact/csp.test.ts` checks both against the real tree.
    cspRequirements: {
      "style-src": ["'unsafe-inline'"],
      "img-src": ["blob:"],
    },
    // A catalogue's imagery lives on the catalogue's own origin: STAC documents carry
    // thumbnails, previews and overviews as assets, and an API that serves the documents serves
    // those too. Granting the origin in `connect-src` alone loads the catalogue and not one
    // thing it points at, so every collection tile draws its `alt` text.
    //
    // `access.basemapOrigins` is not the answer: it is a statement about third-party MAP TILES,
    // and using it to unblock a thumbnail would have a deployment declare something it does not
    // mean, both to a reader of the policy and to the mounted application, which reads the same
    // list to decide which tile layers it may draw.
    serviceOriginDirectives: ["img-src"],
    maxInstances: 1,
    defaultTitle: "Catalog",
    defaultDescription: "Browse the STAC catalog.",
  },
  auth: {
    kind: "auth",
    requiredServiceKind: "auth",
    routed: false,
    technicalRoutes: (options) => {
      const path =
        typeof options.callbackPath === "string" ? options.callbackPath : "/auth/callback/";
      return [path];
    },
    browserEntry: "client/components/auth.ts",
    ownedModuleRoots: [
      "pkg:npm/%40freva-org/ts-oidc-auth-client",
      "builder:client/components/auth.ts",
      "builder:client/components/auth-callback.ts",
    ],
    ownedStaticRoots: [],
    assetNamespaces: ["assets/portal-auth"],
    allowedSharedModules: ["builder:client/shell.ts", "builder:client/runtime.ts"],
    allowedThemeTokens: ["colorAccent", "colorText"],
    cspRequirements: {},
    // An identity provider's origin is talked TO and never rendered FROM. Widening any loading
    // directive to it would grant a capability nothing in the artifact uses.
    serviceOriginDirectives: [],
    maxInstances: 1,
    defaultTitle: "Account",
    defaultDescription: "Sign in to use authenticated features.",
  },
};

export const COMPONENT_KINDS = Object.keys(COMPONENT_REGISTRY) as ComponentKind[];

export function registrationFor(kind: ComponentKind): ComponentRegistration {
  return COMPONENT_REGISTRY[kind];
}
