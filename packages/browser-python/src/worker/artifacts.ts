/**
 * artifacts.ts - noticing that Python wrote a file.
 *
 * There is no hook in Python for this, and deliberately so: wrapping `open`, patching `io`, or
 * asking libraries to announce their outputs all leave a file written by some unanticipated
 * path - `xarray.to_netcdf`, a C extension's own `fopen` - invisible. So the workspace is
 * compared with what it held before, at the one moment it is guaranteed quiescent: after an
 * execution has finished and before its reply is sent. Diffing rather than broadcasting,
 * because the "added / updated / removed" split is what lets a UI say "wrote surface_wind.nc".
 *
 * THE LIMIT OF "after an execution", stated rather than hidden. Python can touch a file after
 * the statement that scheduled it returned - a `__del__` on a later collection, a callback, an
 * `atexit` hook - and with no filesystem notification to hang it on, this diff will not notice
 * until the NEXT execution or an explicit `artifacts()` call. Bounded and not silent: the
 * artifact is on disk and correct, the panel is one command behind. Code that must see it
 * immediately should close its files inside the statement that wrote them, as `with` does.
 */

import type { Post } from "./output.js";
import type { Workspace } from "./opfs-workspace.js";
import type { ArtifactInfo } from "../types.js";

/**
 * What decides whether an artifact CHANGED, as opposed to merely still existing.
 *
 * A monotonic generation, not size-and-timestamp: those agree on a rewrite landing on the same
 * length inside one millisecond - a fixed-width record replaced by `os.replace`, a header
 * patched in place - so a UI would show the old size and a download already under way would
 * read new bytes as the old ones. The counter is bumped by the filesystem on every write,
 * truncate, rename and creation, and is never reused. `state` is here too because it changes
 * with no mutation at all: closing the last descriptor turns `open` into `ready`.
 */
interface Fingerprint {
  generation: number;
  state: ArtifactInfo["state"];
}

export class ArtifactWatcher {
  #workspace: Workspace;
  #post: Post;
  #previous = new Map<string, Fingerprint>();

  constructor(workspace: Workspace, post: Post) {
    this.#workspace = workspace;
    this.#post = post;
  }

  /**
   * Compare, and announce the difference. `requestId` makes this the reply to an
   * `artifact-list` or `artifact-delete`, in which case it is sent even when nothing changed -
   * a request must always be answered. Without one it is a spontaneous update and stays silent
   * on an unchanged workspace, so arithmetic at the prompt emits no empty message a line.
   */
  settle(executionId?: string, requestId?: string): void {
    // THROWS on failure rather than returning quietly. When `settle` is answering an
    // `artifact-list` or `artifact-delete`, returning without posting leaves the engine's
    // pending entry in the table forever and `await engine.artifacts()` never settles. The
    // caller decides, and for a request turns this into a `request-error` to reject with.
    const artifacts = this.#workspace.list();

    const added: string[] = [];
    const updated: string[] = [];
    const next = new Map<string, Fingerprint>();

    for (const artifact of artifacts) {
      const fingerprint: Fingerprint = {
        generation: artifact.generation,
        state: artifact.state,
      };
      next.set(artifact.name, fingerprint);
      const before = this.#previous.get(artifact.name);
      if (!before) {
        added.push(artifact.name);
      } else if (
        before.generation !== fingerprint.generation ||
        before.state !== fingerprint.state
      ) {
        updated.push(artifact.name);
      }
    }

    const removed = [...this.#previous.keys()].filter((name) => !next.has(name));
    this.#previous = next;

    const quiet = added.length === 0 && updated.length === 0 && removed.length === 0;
    if (quiet && requestId === undefined) return;

    this.#post({
      kind: "artifacts",
      ...(requestId !== undefined ? { id: requestId } : {}),
      ...(executionId !== undefined ? { executionId } : {}),
      artifacts,
      added,
      updated,
      removed,
    });
  }
}
