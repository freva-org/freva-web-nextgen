/**
 * What upstream ships and this repository refuses to publish. Four of the five dropped files are
 * unused: a deployment-owned configuration script the adapter replaces, a second entry document
 * the portal generates, and an Apache rewrite contradicting the artifact's host policy. The fifth
 * is not: `sw.js` is StreamSaver's service worker and `mitm.html` the frame handing it a message
 * port - at the deployment's origin they intercept every request under their scope, one relaxed
 * CSP directive from going live and outliving the page that registered them; only the portal's
 * `default-src 'none'`, with no `worker-src` or `frame-src`, stops them today. The compiled tree
 * must still CONTAIN these files, since a drop list matching nothing is no policy; the prepared
 * tree must not.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DROPPED = ["index.html", "runtime-config.js", ".htaccess", "sw.js", "mitm.html"];

test("the preparation stage names every dropped file, and says why", () => {
  const source = readFileSync(join(PKG, "scripts", "prepare-materials.mjs"), "utf8");
  const declared = /const DROP = new Set\(\[([^\]]*)\]\)/.exec(source);
  assert.ok(declared, "prepare-materials.mjs no longer declares a DROP set");
  const names = [...declared[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual([...names].sort(), [...DROPPED].sort());

  // The service worker's absence is a security decision rather than tidiness, so the reasoning
  // must survive in the file that does the dropping.
  const rationale = source.slice(0, declared.index);
  for (const phrase of ["service worker", "worker-src", "spaFallback"]) {
    assert.ok(rationale.includes(phrase), `the DROP rationale no longer mentions '${phrase}'`);
  }
});

test("the compiled tree still contains what the drop list drops", (t) => {
  const dist = process.env.FREVA_STAC_DIST_OUT
    ? resolve(process.env.FREVA_STAC_DIST_OUT)
    : join(PKG, "dist");
  if (!existsSync(join(dist, "index.html"))) {
    // An ordinary bootstrap compiles no upstream, and that is a supported state.
    t.skip("no compiled upstream tree in this checkout");
    return;
  }
  for (const name of DROPPED) {
    assert.ok(
      existsSync(join(dist, name)),
      `upstream no longer ships '${name}'. Re-read the drop rationale before deleting the entry: ` +
        "a rule that matches nothing protects nothing.",
    );
  }
});

test("no prepared tree carries a service worker, a frame document or host configuration", (t) => {
  const materials = process.env.FREVA_STAC_MATERIALS_OUT
    ? resolve(process.env.FREVA_STAC_MATERIALS_OUT)
    : join(PKG, "materials");
  if (!existsSync(join(materials, "materials.json"))) {
    t.skip("no prepared materials in this checkout");
    return;
  }
  const manifest = JSON.parse(readFileSync(join(materials, "materials.json"), "utf8"));
  const paths = manifest.files.map((file) => file.path);
  for (const name of DROPPED) {
    assert.ok(!paths.includes(name), `the manifest lists '${name}'`);
    assert.ok(!existsSync(join(materials, name)), `the prepared tree contains '${name}'`);
  }
  // Nor under a hashed or renamed variant: a worker is identified by what it does, not where the
  // build put it - and `swift-<hash>.js` is a highlighting chunk, not a service worker.
  const suspicious = paths.filter((path) =>
    /(^|\/)(sw\.js|sw-[^/]*\.js|service-?worker[^/]*\.js)$/i.test(path),
  );
  assert.deepEqual(suspicious, [], `prepared tree carries worker-shaped scripts: ${suspicious}`);
});
