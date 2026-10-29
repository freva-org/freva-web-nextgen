/** Types for the npm audit gate. */
export declare const ALLOWLIST: string;

export interface Advisory {
  id: string;
  severity: string;
  title: string;
  packages: string[];
}

export interface AllowlistEntry {
  advisory?: string;
  reason?: string;
  expires?: string;
}

export declare function advisories(report: unknown): Advisory[];

export declare function evaluate(
  report: unknown,
  allowlist: AllowlistEntry[],
  today: string,
): { blocking: Advisory[]; accepted: Advisory[]; problems: string[] };
