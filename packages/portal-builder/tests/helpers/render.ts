// A small harness for rendering one document without a whole site around it.

import { join } from "node:path";
import { canonicalizeRoot } from "../../src/config/paths.js";
import {
  ContentPipeline,
  discoverPages,
  type ContentSourceSpec,
} from "../../src/rendering/content.js";
import { loadProfile } from "../../src/rendering/profile.js";
import type { Diagnostic } from "../../src/diagnostics.js";
import type { RegisteredContentExample } from "../../src/model/types.js";
import { mkdir, tempRoot, write } from "./fixture.js";

export interface RenderOutcome {
  html: string;
  diagnostics: Diagnostic[];
  headings: { depth: number; id: string; text: string }[];
  codeCss?: string;
  runnable?: RegisteredContentExample[];
}

/** Render one Markdown or RST source and return its sanitized fragment. */
export async function renderOne(
  filename: string,
  source: string,
  extras: Record<string, string> = {},
  options: { runnable?: boolean } = {},
): Promise<RenderOutcome> {
  const root = tempRoot("portal-render-");
  mkdir(root, "content");
  write(root, `content/${filename}`, source);
  for (const [path, body] of Object.entries(extras)) write(root, path, body);

  const canonical = canonicalizeRoot(root);
  const { profile } = loadProfile();
  const specs: ContentSourceSpec[] = [
    {
      root: { absolute: join(canonical, "content"), relative: "content", mount: "/docs/" },
      include: ["**/*.md", "**/*.rst"],
      exclude: [],
    },
  ];
  const discovered = discoverPages(specs, new Set());
  const pipeline = new ContentPipeline(profile, profile.limits, options.runnable ?? false);
  const result = await pipeline.run(
    discovered.docs,
    [],
    {
      routes: new Set(["/"]),
      files: new Map([["/assets/logo.svg", "/assets/logo.svg"]]),
      subsiteMounts: [],
      assetsBySource: new Map([["assets/logo.svg", "/assets/logo.svg"]]),
      routeOwner: new Map(),
      basePath: "/",
    },
    () => true,
  );
  const page = result.pages[0];
  return {
    html: page?.fragment.html ?? "",
    diagnostics: [...discovered.diagnostics, ...result.diagnostics],
    headings: page ? [...page.fragment.headings] : [],
    ...(page?.fragment.runnable ? { runnable: page.fragment.runnable } : {}),
    ...(result.codeCss ? { codeCss: result.codeCss } : {}),
  };
}

export function errorCodes(outcome: RenderOutcome): string[] {
  return outcome.diagnostics.filter((d) => d.severity === "error").map((d) => d.code);
}
