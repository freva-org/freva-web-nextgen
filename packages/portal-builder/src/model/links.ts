/**
 * Typed navigation and action targets. A link to a *known but disabled* component is omitted with
 * a diagnostic; a link to an unknown name is an error. That pair makes enable/disable a one-field
 * operation: without the first, turning a component off would mean editing navigation too;
 * without the second, a typo would silently disappear from the site.
 */

import { serializeSearchIntentV1 } from "@freva-org/databrowser/intent";
import type { Diagnostic } from "../diagnostics.js";
import type { RawLink } from "../config/types.js";
import type {
  DatabrowserOptions,
  ResolvedComponent,
  ResolvedLanding,
  ResolvedLink,
  SearchIntentV1,
} from "./types.js";

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
  /** Registered example id -> the site path of the page that offers it (run-example actions). */
  examples?: Map<string, string>;
  /**
   * The notebook, when the portal deploys one: its origin, `root` (the origin plus the
   * deployment's base path, where the notebook's site sits) and whether it has a Lab interface.
   */
  notebook?: { origin: string; root: string; lab: boolean };
}

export interface LinkResolution {
  link?: ResolvedLink;
  diagnostics: Diagnostic[];
  /** True when the target is a deliberately disabled component. */
  omitted?: boolean;
}

export function resolveLink(raw: RawLink, ctx: LinkContext): LinkResolution {
  const diagnostics: Diagnostic[] = [];

  if (raw.intent !== undefined) return resolveIntent(raw, ctx);

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

  if (raw.notebook !== undefined) {
    const notebook = ctx.notebook;
    const missing = !notebook
      ? "the notebook is not enabled (`pythonPlayground.notebook.enabled`, with `playgroundOrigin`)"
      : raw.notebook === "lab" && !notebook.lab
        ? "the notebook has no Lab interface (it needs `notebook.assistant` or `notebook.dataPanel`)"
        : undefined;
    if (missing || !notebook) {
      diagnostics.push({
        code: "FP1201",
        severity: "error",
        message: `Link '${raw.label}' targets the notebook, but ${missing}.`,
        file: ctx.file,
        pointer: ctx.pointer,
      });
      return { diagnostics };
    }
    return {
      link: {
        label: raw.label,
        href: `${notebook.root}/notebook/${raw.notebook === "lab" ? "lab" : "tree"}/index.html`,
        external: true,
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

/**
 * A typed action on an existing component. The URL is built by the component's own serializer
 * from typed values, never from a template or an expression: select-facet and open-dataset are a
 * `SearchIntentV1` for an enabled Data Browser; run-example is the page that offers a registered
 * example, whose run control the visitor still presses - navigation never runs code.
 */
function resolveIntent(raw: RawLink, ctx: LinkContext): LinkResolution {
  const diagnostics: Diagnostic[] = [];
  const fail = (code: string, message: string): LinkResolution => {
    diagnostics.push({ code, severity: "error", message, file: ctx.file, pointer: ctx.pointer });
    return { diagnostics };
  };
  if (raw.intent === "run-example") {
    const path = ctx.examples?.get(raw.example ?? "");
    if (!path) {
      return fail(
        "FP1201",
        `run-example names '${raw.example}', which no page registers. Mark a code block try-in-python and use the id the build reports.`,
      );
    }
    return {
      link: { label: raw.label, href: href(ctx.basePath, path), external: false },
      diagnostics,
    };
  }
  const component = ctx.components.get(raw.component ?? "");
  if (!component)
    return fail("FP1201", `The action targets the unknown component '${raw.component}'.`);
  if (!component.enabled) {
    diagnostics.push({
      code: "FP1202",
      severity: "info",
      message: `The ${raw.intent} action on the disabled component '${raw.component}' is omitted.`,
      file: ctx.file,
      pointer: ctx.pointer,
    });
    return { diagnostics, omitted: true };
  }
  if (component.kind !== "databrowser" || !component.route) {
    return fail(
      "FP1232",
      `${raw.intent} acts on an enabled databrowser component; '${raw.component}' is a ${component.kind}.`,
    );
  }
  const options = component.options as DatabrowserOptions;
  const intent: SearchIntentV1 = { v: 1, flavour: raw.flavour ?? options.defaultFlavour };
  if (raw.intent === "select-facet") {
    const facets: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(raw.facets ?? {})) {
      facets[key] = Array.isArray(value) ? value : [value];
    }
    intent.facets = facets;
  } else {
    intent.q = raw.dataset ?? "";
  }
  return {
    link: {
      label: raw.label,
      href: `${href(ctx.basePath, component.route)}?${serializeSearchIntentV1(intent)}`,
      external: false,
      componentId: component.id,
    },
    diagnostics,
  };
}
