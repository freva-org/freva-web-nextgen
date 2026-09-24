// The programmatic surface, for the repository's own tests and tooling. The public contract is
// the CLI, the schemas and the artifact; these exports are convenience for framework
// development, and `ResolvedPortalModel` in particular is internal, not a stable v1 API.

export { run } from "./cli/index.js";
export { buildSite, type BuildOptions, type BuildResult } from "./artifact/index.js";
export { resolveModel, type ResolveOptions, type ResolveResult } from "./model/resolve.js";
export { verifyArtifact } from "./verify/verify.js";
export { buildCanonicalArchive, recordedEpoch, type ArchiveResult } from "./artifact/archive.js";
export { hostCheck } from "./verify/host-check.js";
export { createPreviewServer } from "./verify/preview.js";
export { migrateManifest, migrateFile } from "./cli/migrate.js";
export { loadProfile, effectiveLimits } from "./rendering/profile.js";
export { COMPONENT_REGISTRY, registrationFor } from "./components/registry.js";
export { THEME_PRESETS, themeNames, resolveThemeCss } from "./themes/registry.js";
export { DiagnosticBag, formatHuman, toJson, type Diagnostic } from "./diagnostics.js";
export type { ResolvedPortalModel } from "./model/types.js";
