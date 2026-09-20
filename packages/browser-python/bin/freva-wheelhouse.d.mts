/** Types for the shipped wheelhouse command. See the .mjs for what each rule is for. */
export interface PlannedWheel {
  file: string;
  sha256: string;
  name: string;
  version: string;
  derivedFrom?: string;
}
export declare const WHEELHOUSE_MANIFEST: string;
export declare function rewriteMetadata(
  text: string,
  version: string,
  browserVersion: string,
  /** `==` for a requirement upstream already declares. */
  pins?: Record<string, string>,
  /** Requirements upstream does NOT declare, added to pin a transitive dependency. */
  transitivePins?: Record<string, string>,
): string;
export declare function buildBrowserWheel(
  sourceBytes: Buffer,
  options: {
    version: string;
    localVersion: string;
    runtimePins?: Record<string, string>;
    transitivePins?: Record<string, string>;
  },
): { file: string; bytes: Buffer };
export declare function verifyWheelhouse(dir: string, plan?: PlannedWheel[]): string[];
export declare function plannedWheels(): string[];
export declare function plannedWheelhouse(): PlannedWheel[];
export declare function prepareFrevaWheelhouse(
  args: Record<string, unknown>,
  hooks: { fail: (message: string) => void; log?: (message: string) => void },
): Promise<void>;
