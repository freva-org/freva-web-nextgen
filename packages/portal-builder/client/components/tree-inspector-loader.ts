/**
 * The one module that names `./tree-inspector.js`, so the bundler sees the edge and nothing else
 * has to. Same shape as the Python chunk loaders and the S3 source loader, for the same reason: a
 * module that MENTIONS a specifier puts it in the graph, and the island must open an inspector
 * without the inspector's package becoming a static dependency of every page with a dataset tree.
 */

import type { InspectTarget } from "./tree-inspector.js";

export type InspectorLoader = (target: InspectTarget) => Promise<void>;

export const loadInspector: InspectorLoader = async (target) => {
  const module = await import("./tree-inspector.js");
  return module.openInspector(target);
};
