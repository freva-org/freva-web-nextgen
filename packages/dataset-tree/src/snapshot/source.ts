// snapshot/source.ts - serve a parsed catalog to the view. The whole adapter is an index lookup: it
// opens no socket, reads no global and touches no timer, so a portal that ships its catalog as a
// build artifact renders the tree with the same certainty as its own navigation, and is provably
// incapable of calling out to a service at page load.

import type { DatasetTreeLoadContext, DatasetTreeNode, DatasetTreeSource } from "../types.js";
import type { DatasetTreeCatalog, DatasetTreeCatalogNode } from "./parse.js";

/** The rejection used when a caller aborts. Shaped like the platform's own abort error. */
function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function index(
  nodes: readonly DatasetTreeCatalogNode[],
  into: Map<string, DatasetTreeCatalogNode>,
): Map<string, DatasetTreeCatalogNode> {
  for (const node of nodes) {
    into.set(node.id, node);
    if (node.children) index(node.children, into);
  }
  return into;
}

/**
 * A {@link DatasetTreeSource} over an in-memory catalog. Children are resolved by id rather than by
 * walking from the node object, so a consumer that hands the view a node it constructed itself - a
 * search result, a deep link - still gets the right subtree back. The returned promises settle on a
 * microtask and still honour `signal`: an abort that lands first rejects, so the view's
 * stale-response guard runs the same code path in snapshot mode as in live mode.
 */
export function createSnapshotSource(catalog: DatasetTreeCatalog): DatasetTreeSource {
  if (!catalog || !Array.isArray(catalog.roots)) {
    throw new TypeError(
      "createSnapshotSource: expected a catalog from parseDatasetTreeCatalogV1()",
    );
  }
  const byId = index(catalog.roots, new Map());

  const settle = (
    context: DatasetTreeLoadContext,
    value: readonly DatasetTreeNode[],
  ): Promise<readonly DatasetTreeNode[]> =>
    context?.signal?.aborted ? Promise.reject(abortError()) : Promise.resolve(value);

  return {
    // The whole archive is already here, in memory, indexed. Saying so is what lets the view offer
    // `Expand all`, filter the entire catalogue rather than the part somebody opened, and keep the
    // "only loaded items are searched" caveat - which would be false - off the page.
    complete: true,
    loadRoots(context) {
      return settle(context, catalog.roots);
    },
    loadChildren(node, context) {
      const found = node ? byId.get(node.id) : undefined;
      return settle(context, found?.children ?? []);
    },
  };
}
