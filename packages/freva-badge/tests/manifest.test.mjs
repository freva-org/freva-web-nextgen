// The vendored drop, checked against itself.
//
// This package has no build step: `dist/` is committed as it arrives from upstream, so the failure
// mode is not a compilation error but a manifest naming a chunk nobody shipped - a bird that stops
// mid-stride on somebody's deployment weeks later. Every reference the runtime can follow is
// resolved here, at drop time.
//
// Run with `npm test -w @freva-org/freva-badge`.

import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const ASSETS = join(DIST, "assets");
const read = (rel) => JSON.parse(readFileSync(join(ASSETS, rel), "utf8"));

let checks = 0;
const check = (what, fn) => {
  fn();
  checks += 1;
  console.log(`  ok  ${what}`);
};

console.log("the runtime's three files");
for (const file of ["freva-badge.js", "freva-badge-content.js", "freva-badge.css"]) {
  check(file, () => assert.ok(statSync(join(DIST, file)).size > 0, `${file} is empty or missing`));
}

console.log("every selector in the stylesheet is scoped");
check("no unscoped rule", () => {
  const css = readFileSync(join(DIST, "freva-badge.css"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/@(?:keyframes|font-face|property)[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g, "");
  const offenders = [];
  for (const match of css.matchAll(/(^|[};])\s*([^@{};][^{}]*)\{/g)) {
    for (const selector of match[2].split(",")) {
      const trimmed = selector.trim();
      // `@media`/`@supports` preludes are not selectors; the rules inside
      // them are matched by this same loop on the next iteration.
      if (!trimmed || trimmed.startsWith("@") || trimmed.startsWith("%") || /^\d/.test(trimmed))
        continue;
      if (!/(^|[\s>+~(])\.fb\b/.test(trimmed) && trimmed !== ".fb") offenders.push(trimmed);
    }
  }
  assert.deepEqual(offenders, [], `unscoped: ${offenders.slice(0, 5).join(" | ")}`);
});

console.log("the static mark and the story sheet");
check("badge-mark.webp", () => assert.ok(existsSync(join(ASSETS, "badge-mark.webp"))));
check("story.json names a sheet that exists", () => {
  const story = read("story.json");
  assert.ok(story.count > 0 && story.cols > 0, "story.json has no frame count");
  assert.ok(existsSync(join(ASSETS, "story@2x.webp")), "story@2x.webp is missing");
  assert.equal(
    story.rows ?? Math.ceil(story.count / story.cols),
    Math.ceil(story.count / story.cols),
  );
});

console.log("every motion manifest resolves");
for (const kind of ["bridge", "ground"]) {
  for (const scale of ["1x", "2x"]) {
    const name = `motion/${kind}@${scale}.json`;
    check(name, () => {
      const manifest = read(name);
      assert.equal(manifest.kind, kind);
      assert.equal(manifest.scaleKey, scale);
      assert.ok(Array.isArray(manifest.chunks) && manifest.chunks.length > 0);
      // `count` is the source table's length; the ground loop ships fewer frames than its
      // source and wraps. What has to hold is that the chunks are contiguous from zero and that
      // every frame the rect table names is inside one of them - a gap is a bird that stops
      // mid-stride.
      let next = 0;
      for (const chunk of manifest.chunks) {
        const file = join(ASSETS, "motion", chunk.f);
        assert.ok(existsSync(file), `${name} names ${chunk.f}, which is not here`);
        assert.ok(statSync(file).size > 0, `${chunk.f} is empty`);
        assert.equal(chunk.from, next, `${name}: ${chunk.f} starts at ${chunk.from}, not ${next}`);
        assert.ok(chunk.to >= chunk.from, `${name}: ${chunk.f} ends before it starts`);
        next = chunk.to + 1;
      }
      const frames = Object.keys(manifest.rect)
        .map(Number)
        .sort((a, b) => a - b);
      assert.equal(
        frames.length,
        next,
        `${name}: ${frames.length} rects for ${next} shipped frames`,
      );
      assert.equal(frames[0], 0, `${name}: the rect table does not start at frame 0`);
      assert.equal(frames.at(-1), next - 1, `${name}: the rect table runs past the last chunk`);
      assert.ok(
        next <= manifest.count,
        `${name}: ships ${next} frames from a ${manifest.count}-frame source`,
      );
    });
  }
}

console.log("the reduced-motion still, at both densities");
for (const scale of ["1x", "2x"]) {
  check(`still@${scale}`, () => {
    read(`motion/still@${scale}.json`);
    assert.ok(existsSync(join(ASSETS, "motion", `still@${scale}.webp`)));
  });
}

console.log("every organisation's mark resolves, and is a bare SVG");
check("assets/orgs", () => {
  const content = readFileSync(join(DIST, "freva-badge-content.js"), "utf8");
  const logos = [...content.matchAll(/logo:\s*'([^']+)'/g)].map((m) => m[1]).filter(Boolean);
  assert.ok(logos.length >= 12, `only ${logos.length} organisations carry a mark`);
  for (const logo of logos) {
    const file = join(ASSETS, logo);
    assert.ok(existsSync(file), `${logo} is named but not here`);
    const svg = readFileSync(file, "utf8");
    // These are rendered into the panel and served to every visitor, so the
    // interesting property is not that they look right - it is that they are
    // inert: no script, no external fetch, no embedded raster, no handler.
    for (const forbidden of [
      "<script",
      "<foreignObject",
      "<image",
      "xlink:href",
      "javascript:",
      "data:",
      " on",
    ]) {
      assert.ok(!svg.includes(forbidden), `${logo} contains ${forbidden.trim()}`);
    }
    assert.match(svg, /viewBox="0 0 64 64"/, `${logo} is not a 64-unit square`);
  }
  // Every mark has a home to link to.
  const hrefs = [...content.matchAll(/href:\s*'(https?:[^']+)'/g)].map((m) => m[1]);
  assert.ok(hrefs.length >= logos.length, "an organisation has a mark but no link");
  for (const href of hrefs) assert.match(href, /^https:\/\//, `${href} is not https`);
});

console.log("nothing upstream-only came along");
check("no master, tool, result or demo", () => {
  for (const forbidden of ["masters", "tools", "results", "demo", "baseline"]) {
    assert.ok(!existsSync(join(DIST, "..", forbidden)), `${forbidden}/ must not be vendored`);
  }
});

console.log(`\n${checks} checks passed.`);
