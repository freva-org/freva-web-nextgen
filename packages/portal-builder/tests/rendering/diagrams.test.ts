// Build-time diagrams. Nothing about a diagram reaches the reader as code: the artifact carries
// a sanitized SVG with deterministic identifiers and no diagram library. These tests need the
// pinned browser, which is the dependency the canonical image exists to provide.

import { afterAll, describe, expect, it } from "vitest";
import { cleanupFixtures } from "../helpers/fixture.js";
import { errorCodes, renderOne } from "../helpers/render.js";

afterAll(cleanupFixtures);

const page = (body: string): string => `---\ntitle: T\n---\n\n${body}\n`;

describe("mermaid", () => {
  it("renders a diagram into sanitized SVG with a deterministic id", async () => {
    const source = page("```mermaid\nflowchart LR\n  A[Input] --> B[Artifact]\n```");
    const first = await renderOne("t.md", source);
    expect(errorCodes(first)).toEqual([]);
    expect(first.html).toContain('<figure class="portal-diagram">');
    expect(first.html).toContain("<svg");
    // No script, no foreignObject, no event handler survives the sanitizer.
    expect(first.html).not.toContain("<script");
    expect(first.html).not.toContain("foreignObject");
    expect(first.html).not.toMatch(/\son[a-z]+=/);
    expect(first.html).toContain("portal-diagram-");

    // Same source, same bytes: the id seed comes from the source path and the diagram's
    // ordinal, not from a counter or a clock.
    const second = await renderOne("t.md", source);
    expect(second.html).toBe(first.html);
  }, 180_000);

  it("reports invalid diagram source with a location instead of shipping it", async () => {
    const out = await renderOne("t.md", page("```mermaid\nnot a diagram at all {{{\n```"));
    expect(errorCodes(out)).toContain("PC1012");
    const error = out.diagnostics.find((d) => d.code === "PC1012")!;
    expect(error.file).toBe("content/t.md");
    expect(error.position?.line).toBeGreaterThan(0);
  }, 180_000);

  it("refuses a diagram larger than the profile limit before rendering it", async () => {
    const huge = "flowchart LR\n" + "  A --> B\n".repeat(6000);
    const out = await renderOne("t.md", page("```mermaid\n" + huge + "```"));
    expect(errorCodes(out)).toContain("PC1016");
  }, 60_000);

  it("gives two diagrams in one document different identifiers", async () => {
    const out = await renderOne(
      "t.md",
      page("```mermaid\nflowchart LR\n  A --> B\n```\n\n```mermaid\nflowchart TD\n  C --> D\n```"),
    );
    expect(errorCodes(out)).toEqual([]);
    const ids = [...out.html.matchAll(/id="(portal-diagram-[^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(2);
  }, 180_000);
});
