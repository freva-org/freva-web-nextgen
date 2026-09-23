/**
 * Typed navigation and action targets. A link to a *known but disabled* component is omitted with
 * a diagnostic; a link to an unknown name is an error. That pair makes enable/disable a one-field
 * operation: without the first, turning a component off would mean editing navigation too;
 * without the second, a typo would silently disappear from the site.
 */

import type { Diagnostic } from "../diagnostics.js";
import type { RawLink } from "../config/types.js";
import type { ResolvedComponent, ResolvedLanding, ResolvedLink } from "./types.js";

export interface LinkContext {
  basePath: string;
  landings: Map<string, ResolvedLanding>;
  components: Map<string, ResolvedComponent>;
  /** Site-logical paths that exist: routes, static files and subsite mounts. */
  knownPaths: Set<string>;
  subsiteMounts: string[];
  staticFiles: Set<string>;
  pointer: string;
  file: string;
}

export interface LinkResolution {
  link?: ResolvedLink;
  diagnostics: Diagnostic[];
  /** True when the target is a deliberately disabled component. */
  omitted?: boolean;
}

export function resolveLink(raw: RawLink, ctx: LinkContext): LinkResolution {
  const diagnostics: Diagnostic[] = [];

  if (raw.landing !== undefined) {
    const landing = ctx.landings.get(raw.landing);
    if (!landing) {
      diagnostics.push({
        code: "FP1201",
        severity: "error",
        message: `Navigation target references the unknown landing '${raw.landing}'.`,
        file: ctx.file,
        pointer: ctx.pointer,
      });
      return { diagnostics };
    }
    return {
      link: {
        label: raw.label,
        href: href(ctx.basePath, landing.path),
        external: false,
        landingId: landing.id,
        ...(raw.description ? { description: raw.description } : {}),
      },
      diagnostics,
    };
  }

  if (raw.component !== undefined) {
    const component = ctx.components.get(raw.component);
    if (!component) {
      diagnostics.push({
        code: "FP1201",
        severity: "error",
        message: `Navigation target references the unknown component '${raw.component}'.`,
        file: ctx.file,
        pointer: ctx.pointer,
      });
      return { diagnostics };
    }
    if (!component.enabled) {
      diagnostics.push({
        code: "FP1202",
        severity: "info",
        message: `Reference to the disabled component '${raw.component}' is omitted.`,
        file: ctx.file,
        pointer: ctx.pointer,
      });
      return { diagnostics, omitted: true };
    }
    if (!component.route) {
      diagnostics.push({
        code: "FP1201",
        severity: "error",
        message: `Component '${raw.component}' has no user-facing route to link to.`,
        file: ctx.file,
        pointer: ctx.pointer,
      });
      return { diagnostics };
    }
    return {
      link: {
        label: raw.label,
        href: href(ctx.basePath, component.route),
        external: false,
        componentId: component.id,
        ...(raw.description ? { description: raw.description } : {}),
      },
      diagnostics,
    };
  }

  const value = (raw.href ?? "").trim();
  if (value.startsWith("https://") || value.startsWith("mailto:")) {
    return {
      link: {
        label: raw.label,
        href: value,
        external: true,
        ...(raw.description ? { description: raw.description } : {}),
      },
      diagnostics,
    };
  }
  if (!value.startsWith("/")) {
    diagnostics.push({
      code: "FP1201",
      severity: "error",
      message: `Link '${value}' must be an internal site path, an HTTPS URL or a mailto: address.`,
      file: ctx.file,
      pointer: ctx.pointer,
    });
    return { diagnostics };
  }

  const normalized = value.endsWith("/") ? value : `${value}/`;
  const known =
    ctx.knownPaths.has(normalized) ||
    ctx.staticFiles.has(value) ||
    ctx.subsiteMounts.some((m) => value.startsWith(m));
  if (!known) {
    diagnostics.push({
      code: "FP1201",
      severity: "error",
      message: `Internal link '${value}' matches no generated route, static file or subsite mount.`,
      file: ctx.file,
      pointer: ctx.pointer,
      hint: "A raw internal href to a missing route is an error; use a typed landing/component target where possible.",
    });
    return { diagnostics };
  }

  return {
    link: {
      label: raw.label,
      href: `${ctx.basePath.replace(/\/$/, "")}${value}`,
      external: false,
      ...(raw.description ? { description: raw.description } : {}),
    },
    diagnostics,
  };
}

function href(basePath: string, sitePath: string): string {
  return `${basePath.replace(/\/$/, "")}${sitePath}`;
}
