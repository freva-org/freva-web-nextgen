// Build-time Mermaid rendering.
//
// Mermaid needs a real layout engine, so it runs inside the browser the builder image already
// pins, once per build, and what reaches the artifact is a sanitized SVG with deterministic
// identifiers. Nothing about diagrams ships to the reader: no Mermaid bundle, no client-side
// render, no layout shift. If the browser is unavailable this reports FP1702 and fails the
// build, since a diagram silently degrading to escaped source text is worse than an explicit,
// actionable error.

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import type { Diagnostic } from "../diagnostics.js";
import type { HElement } from "./html.js";
import type { ContentProfile } from "./profile.js";
import { sanitizeSvg } from "./svg.js";

interface PageLike {
  goto(url: string): Promise<unknown>;
  addScriptTag(options: { path: string }): Promise<unknown>;
  evaluate<T, A>(fn: (arg: A) => T | Promise<T>, arg: A): Promise<T>;
}

interface BrowserLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}

export interface MermaidRenderRequest {
  code: string;
  /** Deterministic id, derived from the source path and the diagram's ordinal. */
  id: string;
  file: string;
  line?: number;
}

export interface MermaidRenderResult {
  id: string;
  svg?: string;
  /** The sanitized tree, so the caller never re-parses its own output. */
  root?: HElement;
  /**
   * The same diagram in the dark palette.
   *
   * Mermaid writes its colours into a `<style>` block inside the SVG, keyed by the diagram's
   * own id - nine hard-coded values with no `var(--`, no `prefers-color-scheme` and no
   * `data-theme` - so a build-time diagram cannot follow a theme the reader picks later, and
   * is white boxes with black labels on a dark page. Rewriting that stylesheet afterwards
   * either enumerates every value mermaid derives from its few base colours, and rots when
   * upstream retunes one, or misses some. So mermaid renders both palettes and the page shows
   * one, at the cost of bytes on documents that have diagrams.
   */
  darkRoot?: HElement;
  diagnostics: Diagnostic[];
}

const require_ = createRequire(import.meta.url);

function mermaidBundlePath(): string {
  return require_.resolve("mermaid/dist/mermaid.min.js");
}

/**
 * A container image may pin a browser at a fixed path, not the revision directory the
 * installed Playwright expects. `FREVA_PORTAL_CHROMIUM` names it explicitly; otherwise the
 * default lookup is used.
 */
async function launch(): Promise<BrowserLike> {
  const playwright = (await import("playwright")) as unknown as {
    chromium: {
      launch(options: { args: string[]; executablePath?: string }): Promise<BrowserLike>;
    };
  };
  const args = ["--no-sandbox", "--disable-dev-shm-usage"];
  const pinned = process.env.FREVA_PORTAL_CHROMIUM;
  if (pinned) return playwright.chromium.launch({ args, executablePath: pinned });
  try {
    return await playwright.chromium.launch({ args });
  } catch (error) {
    const fallback = "/opt/pw-browsers/chromium";
    if (existsSync(fallback)) return playwright.chromium.launch({ args, executablePath: fallback });
    throw error;
  }
}

/**
 * Render every diagram in one browser: launching Chromium per diagram would dominate the build
 * time of any page that has more than one.
 */
export async function renderDiagrams(
  requests: MermaidRenderRequest[],
  profile: ContentProfile,
): Promise<MermaidRenderResult[]> {
  if (requests.length === 0) return [];

  let browser: BrowserLike;
  try {
    browser = await launch();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return requests.map((r) => ({
      id: r.id,
      diagnostics: [
        {
          code: "FP1702",
          severity: "error",
          message: `Mermaid renders at build time and needs the pinned browser, which could not start: ${message}`,
          file: r.file,
          ...(r.line !== undefined ? { position: { line: r.line } } : {}),
          hint: "Use the canonical builder image, or install the repository's pinned Playwright Chromium.",
        } satisfies Diagnostic,
      ],
    }));
  }

  try {
    const page = await browser.newPage();
    await page.goto("about:blank");
    await page.addScriptTag({ path: mermaidBundlePath() });

    const rendered = await page.evaluate(
      async (payload: { requests: { code: string; id: string }[]; securityLevel: string }) => {
        const w = (globalThis as unknown as { window: unknown }).window as {
          mermaid: {
            initialize(config: Record<string, unknown>): void;
            render(id: string, code: string): Promise<{ svg: string }>;
          };
        };
        const results: { id: string; svg?: string; dark?: string; error?: string }[] = [];
        for (const req of payload.requests) {
          // Once per palette; the dark copy gets its own id because mermaid scopes the
          // stylesheet it writes to the diagram's id, and two copies under one id would be two
          // stylesheets fighting over the same selector.
          const draw = async (theme: string, id: string) => {
            // Re-initialized per render so the deterministic seed is that copy's own id: two
            // diagrams in one document must not share generated ids either.
            w.mermaid.initialize({
              startOnLoad: false,
              securityLevel: payload.securityLevel,
              deterministicIds: true,
              deterministicIDSeed: id,
              htmlLabels: false,
              flowchart: { htmlLabels: false },
              theme,
              fontFamily: "inherit",
            });
            const { svg } = await w.mermaid.render(id, req.code);
            return svg;
          };
          try {
            const svg = await draw("neutral", req.id);
            const dark = await draw("dark", `${req.id}-dark`);
            results.push({ id: req.id, svg, dark });
          } catch (e) {
            results.push({ id: req.id, error: e instanceof Error ? e.message : String(e) });
          }
        }
        return results;
      },
      {
        requests: requests.map((r) => ({ code: r.code, id: r.id })),
        securityLevel: profile.mermaid.securityLevel,
      },
    );

    return rendered.map((result, index) => {
      const req = requests[index]!;
      if (!result.svg) {
        return {
          id: result.id,
          diagnostics: [
            {
              code: "PC1012",
              severity: "error",
              message: `Invalid diagram: ${result.error ?? "no SVG was produced"}`,
              file: req.file,
              ...(req.line !== undefined ? { position: { line: req.line } } : {}),
            } satisfies Diagnostic,
          ],
        };
      }
      const sanitized = sanitizeSvg(result.svg, req.file, profile, { generatedBy: "mermaid" });
      const out: MermaidRenderResult = { id: result.id, diagnostics: sanitized.diagnostics };
      if (sanitized.ok) {
        out.svg = sanitized.svg;
        if (sanitized.root) out.root = sanitized.root;
      }
      // The dark copy goes through the same sanitizer on the same profile: a second SVG from
      // the same generator, not a variant that skips anything.
      if (result.dark) {
        const dark = sanitizeSvg(result.dark, req.file, profile, { generatedBy: "mermaid" });
        out.diagnostics = [...out.diagnostics, ...dark.diagnostics];
        if (dark.ok && dark.root) out.darkRoot = dark.root;
      }
      return out;
    });
  } finally {
    await browser.close();
  }
}
