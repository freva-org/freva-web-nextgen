/**
 * Types for `transcript.mjs`, so the unit test that guards it can be type-checked.
 *
 * The implementation is plain JavaScript because it is loaded by the browser suites, which run from
 * source with no build step. This declaration is the one place the two worlds meet.
 */

export declare const OUT: string;
export declare const DONE: string;

/** The program as submitted: the caller's source between two markers it prints itself. */
export declare function wrap(source: string): string;

/** What a transcript slice actually contains. `output` is null until the program has printed. */
export declare function readTranscript(
  text: string,
  options?: { idle?: boolean },
): { output: string | null; ended: boolean; started: boolean };
