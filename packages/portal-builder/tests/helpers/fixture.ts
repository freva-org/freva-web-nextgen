// Test fixtures. Every test that touches the resolver builds its own throwaway source root, so a
// test reads as one document rather than as a diff against a shared fixture nobody wants to
// change.

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { canonicalizeRoot } from "../../src/config/paths.js";
import { resolveModel, type ResolveOptions, type ResolveResult } from "../../src/model/resolve.js";
import type { Diagnostic } from "../../src/diagnostics.js";

export const REPO_ROOT = resolve(new URL("../../../..", import.meta.url).pathname);
export const MINIMAL_EXAMPLE = join(REPO_ROOT, "examples", "minimal-portal");
export const FULL_EXAMPLE = join(REPO_ROOT, "examples", "full-portal");

const created: string[] = [];

export function tempRoot(prefix = "portal-fixture-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

export function cleanupFixtures(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function write(root: string, relativePath: string, content: string): string {
  const target = join(root, ...relativePath.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
  return target;
}

export function mkdir(root: string, relativePath: string): string {
  const target = join(root, ...relativePath.split("/"));
  mkdirSync(target, { recursive: true });
  return target;
}

export function link(root: string, relativePath: string, target: string): void {
  const location = join(root, ...relativePath.split("/"));
  mkdirSync(dirname(location), { recursive: true });
  symlinkSync(target, location);
}

export const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><title>Mark</title><rect width="16" height="16" fill="#123456"/></svg>`;

export interface SiteOptions {
  /** Extra top-level YAML appended verbatim. */
  extra?: string;
  canonicalUrl?: string;
  landing?: string;
  content?: Record<string, string>;
  theme?: string;
  /** Indented YAML for `theme.tokens`, so a fixture can exercise the closed token set. */
  themeTokens?: string;
}

/** A minimal, valid site; tests add exactly the part they are about. */
export function writeSite(root: string, options: SiteOptions = {}): void {
  write(root, "assets/logo.svg", LOGO_SVG);
  write(root, "assets/favicon.svg", LOGO_SVG);
  write(
    root,
    "landings/home.yaml",
    options.landing ??
      `schemaVersion: 1
title: Test Site
blocks:
  - type: hero
    heading: Hello
`,
  );
  for (const [path, body] of Object.entries(options.content ?? {})) write(root, path, body);
  write(
    root,
    "portal.yaml",
    `schemaVersion: 1
site:
  id: test-site
  title: Test Site
  language: en
  canonicalUrl: ${options.canonicalUrl ?? "https://portal.example.org/"}
  identity:
    logo: ./assets/logo.svg
    favicon: ./assets/favicon.svg
theme:
  preset: ${options.theme ?? "default"}${options.themeTokens ? `\n  tokens:\n${options.themeTokens}` : ""}
landings:
  home:
    path: /
    source: ./landings/home.yaml
${options.extra ?? ""}`,
  );
}

export async function resolveFixture(
  root: string,
  overrides: Partial<ResolveOptions> = {},
): Promise<ResolveResult> {
  return resolveModel({
    sourceRoot: canonicalizeRoot(root),
    configPath: join(root, "portal.yaml"),
    ...overrides,
  });
}

export function codes(diagnostics: { items: Diagnostic[] } | Diagnostic[]): string[] {
  const items = Array.isArray(diagnostics) ? diagnostics : diagnostics.items;
  return items.map((d) => d.code);
}

export function messages(result: ResolveResult): string {
  return result.diagnostics.items.map((d) => `${d.code} ${d.message}`).join("\n");
}
