// The operator-resolved setup, read from the Lite page config. Nothing here is visitor-controlled:
// `jupyter-lite.json` is written by `prepare-notebook` from portal.yaml.

import type { BrowserPythonAddon, BrowserPythonProfile } from "@freva-org/browser-python";

/** The `litePluginSettings` key this extension reads. */
export const SETTINGS_KEY = "@freva-org/jupyterlite-freva-kernel:kernel";

/** One interpreter setup offered as a kernel. */
export interface KernelSetup {
  /** The kernel name: `freva-python` for the first setup, `freva-python-<id>` for others. */
  id: string;
  label: string;
  profile: BrowserPythonProfile;
  addons: readonly BrowserPythonAddon[];
  optionalAddons: readonly BrowserPythonAddon[];
  /** Run the deployment's starter code in this kernel. */
  runStarter: boolean;
}

export interface KernelSettings {
  runtimeIndexUrl?: string;
  wheelhouseUrl?: string;
  addonBaseUrl?: string;
  setups: readonly KernelSetup[];
  /** The deployment's starter code (`initialSource`), for setups with `runStarter`. */
  starter?: string;
  /**
   * The portal's root URL, defined as `PORTAL_BASE_URL` in every interpreter: written relative to
   * the page for a notebook on the portal's origin, so it follows where the page is served.
   */
  portalBaseUrl?: string;
  /** Live interpreters this page may hold. The playground's ceiling, never above 2. */
  maxLiveInterpreters: number;
  /** How long an interrupted cell may take to stop before a restart is offered. */
  interruptGraceMs: number;
  workspaceMaxFiles?: number;
}

const PROFILES: readonly BrowserPythonProfile[] = ["minimal", "xarray-zarr", "freva-client"];
const ADDONS: readonly BrowserPythonAddon[] = ["dask", "cartopy-natural-earth-110m"];
export const DEFAULT_INTERRUPT_GRACE_MS = 3_000;
const ID = /^[a-z][a-z0-9-]{0,63}$/;

function url(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  try {
    const parsed = new URL(value, globalThis.location?.href ?? "https://invalid.example/");
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

function addons(value: unknown): BrowserPythonAddon[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((a): a is BrowserPythonAddon => ADDONS.includes(a)))].sort();
}

/** Validate the raw settings; anything unrecognised is dropped rather than guessed at. */
export function readSettings(raw: unknown): KernelSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const setups: KernelSetup[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(r.setups) ? r.setups : []) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const profile = e.profile as BrowserPythonProfile;
    const id = typeof e.id === "string" && ID.test(e.id) ? e.id : null;
    if (!id || seen.has(id) || !PROFILES.includes(profile)) continue;
    seen.add(id);
    const own = addons(e.addons);
    setups.push({
      id,
      label: typeof e.label === "string" && e.label.length <= 80 ? e.label : profile,
      profile,
      addons: own,
      optionalAddons: addons(e.optionalAddons).filter((a) => own.includes(a)),
      runStarter: e.runStarter === true,
    });
  }
  if (setups.length === 0) {
    setups.push({
      id: "default",
      label: "minimal",
      profile: "minimal",
      addons: [],
      optionalAddons: [],
      runStarter: false,
    });
  }
  const max = Number(r.maxLiveInterpreters);
  const grace = Number(r.interruptGraceMs);
  const files = Number(r.workspaceMaxFiles);
  const settings: KernelSettings = {
    setups,
    maxLiveInterpreters: Number.isInteger(max) && max >= 1 ? Math.min(2, max) : 2,
    interruptGraceMs:
      Number.isFinite(grace) && grace >= 500 && grace <= 60_000
        ? grace
        : DEFAULT_INTERRUPT_GRACE_MS,
  };
  const runtime = url(r.runtimeIndexUrl);
  const wheelhouse = url(r.wheelhouseUrl);
  const addonBase = url(r.addonBaseUrl);
  if (runtime) settings.runtimeIndexUrl = runtime;
  if (wheelhouse) settings.wheelhouseUrl = wheelhouse;
  if (addonBase) settings.addonBaseUrl = addonBase;
  if (Number.isInteger(files) && files >= 1 && files <= 1024) settings.workspaceMaxFiles = files;
  if (typeof r.starter === "string" && r.starter.length > 0 && r.starter.length <= 4096) {
    settings.starter = r.starter;
  }
  const portalBase = url(r.portalBaseUrl);
  if (portalBase) settings.portalBaseUrl = portalBase;
  return settings;
}

/**
 * `PORTAL_BASE_URL` as code the interpreter runs unseen at every start, before the starter. A
 * parsed URL is printable ASCII, so its JSON string is a Python literal of the same text.
 */
export function portalBaseSource(href: string): string {
  return `PORTAL_BASE_URL = ${JSON.stringify(href)}`;
}

/** The kernel name for a setup: the first is the plain `freva-python`. */
export function kernelName(setup: KernelSetup, index: number): string {
  return index === 0 ? "freva-python" : `freva-python-${setup.id}`;
}
