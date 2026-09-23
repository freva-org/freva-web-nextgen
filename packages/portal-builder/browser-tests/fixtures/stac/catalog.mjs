// A STAC API fixture, served beside the artifact in the browser suite.
//
// The example portal points its `stac` service at `/api/freva-nextgen/stac/`. With nothing
// answering there the application renders its own error state while
// `data-portal-stac-state="ready"` is satisfied by the mount merely acquiring children - a
// meaningless readiness signal. The questions worth asking are all about what happens once a
// catalogue LOADS: whether the root introduction appears only at the root, whether root metadata
// overrides stay off collections and items, whether a relative link resolves against the document
// that supplied it, whether the mounted application is accessible. So this is the smallest
// catalogue that can answer them:
//
//   - a root Catalog with two child Collections, a description of its own (so the duplicate-copy
//     rule has something to suppress), keywords, a licence and a provider (so an override has
//     something to override, and something to be wrong about if it leaks);
//   - one collection whose links are ABSOLUTE, one DOCUMENT-RELATIVE, so link resolution is
//     exercised in both forms from the same catalogue;
//   - an item under each, one of them reached by a root-relative link;
//   - a `self` link on every document, which is what identifies the root without guessing.
//
// It is static JSON assembled here rather than a recording of a real service, which would carry a
// real deployment's endpoints and metadata into this repository.

/**
 * Everything the fixture serves, as a path → document map, given the base it is mounted at.
 *
 * `search` is the query the request carried, and the root document's own `self` carries it back.
 * The portal deploys the catalogue as `/api/freva-nextgen/stac/?visible_collections=...`, and a
 * filtered view is a different catalogue from the unfiltered one: answering a filtered request
 * with an unfiltered `self` tells the client it is somewhere it is not, leaving the root
 * unidentifiable.
 */
export function stacFixture(origin, mount = "/api/freva-nextgen/stac/", search = "") {
  const at = (path) => `${origin}${mount}${path}`.replace(/([^:])\/{2,}/g, "$1/");
  const root = `${origin}${mount}${search}`.replace(/([^:])\/{2,}/g, "$1/");
  // The same catalogue, spelled without its trailing slash. A real service mixes both forms, and
  // an advertised link that differs from the configured URL only in that way is still the root.
  const rootUnslashed = `${origin}${mount.replace(/\/+$/, "")}${search}`.replace(
    /([^:])\/{2,}/g,
    "$1/",
  );

  const rootCatalog = {
    type: "Catalog",
    stac_version: "1.0.0",
    id: "fixture-root",
    title: "Fixture Catalogue",
    description: "The catalogue's own description, served by the API.",
    keywords: ["api-keyword"],
    license: "proprietary",
    providers: [{ name: "API Provider", roles: ["host"], url: "https://api.example.test/" }],
    links: [
      { rel: "self", href: root, type: "application/json" },
      { rel: "root", href: root, type: "application/json" },
      // An absolute child, and a document-relative one. Both must resolve to this document's base.
      {
        rel: "child",
        href: at("collections/absolute"),
        type: "application/json",
        title: "Absolute Collection",
      },
      {
        rel: "child",
        href: "collections/relative",
        type: "application/json",
        title: "Relative Collection",
      },
      {
        rel: "service-desc",
        href: at("api"),
        type: "application/vnd.oai.openapi+json;version=3.0",
      },
      { rel: "conformance", href: at("conformance"), type: "application/json" },
    ],
  };

  const collection = (id, title, absolute) => ({
    type: "Collection",
    stac_version: "1.0.0",
    id,
    title,
    description: `Description of ${title}, which must never be replaced by a root override.`,
    // Deliberately not the licence the example portal states for its root. A collection that
    // happened to agree with the root override would make a leak invisible.
    license: "CC0-1.0",
    keywords: [`${id}-keyword`],
    providers: [{ name: `${title} Provider`, roles: ["producer"] }],
    extent: {
      spatial: { bbox: [[-180, -90, 180, 90]] },
      temporal: { interval: [["2020-01-01T00:00:00Z", null]] },
    },
    links: [
      { rel: "self", href: at(`collections/${id}`), type: "application/json" },
      { rel: "root", href: root, type: "application/json" },
      { rel: "parent", href: root, type: "application/json" },
      absolute
        ? {
            rel: "item",
            href: at(`collections/${id}/items/first`),
            type: "application/geo+json",
            title: "First Item",
          }
        : {
            rel: "item",
            href: `${mount}collections/${id}/items/first`,
            type: "application/geo+json",
            title: "First Item",
          },
    ],
  });

  const item = (collectionId) => ({
    type: "Feature",
    stac_version: "1.0.0",
    id: "first",
    collection: collectionId,
    geometry: { type: "Point", coordinates: [0, 0] },
    bbox: [0, 0, 0, 0],
    properties: {
      title: "First Item",
      description: "The item's own description, which a root override must never reach.",
      datetime: "2024-01-01T00:00:00Z",
    },
    assets: {
      data: {
        href: at(`collections/${collectionId}/items/first/data.tif`),
        type: "image/tiff",
        roles: ["data"],
      },
    },
    links: [
      {
        rel: "self",
        href: at(`collections/${collectionId}/items/first`),
        type: "application/geo+json",
      },
      { rel: "root", href: rootUnslashed, type: "application/json" },
      { rel: "parent", href: at(`collections/${collectionId}`), type: "application/json" },
      { rel: "collection", href: at(`collections/${collectionId}`), type: "application/json" },
    ],
  });

  return {
    "": rootCatalog,
    "collections/absolute": collection("absolute", "Absolute Collection", true),
    "collections/relative": collection("relative", "Relative Collection", false),
    "collections/absolute/items/first": item("absolute"),
    "collections/relative/items/first": item("relative"),
    conformance: {
      conformsTo: [
        "https://api.stacspec.org/v1.0.0/core",
        "https://api.stacspec.org/v1.0.0/collections",
      ],
    },
  };
}

/**
 * Answer STAC requests, and say so. Returns true when it handled the request. `served` collects
 * every path the application asked for, so a test can assert what a navigation actually fetched
 * rather than inferring it from the DOM.
 */
export function serveStac(request, response, origin, served, mount = "/api/freva-nextgen/stac/") {
  const url = new URL(request.url, origin);
  if (!url.pathname.startsWith(mount)) return false;
  const key = url.pathname.slice(mount.length).replace(/\/+$/, "");
  const documents = stacFixture(origin, mount, url.search);
  served.push(url.pathname + url.search);
  const document_ = documents[key];
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("cache-control", "no-store");
  if (!document_) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: "NotFound", description: `no document at ${key}` }));
    return true;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(document_));
  return true;
}
