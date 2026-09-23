/**
 * A check-only stand-in for `virtual:portal-model`: typed as the real
 * `ResolvedPortalModel`, empty at runtime. Only `astro check` imports it.
 */
import type { ResolvedPortalModel } from "../../../src/model/types.js";

const model = {} as ResolvedPortalModel;
export default model;
