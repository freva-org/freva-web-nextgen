// A live dataset tree's search index: the published, content-hashed file, fetched from this
// portal's own origin (`connect-src 'self'`) and validated again before the tree sees it - what
// arrives is whatever the host served under that name. The validator is a dynamic import, and the
// generated entry names this module only when some block has an index, so a portal without one
// contains neither.

import type { SearchIndexLoader } from "./tree-sources.js";

export const loadSearchIndex: SearchIndexLoader = async (url) => {
  const response = await fetch(url, { credentials: "same-origin" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const json: unknown = await response.json();
  const { parseDatasetTreeSearchIndexV1 } = await import("./tree-search-index-parse.js");
  return parseDatasetTreeSearchIndexV1(json);
};
