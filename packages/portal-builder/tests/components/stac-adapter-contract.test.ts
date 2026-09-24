// The generated adapter is tested by *running* it, not by re-reading it. Comparing the module's
// text with a fixture proves only that two strings match; it does not prove that the module sets
// the configuration before the application reads it, that a second visit re-enters through the
// prepared init hook rather than importing the bundle twice, or that a stylesheet is added once.
// Those are the contract between the adapter and the patched upstream build, and what breaks on
// an upgrade.

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { generateAdapterModule } from "../../src/components/stac-browser/adapter.js";
import type { StacAdapterInput } from "../../src/components/stac-browser/adapter.js";
import { loadStacMaterials } from "../../src/components/stac-browser/materials.js";
import { STAC_MATERIALS, buildFixture, writeMatrixSite } from "../helpers/site.js";
import { codes, resolveFixture, tempRoot, write } from "../helpers/fixture.js";
import { PACKAGE_ROOT } from "../../src/util/package.js";

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "portal-stac-adapter-"));
  scratch.push(dir);
  return dir;
}

const INPUT: StacAdapterInput = {
  options: {
    chrome: { title: "Example Catalog", footerLinks: [] },
    access: { externalCatalogs: "deny", basemapOrigins: [] },
    rootPage: {},
    linkPolicy: {
      canonicalizeAdvertisedRoot: true,
      hiddenRelations: ["service-desc"],
      rootAliases: [],
    },
    historyMode: "hash",
    pathPrefix: "/site/catalog/",
    catalogUrl: "https://catalog.example.org/stac/",
  },
  entryUrl: "/site/stac/assets/index.js",
  styleUrls: ["/site/stac/assets/index.css"],
  mountId: "stac-browser-mount",
};

describe("the generated adapter, executed", () => {
  it("re-enters through the prepared init hook instead of importing twice", async () => {
    const dir = tempDir();
    const entryFile = join(dir, "entry.mjs");
    writeFileSync(
      entryFile,
      "globalThis.__portalImportCount = (globalThis.__portalImportCount ?? 0) + 1;\nexport default 1;\n",
    );

    const source = generateAdapterModule({ ...INPUT, entryUrl: pathToFileURL(entryFile).href });
    const modulePath = join(dir, "adapter.mjs");
    writeFileSync(modulePath, source);

    const mount = { tagName: "div", children: [] };
    const appended: { rel?: string; href?: string }[] = [];
    let initCalls = 0;
    const fakeWindow: Record<string, unknown> = {
      location: { href: "https://portal.example.org/" },
    };
    const fakeDocument = {
      getElementById: () => mount,
      querySelector: (selector: string) =>
        appended.find((element) => selector.includes(String(element.href))) ?? null,
      createElement: (tagName: string) => ({ tagName }),
      head: { append: (element: { rel?: string; href?: string }) => appended.push(element) },
    };

    const previous = {
      document: (globalThis as Record<string, unknown>).document,
      window: (globalThis as Record<string, unknown>).window,
    };
    (globalThis as Record<string, unknown>).document = fakeDocument;
    (globalThis as Record<string, unknown>).window = fakeWindow;
    delete (globalThis as Record<string, unknown>).__portalImportCount;
    try {
      const module = (await import(pathToFileURL(modulePath).href)) as {
        mountStacBrowser: () => Promise<void>;
      };

      // First visit: no init hook yet, so the bundle is imported once.
      await module.mountStacBrowser();
      expect((globalThis as Record<string, unknown>).__portalImportCount).toBe(1);
      expect(fakeWindow.STAC_BROWSER_CONFIG).toMatchObject({
        historyMode: "hash",
        pathPrefix: "/site/catalog/",
        catalogUrl: "https://catalog.example.org/stac/",
      });
      expect(appended).toHaveLength(1);
      expect(appended[0]).toMatchObject({ rel: "stylesheet" });

      // The patched application exposes an init hook for re-entry. A second
      // mount must use it: importing again would give a second application
      // instance in the same document.
      fakeWindow.STAC_BROWSER_INIT = () => {
        initCalls += 1;
      };
      await module.mountStacBrowser();
      expect(initCalls).toBe(1);
      expect((globalThis as Record<string, unknown>).__portalImportCount).toBe(1);

      // And the stylesheet is added once, not once per visit.
      expect(appended).toHaveLength(1);
    } finally {
      (globalThis as Record<string, unknown>).document = previous.document;
      (globalThis as Record<string, unknown>).window = previous.window;
      delete (globalThis as Record<string, unknown>).__portalImportCount;
    }
  });

  // The catalogue image, resolved where it is actually served from. The portal publishes it
  // root-relative and content-hashed ("/site/identity/stac-mark-<hash>.png") and upstream resolves
  // whatever string it is handed in its own context. Under a base path, or in a preview served
  // from a subdirectory, that is a URL the portal never published and the header image 404s.
  it("resolves the catalogue image against the document, not against upstream's idea of it", async () => {
    const cases = [
      {
        name: "root deployment",
        baseURI: "https://portal.example.org/catalog/",
        image: "/identity/stac-mark-abcdef.png",
        expect: "https://portal.example.org/identity/stac-mark-abcdef.png",
      },
      {
        // What the resolver actually publishes under a base path: `basePath` + the hashed name,
        // so the root-relative form already carries the prefix and must not gain a second one.
        name: "under a base path",
        baseURI: "https://portal.example.org/site/",
        image: "/site/identity/stac-mark-abcdef.png",
        expect: "https://portal.example.org/site/identity/stac-mark-abcdef.png",
      },
      {
        // A preview served from a subdirectory with a document-relative value: this is the case a
        // root-relative resolution against the origin gets wrong.
        name: "local preview over http",
        baseURI: "http://127.0.0.1:4321/site/",
        image: "identity/stac-mark-abcdef.png",
        expect: "http://127.0.0.1:4321/site/identity/stac-mark-abcdef.png",
      },
      {
        name: "already absolute",
        baseURI: "https://portal.example.org/",
        image: "https://assets.example.org/mark.png",
        expect: "https://assets.example.org/mark.png",
      },
    ];

    for (const scenario of cases) {
      const dir = tempDir();
      const source = generateAdapterModule({
        ...INPUT,
        options: {
          ...INPUT.options,
          chrome: { ...INPUT.options.chrome, imageUrl: scenario.image },
        },
      });
      const modulePath = join(dir, "adapter.mjs");
      writeFileSync(modulePath, source);
      const previous = (globalThis as Record<string, unknown>).document;
      (globalThis as Record<string, unknown>).document = { baseURI: scenario.baseURI };
      try {
        const module = (await import(pathToFileURL(modulePath).href)) as {
          stacConfig: () => { catalogImage?: string };
        };
        expect(module.stacConfig().catalogImage, scenario.name).toBe(scenario.expect);
      } finally {
        (globalThis as Record<string, unknown>).document = previous;
      }
    }
  });

  // The catalogue URL upstream is handed, resolved where the page actually is. A deployment states
  // its catalogue the way it states every other portal URL (`/api/.../stac/`). Upstream fetches
  // fine with a relative base, so the catalogue loads and nothing looks wrong, but it cannot then
  // recognise that an advertised ABSOLUTE link belongs to the same catalogue: the child renders
  // with a raw href instead of a browse route, and a click produces `#/http://host/...`, a dead
  // route inside the application.
  it("hands upstream an absolute catalogue URL, resolved against the document", async () => {
    const cases = [
      {
        name: "root deployment",
        baseURI: "https://portal.example.org/catalog/",
        catalogUrl: "/api/freva-nextgen/stac/",
        expect: "https://portal.example.org/api/freva-nextgen/stac/",
      },
      {
        name: "with the query that distinguishes the catalogue",
        baseURI: "https://portal.example.org/site/catalog/",
        catalogUrl: "/api/stac/?visible_collections=a,b",
        expect: "https://portal.example.org/api/stac/?visible_collections=a,b",
      },
      {
        name: "local preview served from a subdirectory",
        baseURI: "http://127.0.0.1:4321/site/",
        catalogUrl: "api/stac/",
        expect: "http://127.0.0.1:4321/site/api/stac/",
      },
      {
        name: "already absolute",
        baseURI: "https://portal.example.org/",
        catalogUrl: "https://catalog.example.org/stac/",
        expect: "https://catalog.example.org/stac/",
      },
    ];

    for (const scenario of cases) {
      const dir = tempDir();
      const source = generateAdapterModule({
        ...INPUT,
        options: { ...INPUT.options, catalogUrl: scenario.catalogUrl },
      });
      const modulePath = join(dir, "adapter.mjs");
      writeFileSync(modulePath, source);
      const previous = (globalThis as Record<string, unknown>).document;
      (globalThis as Record<string, unknown>).document = { baseURI: scenario.baseURI };
      try {
        const module = (await import(pathToFileURL(modulePath).href)) as {
          stacConfig: () => { catalogUrl?: string };
        };
        expect(module.stacConfig().catalogUrl, scenario.name).toBe(scenario.expect);
      } finally {
        (globalThis as Record<string, unknown>).document = previous;
      }
    }
  });

  // A value the URL parser refuses is dropped rather than shipped: upstream renders the catalogue
  // title when there is no image, which is the controlled fallback, but a string that cannot
  // become a URL gets an empty src instead.
  it("drops an unusable image rather than rendering an empty src", async () => {
    const dir = tempDir();
    const source = generateAdapterModule({
      ...INPUT,
      options: { ...INPUT.options, chrome: { ...INPUT.options.chrome, imageUrl: "http://" } },
    });
    const modulePath = join(dir, "adapter.mjs");
    writeFileSync(modulePath, source);
    const previous = (globalThis as Record<string, unknown>).document;
    (globalThis as Record<string, unknown>).document = { baseURI: "https://portal.example.org/" };
    try {
      const module = (await import(pathToFileURL(modulePath).href)) as {
        stacConfig: () => Record<string, unknown>;
      };
      const config = module.stacConfig();
      expect("catalogImage" in config).toBe(false);
      expect(config.catalogTitle).toBe("Example Catalog");
    } finally {
      (globalThis as Record<string, unknown>).document = previous;
    }
  });

  it("does nothing at all when its mount element is absent", async () => {
    const dir = tempDir();
    const entryFile = join(dir, "entry.mjs");
    writeFileSync(entryFile, "globalThis.__portalAbsentImport = true;\nexport default 1;\n");
    const source = generateAdapterModule({ ...INPUT, entryUrl: pathToFileURL(entryFile).href });
    const modulePath = join(dir, "adapter.mjs");
    writeFileSync(modulePath, source);

    const previous = {
      document: (globalThis as Record<string, unknown>).document,
      window: (globalThis as Record<string, unknown>).window,
    };
    (globalThis as Record<string, unknown>).document = {
      getElementById: () => null,
      querySelector: () => null,
      createElement: (tagName: string) => ({ tagName }),
      head: { append: () => undefined },
    };
    (globalThis as Record<string, unknown>).window = {
      location: { href: "https://portal.example.org/" },
    };
    delete (globalThis as Record<string, unknown>).__portalAbsentImport;
    try {
      const module = (await import(pathToFileURL(modulePath).href)) as {
        mountStacBrowser: () => Promise<void>;
      };
      await module.mountStacBrowser();
      expect((globalThis as Record<string, unknown>).__portalAbsentImport).toBeUndefined();
    } finally {
      (globalThis as Record<string, unknown>).document = previous.document;
      (globalThis as Record<string, unknown>).window = previous.window;
    }
  });
});

// These read the prepared tree itself. A checkout that has never run the preparation stage has
// none, and that is a supported state - ordinary bootstrap does not fetch or compile a
// third-party application - so they skip rather than fail.
describe.skipIf(!STAC_MATERIALS)("the prepared materials honour the adapter's contract", () => {
  it("expose the init hook and the mount element the adapter relies on", () => {
    const loaded = loadStacMaterials(STAC_MATERIALS);
    expect(loaded.diagnostics).toEqual([]);
    const materials = loaded.materials!;
    const entry = readFileSync(
      join(materials.realRoot, ...materials.manifest.entry.split("/")),
      "utf8",
    );

    // The two things the framework patch series exists to provide. If an upgrade drops either,
    // the adapter still compiles and the browser shows an empty box.
    expect(entry).toContain("STAC_BROWSER_INIT");
    expect(entry).toContain(materials.manifest.mountId ?? "stac-browser-mount");
  });

  it("ship no deployment-owned runtime configuration", () => {
    const loaded = loadStacMaterials(STAC_MATERIALS);
    const paths = loaded.materials!.manifest.files.map((file) => file.path);
    expect(paths).not.toContain("runtime-config.js");
    expect(paths).not.toContain("index.html");
  });

  it("record the same entry the packaged profile expects", () => {
    const loaded = loadStacMaterials(STAC_MATERIALS);
    const manifest = loaded.materials!.manifest;
    expect(manifest.entry).toMatch(/^assets\/.+\.js$/);
    expect(manifest.styles?.every((style) => style.startsWith("assets/"))).toBe(true);
    expect(PACKAGE_ROOT.length).toBeGreaterThan(0);
  });
});

// The preprocessor, executed against real documents. `preprocessSTAC` decides three behaviours:
// which document counts as the root, what the portal is allowed to say about it, and which
// advertised links get rewritten. Asserting on the module's text would only check that a line is
// spelled a certain way, so these load the generated module and call it.
describe("the generated preprocessor, executed", () => {
  const ROOT = "https://catalog.example.org/stac/";

  async function loadPreprocessor(
    options: Partial<StacAdapterInput["options"]> = {},
    pageHref = "https://portal.example.org/catalog/",
  ): Promise<{
    preprocessSTAC: (doc: unknown) => unknown;
    view: () => string | undefined;
    /** A hash navigation: upstream loads no document, so only the listener runs. */
    hashTo: (hash: string) => void;
    /** A forward navigation through `history.pushState`, which raises no event at all. */
    pushTo: (hash: string) => void;
    restore: () => void;
  }> {
    const dir = tempDir();
    const source = generateAdapterModule({
      ...INPUT,
      options: { ...INPUT.options, ...options },
    });
    const modulePath = join(dir, "adapter.mjs");
    writeFileSync(modulePath, source);

    const previous = {
      document: (globalThis as Record<string, unknown>).document,
      window: (globalThis as Record<string, unknown>).window,
      MutationObserver: (globalThis as Record<string, unknown>).MutationObserver,
    };
    const dataset: Record<string, string> = {};
    const parsed = new URL(pageHref);
    const location = {
      href: pageHref,
      origin: parsed.origin,
      pathname: parsed.pathname,
      hash: parsed.hash,
    };
    const listeners = new Map<string, (() => void)[]>();
    // A stand-in for the application re-rendering into the mount. The adapter watches the mount
    // because a forward navigation in upstream's router fires no event of its own.
    const renders: (() => void)[] = [];
    class FakeObserver {
      constructor(private readonly callback: () => void) {}
      observe(): void {
        renders.push(() => this.callback());
      }
      disconnect(): void {
        renders.length = 0;
      }
    }
    (globalThis as Record<string, unknown>).MutationObserver = FakeObserver;
    (globalThis as Record<string, unknown>).document = {
      documentElement: { dataset },
      baseURI: pageHref,
      getElementById: () => ({ tagName: "div" }),
      querySelector: () => null,
      createElement: (tagName: string) => ({ tagName }),
      head: { append: () => undefined },
    };
    (globalThis as Record<string, unknown>).window = {
      location,
      // Set, so mounting exercises the re-entry path and never imports an entry module.
      STAC_BROWSER_INIT: () => undefined,
      addEventListener: (type: string, handler: () => void) => {
        listeners.set(type, [...(listeners.get(type) ?? []), handler]);
      },
    };
    const module = (await import(pathToFileURL(modulePath).href)) as {
      preprocessSTAC: (doc: unknown) => unknown;
      mountStacBrowser: () => Promise<void>;
    };
    await module.mountStacBrowser();

    const goTo = (hash: string): void => {
      location.hash = hash;
      location.href = `${location.origin}${location.pathname}${hash}`;
    };
    return {
      preprocessSTAC: module.preprocessSTAC,
      view: () => dataset.portalStacView,
      hashTo: (hash: string) => {
        goTo(hash);
        for (const handler of listeners.get("hashchange") ?? []) handler();
      },
      pushTo: (hash: string) => {
        goTo(hash);
        for (const render of renders) render();
      },
      restore: () => {
        (globalThis as Record<string, unknown>).document = previous.document;
        (globalThis as Record<string, unknown>).window = previous.window;
        (globalThis as Record<string, unknown>).MutationObserver = previous.MutationObserver;
      },
    };
  }

  interface Doc {
    type?: string;
    title?: string;
    description?: string;
    keywords?: string[];
    license?: string;
    providers?: { name: string }[];
    links: { rel: string; href: string }[];
  }

  const hrefFor = (doc: Doc, rel: string): string | undefined =>
    doc.links.find((link) => link.rel === rel)?.href;

  it("never guesses that a cross-origin link is an alias of the catalog", async () => {
    const adapter = await loadPreprocessor({
      // Even with an alias declared, only *that* origin is an alias. An unlisted one is a genuine
      // external link, and rewriting it onto the catalogue would turn it into a trusted local one.
      linkPolicy: {
        canonicalizeAdvertisedRoot: true,
        hiddenRelations: [],
        rootAliases: ["https://internal.example.org/stac/"],
      },
    });
    try {
      const doc: Doc = {
        type: "Catalog",
        links: [
          { rel: "self", href: `${ROOT}collections/a` },
          { rel: "parent", href: ROOT },
          // Same *path* as the catalogue, different origin. Nothing about that makes it the
          // catalogue.
          { rel: "related", href: "https://elsewhere.example.net/stac/" },
          { rel: "alternate", href: "https://elsewhere.example.net/stac/collections/a" },
        ],
      };
      adapter.preprocessSTAC(doc);
      expect(hrefFor(doc, "related")).toBe("https://elsewhere.example.net/stac/");
      expect(hrefFor(doc, "alternate")).toBe("https://elsewhere.example.net/stac/collections/a");
    } finally {
      adapter.restore();
    }
  });

  it("recognises the configured root when the query comes back re-encoded", async () => {
    // The portal deploys the catalogue as `/stac/?visible_collections=a,b`. The application sends
    // that through a URL library before it fetches, so the service answers with a `self` of
    // `?visible_collections=a%2Cb`. Comparing the query STRINGS makes those two different
    // catalogues: the root goes unrecognised, so no introduction, no root metadata, every view a
    // child. Root-ness is observed through the projection, because that is what it decides.
    const encoded = await loadPreprocessor({
      catalogUrl: "https://catalog.example.org/stac/?visible_collections=a,b",
      rootPage: { title: "Portal Name" },
    });
    try {
      const doc: Doc = {
        type: "Catalog",
        links: [
          { rel: "self", href: "https://catalog.example.org/stac/?visible_collections=a%2Cb" },
        ],
      };
      encoded.preprocessSTAC(doc);
      expect(doc.title).toBe("Portal Name");
    } finally {
      encoded.restore();
    }

    // Order is not significant either: a client or a proxy may reorder parameters.
    const reordered = await loadPreprocessor({
      catalogUrl: "https://catalog.example.org/stac/?a=1&b=2",
      rootPage: { title: "Portal Name" },
    });
    try {
      const doc: Doc = {
        type: "Catalog",
        links: [{ rel: "self", href: "https://catalog.example.org/stac/?b=2&a=1" }],
      };
      reordered.preprocessSTAC(doc);
      expect(doc.title).toBe("Portal Name");
    } finally {
      reordered.restore();
    }
  });

  it("still treats a different query as a different catalogue", async () => {
    const adapter = await loadPreprocessor({
      catalogUrl: "https://catalog.example.org/stac/?visible_collections=a,b",
      rootPage: { title: "Portal Name" },
    });
    try {
      // One collection fewer is a different view of the archive, not the same one.
      const narrower: Doc = {
        type: "Catalog",
        links: [{ rel: "self", href: "https://catalog.example.org/stac/?visible_collections=a" }],
      };
      adapter.preprocessSTAC(narrower);
      expect(narrower.title).toBeUndefined();

      // And no filter at all is the whole archive.
      const unfiltered: Doc = {
        type: "Catalog",
        links: [{ rel: "self", href: "https://catalog.example.org/stac/" }],
      };
      adapter.preprocessSTAC(unfiltered);
      expect(unfiltered.title).toBeUndefined();
    } finally {
      adapter.restore();
    }
  });

  it("resolves an advertised link against the document that supplied it, not against the page", async () => {
    const adapter = await loadPreprocessor();
    try {
      // The portal page is https://portal.example.org/catalog/. Resolving "../" against *that*
      // yields a portal URL and the root link would never be recognised; resolving it against the
      // document's own `self` yields the catalogue root, which is what it means.
      const doc: Doc = {
        type: "Collection",
        links: [
          { rel: "self", href: `${ROOT}collections/a` },
          { rel: "root", href: "../" },
          { rel: "parent", href: "../" },
        ],
      };
      adapter.preprocessSTAC(doc);
      expect(hrefFor(doc, "root")).toBe(ROOT);
      expect(hrefFor(doc, "parent")).toBe(ROOT);
    } finally {
      adapter.restore();
    }
  });

  it("rewrites a declared alias, and its descendants, onto the public catalogue URL", async () => {
    const adapter = await loadPreprocessor({
      linkPolicy: {
        canonicalizeAdvertisedRoot: true,
        hiddenRelations: [],
        rootAliases: ["https://internal.example.org/stac/"],
      },
    });
    try {
      const doc: Doc = {
        type: "Catalog",
        links: [
          { rel: "self", href: "https://internal.example.org/stac/" },
          { rel: "root", href: "https://internal.example.org/stac/" },
          { rel: "child", href: "https://internal.example.org/stac/collections/a" },
          { rel: "search", href: "https://internal.example.org/stac/search?limit=10" },
        ],
      };
      adapter.preprocessSTAC(doc);
      expect(hrefFor(doc, "root")).toBe(ROOT);
      expect(hrefFor(doc, "child")).toBe(`${ROOT}collections/a`);
      expect(hrefFor(doc, "search")).toBe(`${ROOT}search?limit=10`);
    } finally {
      adapter.restore();
    }
  });

  it("leaves advertised links alone when canonicalisation is switched off", async () => {
    const adapter = await loadPreprocessor({
      linkPolicy: { canonicalizeAdvertisedRoot: false, hiddenRelations: [], rootAliases: [] },
    });
    try {
      const doc: Doc = {
        type: "Catalog",
        links: [
          { rel: "self", href: ROOT },
          { rel: "root", href: "https://catalog.example.org/stac" },
        ],
      };
      adapter.preprocessSTAC(doc);
      expect(hrefFor(doc, "root")).toBe("https://catalog.example.org/stac");
    } finally {
      adapter.restore();
    }
  });

  // The portal owns an introduction region in the route document, and it must appear at the root
  // view and nowhere else - across normal navigation, a hash change, back and forward, a deep link
  // and a reload. The view is the ROUTE, not the document being preprocessed: the root page loads
  // the root AND every child collection for its listing, so the last call before paint describes a
  // collection. The document only confirms that the configured catalogue is really there.
  it("shows the root view only at the root route, and only once the root has loaded", async () => {
    const adapter = await loadPreprocessor();
    try {
      // A child document arriving before any root has been seen is not the root view, even though
      // the browser is sitting at the root route.
      adapter.preprocessSTAC({
        type: "Collection",
        links: [
          { rel: "self", href: `${ROOT}collections/a` },
          { rel: "parent", href: ROOT },
        ],
      });
      expect(adapter.view()).toBe("child");

      adapter.preprocessSTAC({ type: "Catalog", links: [{ rel: "self", href: ROOT }] });
      expect(adapter.view()).toBe("root");

      // The listing's own child documents arrive after it, and must not take the view with them.
      adapter.preprocessSTAC({
        type: "Collection",
        links: [
          { rel: "self", href: `${ROOT}collections/a` },
          { rel: "parent", href: ROOT },
        ],
      });
      adapter.preprocessSTAC({
        type: "Collection",
        links: [
          { rel: "self", href: `${ROOT}collections/b` },
          { rel: "parent", href: ROOT },
        ],
      });
      expect(adapter.view()).toBe("root");

      // A forward navigation into a cached collection: no document is loaded, so the preprocessor
      // does not run, and upstream's router navigates with `history.pushState`, which raises
      // neither `hashchange` nor `popstate`. The only remaining signal is that the application
      // re-rendered, which is why the adapter watches the mount.
      adapter.pushTo("#/collections/a");
      expect(adapter.view()).toBe("child");

      // Back and forward do raise `popstate`, and a bare fragment change raises `hashchange`.
      adapter.hashTo("#/");
      expect(adapter.view()).toBe("root");
      adapter.hashTo("");
      expect(adapter.view()).toBe("root");
    } finally {
      adapter.restore();
    }
  });

  it("does not show the root view on a deep link, even though the root is loaded behind it", async () => {
    // A deep-linked collection still loads the root document - for the breadcrumb and the header -
    // so root-ness of a loaded document cannot be what reveals the introduction.
    const adapter = await loadPreprocessor(
      {},
      "https://portal.example.org/catalog/#/collections/a",
    );
    try {
      adapter.preprocessSTAC({ type: "Catalog", links: [{ rel: "self", href: ROOT }] });
      adapter.preprocessSTAC({
        type: "Collection",
        links: [
          { rel: "self", href: `${ROOT}collections/a` },
          { rel: "parent", href: ROOT },
        ],
      });
      expect(adapter.view()).toBe("child");
    } finally {
      adapter.restore();
    }
  });

  it("reads the route from the path when the deployment is not on hash routing", async () => {
    // `historyMode` and `pathPrefix` are adapter-derived values this module hands to upstream, so
    // reading them back to locate the root route uses this portal's own configuration rather than
    // reverse-engineering upstream's router.
    //
    // The cast is the point of the test: the portal's option type is narrowed to `"hash"`, the
    // only mode this builder emits, while the ADAPTER implements both, and the branch that reads
    // the path instead of the fragment is reachable only with the other value.
    const historyRouting = { historyMode: "history" } as unknown as Partial<
      StacAdapterInput["options"]
    >;
    const atRoot = await loadPreprocessor(
      historyRouting,
      "https://portal.example.org/site/catalog/",
    );
    try {
      atRoot.preprocessSTAC({ type: "Catalog", links: [{ rel: "self", href: ROOT }] });
      expect(atRoot.view()).toBe("root");
    } finally {
      atRoot.restore();
    }

    const below = await loadPreprocessor(
      historyRouting,
      "https://portal.example.org/site/catalog/collections/a",
    );
    try {
      below.preprocessSTAC({ type: "Catalog", links: [{ rel: "self", href: ROOT }] });
      expect(below.view()).toBe("child");
    } finally {
      below.restore();
    }
  });

  it("identifies the root document itself with or without a self link", async () => {
    // Root-ness of the DOCUMENT is what decides whether root metadata is projected onto it, and it
    // is a separate question from which view is on screen.
    const adapter = await loadPreprocessor({ rootPage: { title: "Portal Name" } });
    try {
      const withSelf: Doc = {
        type: "Catalog",
        // A trailing slash is not a different catalogue.
        links: [{ rel: "self", href: "https://catalog.example.org/stac" }],
      };
      adapter.preprocessSTAC(withSelf);
      expect(withSelf.title).toBe("Portal Name");

      // No `self`: a Catalog with no parent is the root; anything with a parent is below it, which
      // is the conservative reading - a false negative hides an introduction, a false positive puts
      // root metadata on a collection.
      const orphan: Doc = { type: "Catalog", links: [] };
      adapter.preprocessSTAC(orphan);
      expect(orphan.title).toBe("Portal Name");

      const parented: Doc = { type: "Catalog", links: [{ rel: "parent", href: ROOT }] };
      adapter.preprocessSTAC(parented);
      expect(parented.title).toBeUndefined();

      const feature: Doc = { type: "Feature", links: [] };
      adapter.preprocessSTAC(feature);
      expect(feature.title).toBeUndefined();
    } finally {
      adapter.restore();
    }
  });

  // Deployment-stated root metadata is a *presentation* of the catalogue: applied to the root
  // document and nothing below it, and never claiming to have changed the remote API.
  it("projects configured root metadata onto the root document only", async () => {
    const adapter = await loadPreprocessor({
      rootPage: {
        title: "Freva Data Portal",
        keywords: ["climate", "cmip6"],
        license: "CC-BY-4.0",
        providers: [{ name: "DKRZ", roles: ["host"] }],
      },
    });
    try {
      const root: Doc = {
        type: "Catalog",
        title: "stac-fastapi",
        description: "Upstream blurb.",
        keywords: ["upstream"],
        links: [{ rel: "self", href: ROOT }],
      };
      adapter.preprocessSTAC(root);
      expect(root.title).toBe("Freva Data Portal");
      expect(root.keywords).toEqual(["climate", "cmip6"]);
      expect(root.license).toBe("CC-BY-4.0");
      expect(root.providers).toEqual([{ name: "DKRZ", roles: ["host"] }]);
      // Nothing the deployment did not state is invented.
      expect(root.description).toBe("Upstream blurb.");

      const child: Doc = {
        type: "Collection",
        title: "Collection A",
        links: [
          { rel: "self", href: `${ROOT}collections/a` },
          { rel: "parent", href: ROOT },
        ],
      };
      adapter.preprocessSTAC(child);
      expect(child.title).toBe("Collection A");
      expect(child.license).toBeUndefined();
      expect(child.providers).toBeUndefined();
    } finally {
      adapter.restore();
    }
  });

  it("suppresses the API's root description when the deployment supplies an introduction", async () => {
    const adapter = await loadPreprocessor({
      rootPage: { introHtml: "<p>Portal-owned intro.</p>" },
    });
    try {
      const root: Doc = {
        type: "Catalog",
        description: "Upstream blurb.",
        links: [{ rel: "self", href: ROOT }],
      };
      adapter.preprocessSTAC(root);
      // The introduction is rendered by the portal's own content pipeline into a region of the
      // route document; leaving the API's description in place would print two blurbs, one above
      // the other. Rendered HTML is never handed to upstream's CommonMark renderer.
      expect(root.description).toBe("");

      const child: Doc = {
        type: "Collection",
        description: "Collection blurb.",
        links: [
          { rel: "self", href: `${ROOT}collections/a` },
          { rel: "parent", href: ROOT },
        ],
      };
      adapter.preprocessSTAC(child);
      expect(child.description).toBe("Collection blurb.");
    } finally {
      adapter.restore();
    }
  });

  it("hides configured relations without touching the rest", async () => {
    const adapter = await loadPreprocessor({
      linkPolicy: {
        canonicalizeAdvertisedRoot: true,
        hiddenRelations: ["service-desc"],
        rootAliases: [],
      },
    });
    try {
      const doc: Doc = {
        type: "Catalog",
        links: [
          { rel: "self", href: ROOT },
          { rel: "service-desc", href: `${ROOT}api` },
          { rel: "child", href: `${ROOT}collections/a` },
        ],
      };
      adapter.preprocessSTAC(doc);
      expect(doc.links.map((link) => link.rel)).toEqual(["self", "child"]);
    } finally {
      adapter.restore();
    }
  });
});

// A provider's mark. STAC has no provider logo field, and a portal deployment has no consumer CSS
// hook to key rules on each provider's URL, so the mark is a configured local file: validated,
// sanitized, published and hashed like the chrome image, then projected onto the root document's
// provider entries where the patched `Providers` view draws it. Nothing is fetched at runtime.
describe.skipIf(!STAC_MATERIALS)("a provider's mark", () => {
  it("publishes the file the deployment named and hands the built URL to the root", async () => {
    const root = writeMatrixSite({
      databrowser: false,
      stac: true,
      auth: false,
      canonicalUrl: "https://portal.example.org/site/",
      stacOptions: `      rootPage:
        providers:
          - name: Deutsches Klimarechenzentrum
            url: https://www.dkrz.de/
            roles: [host]
            logo: ./brand/dkrz.svg
          - name: An institute with no mark
            roles: [producer]
`,
    });
    write(
      root,
      "brand/dkrz.svg",
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>\n',
    );
    const out = join(tempRoot("portal-stac-logo-"), "site");
    const result = await buildFixture(root, out);
    expect(result.diagnostics.errors).toEqual([]);

    // Published under identity/, like every other configuration-named image.
    const published = readdirSync(join(out, "identity")).filter((f) => f.includes("dkrz"));
    expect(published).toHaveLength(1);

    // And NOT reported as an asset nothing references: a reference written in configuration is
    // still a reference, and FP1408 here comes with a 404 in the built site.
    expect(codes(result.diagnostics)).not.toContain("FP1408");

    // The URL reaches the root document's provider entry, and only the provider that named one.
    const shipped = readdirSync(join(out, "_portal"))
      .filter((f) => f.endsWith(".js"))
      .map((f) => readFileSync(join(out, "_portal", f), "utf8"))
      .concat(readFileSync(join(out, "catalog", "index.html"), "utf8"))
      .join("\n");
    expect(shipped).toContain(`/site/identity/${published[0]!}`);
    expect(shipped).toContain("An institute with no mark");
  }, 120_000);

  it("refuses a file that is not an embeddable image", async () => {
    const root = writeMatrixSite({
      databrowser: false,
      stac: true,
      auth: false,
      canonicalUrl: "https://portal.example.org/site/",
      stacOptions: `      rootPage:
        providers:
          - name: Institute
            logo: ./brand/notes.txt
`,
    });
    write(root, "brand/notes.txt", "not an image\n");
    const result = await resolveFixture(root);
    expect(codes(result.diagnostics)).toContain("FP1401");
  });
});

// A stylesheet that names markup the page does not have is inert: the embed goes unthemed, and
// the rules that contain Bootstrap's negative row margins stop containing anything, so the header
// bar bleeds past both window edges. A selector that matches nothing is silent in both directions
// - it does not warn when it is written, nor when the markup moves away from it - and visual
// review of the very page it fails on does not catch it. So the scopes are read out of
// `freva-stac.css` and looked for in the document.
describe.skipIf(!STAC_MATERIALS)("the STAC stylesheet is scoped to markup that exists", () => {
  /** The leading scope of every rule: what the selector attaches itself to. */
  function scopes(css: string): string[] {
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const found = new Set<string>();
    for (const match of withoutComments.matchAll(/(^|\})\s*([^{}@]+)\{/g)) {
      for (const selector of match[2]!.split(",")) {
        const first = selector
          .trim()
          .split(/[\s>+~]/)[0]
          ?.trim();
        if (!first || first.startsWith(":") || first.startsWith("--")) continue;
        found.add(first);
      }
    }
    return [...found].sort();
  }

  it("attaches every rule to something the built route emits", async () => {
    // With an introduction configured: that region is one of the scopes, and a fixture omitting it
    // would let a rule aimed at it go unchecked.
    const root = writeMatrixSite({
      databrowser: false,
      stac: true,
      auth: false,
      canonicalUrl: "https://portal.example.org/site/",
      stacOptions: "      rootPage:\n        intro: ./fragments/intro.md\n",
    });
    write(root, "fragments/intro.md", "The catalogue, introduced.\n");
    const out = join(tempRoot("portal-stac-scope-"), "site");
    const result = await buildFixture(root, out);
    expect(result.diagnostics.errors).toEqual([]);

    const page = readFileSync(join(out, "catalog", "index.html"), "utf8");
    const css = readFileSync(
      join(PACKAGE_ROOT, "astro", "src", "styles", "freva-stac.css"),
      "utf8",
    );

    // Only the scopes, not every selector: the rest of each rule names Bootstrap classes inside
    // the mounted application, which is client-rendered and legitimately absent from a static
    // document. What has to exist is the hook the rule hangs from.
    //
    // Every simple part of a compound scope, not just the first. `#stac-browser-mount.portal-stac-mount`
    // is two claims about one element, and the class is the load-bearing half: upstream declares
    // the same custom properties on the same id, so at equal specificity its later stylesheet wins
    // and the portal's theming is silently discarded.
    const emitted = (scope: string): boolean => {
      for (const part of scope.match(/[.#[][^.#[]*/g) ?? []) {
        if (part.startsWith("#") && !page.includes(`id="${part.slice(1)}"`)) return false;
        if (part.startsWith(".") && !page.includes(part.slice(1))) return false;
        if (part.startsWith("[")) {
          const [, name, value] = /^\[([^=\]]+)="?([^"\]]*)"?\]$/.exec(part) ?? [];
          if (name && !page.includes(`${name}="${value}"`)) return false;
        }
      }
      return true;
    };
    const missing = scopes(css).filter((scope) => !emitted(scope));
    expect(missing, `scoped to markup the route does not emit: ${missing.join(", ")}`).toEqual([]);
  }, 180_000);

  it("keeps the two rules that contain Bootstrap's grid, on the elements that carry it", () => {
    const css = readFileSync(
      join(PACKAGE_ROOT, "astro", "src", "styles", "freva-stac.css"),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "");
    // Bootstrap puts `margin-inline: -12px` on every `.row` and absorbs it again in the padding of
    // the `.container` those rows sit in. So containment is two rules: the region clips what still
    // escapes, and the container gets the portal's own width and gutter instead of Bootstrap's
    // breakpoint ladder, so the application occupies the same column as the prose above it.
    //
    // A blanket `max-width: 100%` on the mount's children reads like containment and is the
    // opposite: it beats `.container`'s own max-width and the application goes edge-to-edge behind
    // 12px of Bootstrap padding - measured at 1689px wide, `#stac-browser.container` spanned l=0
    // r=1689 with the toolbar starting at x=12, while the introduction above it started at x=165.
    expect(css).toMatch(/\.portal-feature-stac[^{]*\{[^}]*overflow-x:\s*hidden/);
    expect(css).toMatch(
      /\.portal-stac-mount #stac-browser\.container\s*\{[^}]*max-width:\s*none[^}]*padding-inline:\s*12px/,
    );
    expect(css).not.toMatch(/\.portal-stac-mount\s*>\s*\*\s*\{[^}]*max-width:\s*100%/);
    // The theming block keeps both halves of its scope. Written as the id alone it loses to
    // upstream's defaults on the same element - measured: `--sb-header-background` resolved to
    // upstream's teal gradient rather than the shell's surface.
    expect(css).toMatch(/#stac-browser-mount\.portal-stac-mount\s*\{[^}]*--sb-/);
  });
});
