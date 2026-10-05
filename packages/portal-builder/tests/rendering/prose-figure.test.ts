// A prose block's figure: the illustration beside the text. Its files are published assets named
// relative to the landing, counted as referenced; a video adds `media-src 'self'` and the player
// to the entry, and a still-only figure adds neither.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  cleanupFixtures,
  codes,
  resolveFixture,
  tempRoot,
  write,
  writeSite,
} from "../helpers/fixture.js";
import { buildSite } from "../../src/artifact/index.js";
import { canonicalizeRoot } from "../../src/config/paths.js";
import { generateEntryModule } from "../../src/artifact/runtime-projection.js";

afterAll(cleanupFixtures);

// Tiny but real files: a 1x1 PNG, and bytes standing in for a video (served, never decoded here).
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function site(figure: string): string {
  const root = tempRoot("portal-figure-");
  write(root, "content/_fragments/what.md", "Waterpark is a data hub.\n");
  const put = (path: string, bytes: Buffer) => write(root, path, bytes as unknown as string);
  put("assets/landing/park-light.png", PNG);
  put("assets/landing/park-dark.png", PNG);
  put("assets/landing/park-light.mp4", Buffer.from("not really a video"));
  put("assets/landing/park-dark.mp4", Buffer.from("not really a video either"));
  put("assets/landing/park-dark.webm", Buffer.from("nor this"));
  writeSite(root, {
    landing: `schemaVersion: 1
title: Home
blocks:
  - type: prose
    heading: What is Waterpark?
    source: ../content/_fragments/what.md
${figure}`,
    extra: `rendering:
  profile: portal-content-v1
  sources:
    - root: ./content
      mount: /docs/
      files:
        include: ["**/*.md"]
        exclude: ["_fragments/**"]
  assets:
    - root: ./assets
      mount: /assets/
`,
  });
  return root;
}

const FULL = `    figure:
      image: ../assets/landing/park-light.png
      imageDark: ../assets/landing/park-dark.png
      video: ../assets/landing/park-light.mp4
      videoDark: [../assets/landing/park-dark.mp4, ../assets/landing/park-dark.webm]
      alt: Source grids become one HEALPix grid; a cloud rains Zarr into a waterpark.
`;
const STILL = `    figure:
      image: ../assets/landing/park-light.png
      alt: A still.
`;

describe("a prose block's figure", () => {
  it("resolves to published URLs, which count as referenced", async () => {
    const result = await resolveFixture(site(FULL));
    expect(result.diagnostics.errors).toEqual([]);
    const block = result.model!.landings[0]!.blocks[0]!;
    expect(block.figure).toEqual({
      image: "/assets/landing/park-light.png",
      imageDark: "/assets/landing/park-dark.png",
      video: ["/assets/landing/park-light.mp4"],
      videoDark: ["/assets/landing/park-dark.mp4", "/assets/landing/park-dark.webm"],
      alt: "Source grids become one HEALPix grid; a cloud rains Zarr into a waterpark.",
    });
    const unreferenced = result.diagnostics.items.filter((d) => d.code === "FP1408");
    expect(unreferenced.map((d) => d.file)).toEqual([]);
  });

  it("refuses a file that is not a published asset, or of the wrong kind", async () => {
    for (const figure of [
      "    figure:\n      image: ../assets/landing/missing.png\n      alt: x\n",
      "    figure:\n      image: ../content/_fragments/what.md\n      alt: x\n",
      "    figure:\n      image: ../assets/landing/park-light.mp4\n      alt: x\n",
      "    figure:\n      image: ../assets/landing/park-light.png\n      video: ../assets/landing/park-dark.png\n      alt: x\n",
      "    figure:\n      image: ../assets/landing/park-light.png\n      videoDark: ../assets/landing/park-dark.mp4\n      alt: x\n",
      "    figure:\n      image: ../assets/landing/park-light.png\n      video: [../assets/landing/park-light.mp4, ../assets/landing/park-light.png]\n      alt: x\n",
    ]) {
      const result = await resolveFixture(site(figure));
      expect(codes(result.diagnostics.errors)).toContain("FP1201");
    }
  });

  it("is schema-checked: an image and its alternative text are required", async () => {
    const result = await resolveFixture(
      site("    figure:\n      image: ../assets/landing/park-light.png\n"),
    );
    expect(codes(result.diagnostics.errors)).toContain("FP1104");
  });

  it("a video brings its player into the entry; a still alone does not", async () => {
    const video = await resolveFixture(site(FULL));
    expect(generateEntryModule(video.model!)).toContain("components/prose-figure.ts");
    const still = await resolveFixture(site(STILL));
    expect(still.diagnostics.errors).toEqual([]);
    expect(generateEntryModule(still.model!)).not.toContain("prose-figure");
  });

  it("renders text first and the figure beside it, with the video's policy", async () => {
    const root = site(FULL);
    const out = join(tempRoot("portal-figure-out-"), "site");
    const result = await buildSite({
      sourceRoot: canonicalizeRoot(root),
      configPath: join(root, "portal.yaml"),
      outDir: out,
      quiet: true,
    });
    expect(result.diagnostics.errors).toEqual([]);
    const html = readFileSync(join(out, "index.html"), "utf8");
    const section = html.slice(
      html.indexOf("data-figure"),
      html.indexOf("</section>", html.indexOf("data-figure")),
    );
    expect(section.indexOf("portal-content-body")).toBeLessThan(section.indexOf("portal-figure"));
    expect(section).toContain('data-video-light="/assets/landing/park-light.mp4"');
    // Each theme's formats, in order: the player picks the first this browser plays.
    expect(section).toContain(
      'data-video-dark="/assets/landing/park-dark.mp4 /assets/landing/park-dark.webm"',
    );
    expect(section).toMatch(
      /<img[^>]*src="\/assets\/landing\/park-light.png"[^>]*data-portal-only="light"/,
    );
    expect(section).toMatch(
      /<img[^>]*src="\/assets\/landing\/park-dark.png"[^>]*data-portal-only="dark"/,
    );
    // The video has no source until the player gives it one, in view and with motion allowed.
    expect(section).toMatch(/<video[^>]*preload="none"/);
    expect(section).not.toMatch(/<video[^>]*\ssrc=/);
    const policy = JSON.parse(readFileSync(join(out, "host-policy.json"), "utf8")) as {
      csp: { portal: Record<string, string> };
    };
    expect(policy.csp.portal["media-src"]).toBe("'self'");
  }, 120_000);

  it("a still-only figure adds no media-src", async () => {
    const root = site(STILL);
    const out = join(tempRoot("portal-figure-still-"), "site");
    const result = await buildSite({
      sourceRoot: canonicalizeRoot(root),
      configPath: join(root, "portal.yaml"),
      outDir: out,
      quiet: true,
    });
    expect(result.diagnostics.errors).toEqual([]);
    const policy = JSON.parse(readFileSync(join(out, "host-policy.json"), "utf8")) as {
      csp: { portal: Record<string, string> };
    };
    expect(policy.csp.portal["media-src"]).toBeUndefined();
    const html = readFileSync(join(out, "index.html"), "utf8");
    expect(html).not.toContain("<video");
  }, 120_000);
});
