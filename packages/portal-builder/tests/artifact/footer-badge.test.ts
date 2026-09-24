// The footer badge is a package the portal *mounts*: the builder never reads its JavaScript,
// processes an image or decides what it draws. So these assertions cover what the builder is
// responsible for - an enabled footer has a badge without being asked, a footer that switched it
// off contains no trace of one, and either way the artifact carries exactly the bytes its quality
// can reach, at the right URLs, on every kind of route, without widening its own policy.
//
// The behavioural half - the panel is not clipped, focus stays inside it, no motion is fetched
// before intent - cannot be decided from files and lives in `delivery/parity/badge-probe.mjs`,
// which drives a real browser.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupFixtures, resolveFixture, tempRoot, writeSite } from "../helpers/fixture.js";
import { buildFixture, writeMatrixSite, STAC_MATERIALS } from "../helpers/site.js";
import { STATUS_PAGES } from "../../src/model/status-pages.js";
import { CODES, DiagnosticBag } from "../../src/diagnostics.js";
import { publishFooterBadge } from "../../src/model/footer-badge.js";
import { PACKAGE_ROOT } from "../../src/util/package.js";

afterAll(cleanupFixtures);

/** Every file in an artifact, as forward-slashed artifact-relative paths. */
function tree(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(relative(dir, full).split(sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * Documents of every kind a deployment serves, not just the landing page. The STAC route is
 * included only when this checkout can build one: it is an application route like the Data
 * Browser's and worth covering when present, but the badge has nothing to do with STAC, and
 * requiring a prepared third-party application would fail on every clean checkout.
 */
const EVERY_KIND_OF_ROUTE = [
  "index.html",
  "docs/guide/index.html",
  "data/index.html",
  ...(STAC_MATERIALS ? ["catalog/index.html"] : []),
  "404.html",
  "503.html",
];

const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

interface Built {
  out: string;
  files: string[];
  html(route: string): string;
  policy(): { csp: { portal: Record<string, string> } };
}

async function build(
  options: Parameters<typeof writeMatrixSite>[0],
  prefix: string,
): Promise<Built> {
  const source = writeMatrixSite(options);
  const out = join(tempRoot(prefix), "site");
  const result = await buildFixture(source, out);
  expect(result.diagnostics.errors).toEqual([]);
  return {
    out,
    files: tree(out),
    html: (route) => readFileSync(join(out, ...route.split("/")), "utf8"),
    policy: () => JSON.parse(readFileSync(join(out, "host-policy.json"), "utf8")),
  };
}

const MATRIX = { databrowser: true, stac: Boolean(STAC_MATERIALS), auth: false } as const;

describe("a footer that says nothing about a badge", () => {
  let silent: Built;

  beforeAll(async () => {
    silent = await build({ ...MATRIX }, "portal-badge-default-");
  }, 180_000);

  it("has one anyway, on every kind of route", () => {
    for (const route of EVERY_KIND_OF_ROUTE) {
      const html = silent.html(route);
      expect(count(html, 'id="portal-footer-badge"')).toBe(1);
      expect(count(html, 'data-portal-badge="freva"')).toBe(1);
      expect(html).not.toContain("portal-freva-lockup");
    }
  });

  it("gets the standard quality, without writing it down", () => {
    expect(silent.html("index.html")).toContain('data-portal-badge-quality="standard"');
    const twoX = silent.files.filter((f) => f.startsWith("_badge/") && f.includes("@2x"));
    expect(twoX).toEqual(["_badge/assets/story@2x.webp"]);
  });
});

describe("a footer that switched the badge off", () => {
  let plain: Built;

  beforeAll(async () => {
    plain = await build({ ...MATRIX, badge: "off" }, "portal-badge-off-");
  }, 180_000);

  it("contains no badge file of any kind", () => {
    expect(existsSync(join(plain.out, "_badge"))).toBe(false);
    const suspicious = plain.files.filter((f) =>
      /badge|freva-badge|motion|bridge@|ground@|still@|story@/.test(f),
    );
    expect(suspicious).toEqual([]);
  });

  it("contains no badge markup, script, stylesheet link or manifest reference", () => {
    for (const route of EVERY_KIND_OF_ROUTE) {
      const html = plain.html(route);
      expect(html).not.toContain("_badge");
      expect(html).not.toContain("portal-footer-badge");
      expect(html).not.toContain("data-portal-badge");
      expect(html).not.toContain("freva-badge");
    }
  });

  it("carries no byte of the package, in any file it does ship", () => {
    // Named precisely, because there *is* one trace: the shell's always-shipped stylesheet keeps
    // the ~90-byte layout rule for the span that reserves the badge's width in the bar. That is
    // the portal's own rule for an element this build never renders - no package CSS, no package
    // script, no manifest, no sprite, no markup.
    for (const file of plain.files.filter((f) => f.endsWith(".css"))) {
      const css = readFileSync(join(plain.out, ...file.split("/")), "utf8");
      expect(css).not.toContain(".fb ");
      expect(css).not.toContain("--fb-ftr-h");
      expect(css).not.toContain("pop__in");
    }
  });

  it("contains no badge code in any script it does ship", () => {
    for (const file of plain.files.filter((f) => f.endsWith(".js"))) {
      const source = readFileSync(join(plain.out, ...file.split("/")), "utf8");
      expect(source).not.toContain("FrevaBadgeOptions");
      expect(source).not.toContain("mountFooterBadge");
      expect(source).not.toContain("_badge/");
    }
  });

  it("shows the plain lockup again, and the organisation, unchanged", () => {
    for (const route of EVERY_KIND_OF_ROUTE) {
      expect(plain.html(route)).toContain("portal-freva-lockup");
    }
    expect(plain.html("index.html")).toContain("Matrix Site");
  });
});

describe("a footer that is not there at all", () => {
  it("has no badge behind it", async () => {
    const none = await build({ ...MATRIX, footer: false }, "portal-badge-nofooter-");
    expect(existsSync(join(none.out, "_badge"))).toBe(false);
    for (const route of EVERY_KIND_OF_ROUTE) {
      const html = none.html(route);
      expect(html).not.toContain("portal-footer-badge");
      expect(html).not.toContain("_badge");
      expect(html).not.toContain("portal-footer-bar");
    }
  }, 180_000);

  it("is not overruled by a badge that says it is enabled", async () => {
    const root = tempRoot("portal-badge-conflict-");
    writeSite(root, {
      extra: "chrome:\n  footer:\n    enabled: false\n    badge:\n      enabled: true\n",
    });
    const result = await resolveFixture(root);
    expect(result.diagnostics.errors).toEqual([]);
    expect(result.model?.chrome.footer.badge).toBeUndefined();
  });
});

describe("a portal that asked for the standard badge in so many words", () => {
  let standard: Built;

  beforeAll(async () => {
    standard = await build({ ...MATRIX, badge: "standard" }, "portal-badge-std-");
  }, 180_000);

  it("mounts exactly one badge on every kind of route, and no second one", () => {
    for (const route of EVERY_KIND_OF_ROUTE) {
      const html = standard.html(route);
      expect(count(html, 'id="portal-footer-badge"')).toBe(1);
      expect(count(html, 'data-portal-badge="freva"')).toBe(1);
      expect(count(html, "_badge/freva-badge.css")).toBe(1);
    }
  });

  it("appears on every status document a host can serve", () => {
    for (const page of STATUS_PAGES) {
      expect(count(standard.html(`${page.code}.html`), 'id="portal-footer-badge"')).toBe(1);
    }
  });

  it("replaces the plain lockup rather than joining it", () => {
    for (const route of EVERY_KIND_OF_ROUTE) {
      expect(standard.html(route)).not.toContain("portal-freva-lockup");
    }
  });

  it("leaves the rest of the footer alone", () => {
    const html = standard.html("index.html");
    expect(html).toContain("portal-footer");
    expect(html).toContain("Matrix Site");
  });

  it("publishes only the assets a 1x runtime can ask for", () => {
    const badge = standard.files.filter((f) => f.startsWith("_badge/"));
    expect(badge).toContain("_badge/freva-badge.js");
    expect(badge).toContain("_badge/freva-badge.css");
    expect(badge).toContain("_badge/assets/motion/bridge@1x.json");
    // The only 2x file that survives is the still, which has no 1x variant.
    const twoX = badge.filter((f) => f.includes("@2x"));
    expect(twoX).toEqual(["_badge/assets/story@2x.webp"]);
  });

  it("does not preload the bridge or the ground", () => {
    for (const route of EVERY_KIND_OF_ROUTE) {
      const html = standard.html(route);
      expect(html).not.toMatch(/rel=["'](?:pre)?(?:load|fetch)["'][^>]*(?:bridge|ground)/);
      expect(html).not.toContain("bridge@");
      expect(html).not.toContain("ground@");
      expect(html).not.toContain("story@");
    }
  });

  it("says where its own assets are, so the runtime never guesses", () => {
    const html = standard.html("data/index.html");
    expect(html).toContain('data-portal-badge-assets="/_badge/assets/"');
    expect(html).toContain('data-portal-badge-quality="standard"');
  });
});

describe("a configuration written before the badge became the default", () => {
  it("still produces exactly one badge, now at the default quality", async () => {
    const legacy = await build({ ...MATRIX, badge: "kind-only" }, "portal-badge-legacy-");
    for (const route of EVERY_KIND_OF_ROUTE) {
      expect(count(legacy.html(route), 'id="portal-footer-badge"')).toBe(1);
    }
    expect(legacy.html("index.html")).toContain('data-portal-badge-quality="standard"');
  }, 180_000);
});

describe("a portal that asked for automatic quality", () => {
  let auto: Built;

  beforeAll(async () => {
    auto = await build({ ...MATRIX, badge: "auto" }, "portal-badge-auto-");
  }, 180_000);

  it("publishes both densities, because either can be chosen at runtime", () => {
    const badge = auto.files.filter((f) => f.startsWith("_badge/"));
    expect(badge).toContain("_badge/assets/motion/bridge@1x.json");
    expect(badge).toContain("_badge/assets/motion/bridge@2x.json");
    expect(badge).toContain("_badge/assets/motion/ground@2x.json");
  });

  it("still declares nothing but the choice, leaving it to the client", () => {
    expect(auto.html("index.html")).toContain('data-portal-badge-quality="auto"');
  });
});

describe("a badge under a nested mount", () => {
  it("addresses its stylesheet and assets from the mount, not from the root", async () => {
    const nested = await build(
      { ...MATRIX, badge: "standard", canonicalUrl: "https://portal.example.org/waterpark/" },
      "portal-badge-nested-",
    );
    const html = nested.html("data/index.html");
    expect(html).toContain('href="/waterpark/_badge/freva-badge.css"');
    expect(html).toContain('data-portal-badge-assets="/waterpark/_badge/assets/"');
    expect(html).not.toContain('="/_badge/');
  }, 180_000);
});

describe("the badge and the deployment's own policy", () => {
  it("needs no relaxation of the content security policy", async () => {
    const [off, on] = await Promise.all([
      build({ ...MATRIX, badge: "off" }, "portal-badge-csp-off-"),
      build({ ...MATRIX, badge: "standard" }, "portal-badge-csp-on-"),
    ]);
    const before = off.policy().csp.portal;
    const after = on.policy().csp.portal;
    // Byte-identical is the real assertion: the badge changes nothing.
    expect(after).toEqual(before);
    // And the directives it would have had to widen stay narrow. `style-src` carries
    // `'unsafe-inline'` in both, from the shell's own inlined critical CSS, untouched here.
    expect(after["script-src"]).not.toContain("unsafe-inline");
    expect(after["script-src"]).not.toContain("unsafe-eval");
    expect(after["script-src"]).not.toMatch(/https?:/);
    expect(after["default-src"]).toBe("'none'");
    expect(after["connect-src"]).not.toMatch(/badge/);
    // The badge's own absence, not the absence of every origin: `img-src` legitimately carries
    // the catalogue service's origin in BOTH builds, because a STAC document's thumbnails live
    // there, and the byte-identical comparison above already covers that.
    expect(after["img-src"]).not.toMatch(/badge/);
  }, 240_000);

  it("adds no inline script of its own", async () => {
    const on = await build({ ...MATRIX, badge: "standard" }, "portal-badge-inline-");
    for (const route of EVERY_KIND_OF_ROUTE) {
      const html = on.html(route);
      expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?FrevaBadge/);
    }
  }, 180_000);
});

describe("the badge's place in the closed configuration", () => {
  const site = (badge: string): string =>
    `chrome:
  footer:
    enabled: true
    badge:
${badge}
`;

  const check = async (badge: string): Promise<string[]> => {
    const root = tempRoot("portal-badge-schema-");
    writeSite(root, { extra: site(badge) });
    const result = await resolveFixture(root);
    return result.diagnostics.errors.map((d) => d.code);
  };

  it("refuses a badge that is not the Freva one", async () => {
    expect(await check("      kind: acme")).not.toEqual([]);
  });

  it("refuses a quality it does not define", async () => {
    expect(await check("      quality: ultra")).not.toEqual([]);
  });

  it("refuses a property it does not define", async () => {
    expect(await check("      colour: teal")).not.toEqual([]);
  });

  it("refuses an enabled that is not a boolean", async () => {
    expect(await check("      enabled: sometimes")).not.toEqual([]);
  });

  it("accepts every shape, including the one deployments already wrote", async () => {
    // A file that spells out `kind` explicitly stays valid alongside one that relies on the
    // default.
    expect(await check("      kind: freva")).toEqual([]);
    expect(await check("      kind: freva\n      quality: standard")).toEqual([]);
    expect(await check("      enabled: false")).toEqual([]);
    expect(await check("      enabled: true")).toEqual([]);
    expect(await check("      quality: auto")).toEqual([]);
  });
});

describe("building the same badge twice", () => {
  it("produces the same bytes", async () => {
    const source = writeMatrixSite({ ...MATRIX, badge: "standard" });
    const first = join(tempRoot("portal-badge-det-a-"), "site");
    const second = join(tempRoot("portal-badge-det-b-"), "site");
    expect((await buildFixture(source, first)).diagnostics.errors).toEqual([]);
    expect((await buildFixture(source, second)).diagnostics.errors).toEqual([]);
    expect(readFileSync(join(second, "checksums.sha256"), "utf8")).toBe(
      readFileSync(join(first, "checksums.sha256"), "utf8"),
    );
    // And the badge's own bytes are in that ledger, not beside it.
    const ledger = readFileSync(join(first, "checksums.sha256"), "utf8");
    expect(ledger).toContain("_badge/freva-badge.js");
    expect(ledger).toContain("_badge/assets/badge-mark.webp");
  }, 300_000);

  it("keeps the badge inside the artifact's stated size", async () => {
    const on = await build({ ...MATRIX, badge: "standard" }, "portal-badge-size-");
    const bytes = on.files
      .filter((f) => f.startsWith("_badge/"))
      .reduce((sum, f) => sum + statSync(join(on.out, ...f.split("/"))).size, 0);
    // The on-demand animation is near 1.65 MB; the whole published set stays under three.
    expect(bytes).toBeLessThan(3 * 1024 * 1024);
  }, 180_000);
});

// Three distinct failures, three codes. Reporting "Credential-looking value in configuration"
// when the badge package cannot be resolved, or resolves to a tree with nothing in it, points a
// reader at the YAML instead of at the missing vendored `dist/`. Neither branch is reachable by
// writing configuration - the resolver has to fail, or the package has to be there and be empty -
// so `resolvePackageDir` is injected.
describe("what the badge says when its runtime is not there", () => {
  const choice = { kind: "freva", quality: "standard" } as const;

  function raise(resolvePackageDir: () => string): { code: string; message: string }[] {
    const bag = new DiagnosticBag();
    const published = publishFooterBadge(choice, "/", bag, resolvePackageDir);
    expect(published).toBeUndefined();
    return bag.items.map((d) => ({ code: d.code, message: d.message }));
  }

  it("names the package when it is not installed at all", () => {
    const raised = raise(() => {
      throw new Error("Cannot find module '@freva-org/freva-badge/package.json'");
    });
    expect(raised.map((d) => d.code)).toEqual(["FP1213"]);
    expect(raised[0]!.message).toContain("not installed");
    // And not the credential code, which sends a reader to the YAML.
    expect(raised.map((d) => d.code)).not.toContain("FP1210");
  });

  it("says the runtime is vendored when the package is there and its dist is not", () => {
    const dir = tempRoot("portal-badge-nodist-");
    const raised = raise(() => dir);
    expect(raised.map((d) => d.code)).toEqual(["FP1214"]);
    // The remedy is the load-bearing part: `@freva-org/freva-badge/dist` is vendored and that
    // package's build script is a deliberate no-op, so the obvious next move - run the build -
    // does nothing at all, and the message has to say so.
    expect(raised[0]!.message).toContain("vendored");
    expect(raised[0]!.message).toMatch(/build.*cannot regenerate|cannot regenerate/i);
  });

  it("distinguishes an empty runtime from a missing one", () => {
    const dir = tempRoot("portal-badge-emptydist-");
    mkdirSync(join(dir, "dist"), { recursive: true });
    const raised = raise(() => dir);
    expect(raised.map((d) => d.code)).toEqual(["FP1214"]);
    expect(raised[0]!.message).toContain("nothing in it is publishable");
  });

  it("gives each failure its own registered category", () => {
    // A code is a category; three categories under one code is no category at all.
    expect(CODES.FP1210).toBe("Credential-looking value in configuration");
    expect(CODES.FP1213).toBe("Required package is not installed");
    expect(CODES.FP1214).toBe("Installed package carries no publishable runtime");
  });
});

// The vendored runtime, present in this checkout. `@freva-org/freva-badge/dist` is not build
// output: the package's `build` script is a deliberate no-op printing "dist/ is vendored, not
// built", so a tree arriving without that directory cannot be repaired by building it, and every
// build of every portal with a footer fails, because the badge is on by default. An export that
// filters `dist/` out of every package - right for the other twelve, wrong for this one -
// produces an archive that builds on no machine without a copy to restore from, and the failure
// surfaces two steps away, inside a consumer's `validate`. This is the step where it belongs.
describe("the badge's runtime is vendored, so this checkout has to carry it", () => {
  const dist = join(PACKAGE_ROOT, "..", "freva-badge", "dist");

  it("is present, and is not something the build could have made", () => {
    expect(existsSync(dist), `${dist} is missing`).toBe(true);

    const manifest = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, "..", "freva-badge", "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    // If this ever becomes a real build, the rest of this test is the wrong guard and should go.
    expect(manifest.scripts?.build ?? "").toContain("vendored");
  });

  it("carries the files a published badge is made of", () => {
    const files: string[] = [];
    const walk = (at: string): void => {
      for (const entry of readdirSync(at, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(at, entry.name));
        else files.push(relative(dist, join(at, entry.name)).split(sep).join("/"));
      }
    };
    walk(dist);
    // The entry, its stylesheet and at least one asset: a bad export leaves an empty or
    // half-copied directory behind, which passes a bare existsSync.
    expect(files).toContain("freva-badge.js");
    expect(files).toContain("freva-badge.css");
    expect(files.some((file) => file.startsWith("assets/"))).toBe(true);
    expect(files.length).toBeGreaterThan(20);
  });
});
