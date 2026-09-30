/**
 * The package's index validator, re-exported so its lazy chunk is named after THIS module. Imported
 * directly, the chunk takes the package entry's name - `search-index.<hash>.js` - which is the
 * site search's claimed prefix, and a portal with a tree index and no site search would then fail
 * its own absence check for a feature it does not have.
 */
export { parseDatasetTreeSearchIndexV1 } from "@freva-org/dataset-tree/search-index";
