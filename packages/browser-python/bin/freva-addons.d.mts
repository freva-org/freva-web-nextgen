/** Types for the shipped add-on command. See the .mjs for what each rule is for. */
export declare const ADDON_MANIFEST: string;
export interface AddonArtifactPlan {
  id: string;
  path: string;
  sha256: string;
  bytes: number;
  url: string;
  kind: "wheel" | "data";
}
export declare const ADDON_PINS: {
  schemaVersion: number;
  addons: Record<
    string,
    {
      title: string;
      profiles: string[];
      runtimePackages: string[];
      wheels: {
        name: string;
        version: string;
        file: string;
        sha256: string;
        bytes: number;
        url: string;
      }[];
      data: { path: string; sha256: string; bytes: number; url: string }[];
      reports: string[];
      dataset?: Record<string, string>;
      note?: string;
    }
  >;
};
export declare function plannedArtifacts(id: string): AddonArtifactPlan[];
export declare function plannedAddons(ids?: readonly string[]): AddonArtifactPlan[];
export declare function verifyAddons(dir: string, ids?: readonly string[]): string[];
export declare function addonFootprint(ids?: readonly string[]): number;
export declare function prepareAddons(
  args: Record<string, unknown>,
  hooks: { fail: (message: string) => void; log?: (message: string) => void },
): Promise<void>;
