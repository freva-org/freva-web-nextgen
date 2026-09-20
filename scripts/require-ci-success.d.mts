/** Types for the publication gate. See the .mjs for what each rule is for. */
export declare const REQUIRED_WORKFLOW: string;

/** A CI run as the GitHub API reports it, in the parts this gate consults. */
export interface CiRun {
  id?: number | string;
  name?: string;
  head_sha?: string;
  event?: string;
  status?: string;
  conclusion?: string | null;
}

export declare function decide(input: {
  eventName: string;
  headSha: string;
  workflowRun?: CiRun | null;
  runs?: CiRun[];
}): { ok: boolean; reason: string };

export declare function fetchRuns(input: {
  repository: string;
  headSha: string;
  token?: string | undefined;
  fetchImpl?: typeof fetch;
}): Promise<CiRun[]>;
