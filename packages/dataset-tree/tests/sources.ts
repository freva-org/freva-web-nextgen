// tests/sources.ts - test doubles for `DatasetTreeSource`.
//
// Two of them. `recordingSource` wraps a real snapshot source and counts calls, which is how the
// lazy-loading and caching claims are checked. `manualSource` hands the test the resolvers, which
// is the only honest way to test a race: a fake that resolves on its own schedule can only test
// the timing it happens to have.

import type { DatasetTreeNode, DatasetTreeSource } from "../src/types.js";
import { deferred } from "./helpers.js";

export interface RecordingSource extends DatasetTreeSource {
  /** Ids passed to `loadChildren`, in order; `"<roots>"` for a `loadRoots` call. */
  readonly calls: string[];
}

export function recordingSource(inner: DatasetTreeSource): RecordingSource {
  const calls: string[] = [];
  return {
    calls,
    // Forwarded, not dropped: a wrapper that silently downgrades a complete source to a lazy one
    // would have every filter and expand-all test measuring the wrong presentation.
    complete: inner.complete,
    loadRoots(context) {
      calls.push("<roots>");
      return inner.loadRoots(context);
    },
    loadChildren(node, context) {
      calls.push(node.id);
      return inner.loadChildren(node, context);
    },
  };
}

export interface ManualSource extends DatasetTreeSource {
  /** Settle the pending `loadRoots`. */
  resolveRoots(nodes: readonly DatasetTreeNode[]): void;
  rejectRoots(reason: unknown): void;
  /** Settle the pending `loadChildren` for one node. */
  resolveChildren(id: string, nodes: readonly DatasetTreeNode[]): void;
  rejectChildren(id: string, reason: unknown): void;
  /** Whether a call for this id is still outstanding. */
  pending(id: string): boolean;
  /** The `AbortSignal` handed to a still-outstanding call. */
  signalFor(id: string): AbortSignal | undefined;
  readonly calls: string[];
}

export function manualSource(): ManualSource {
  const calls: string[] = [];
  const gates = new Map<
    string,
    {
      resolve: (v: readonly DatasetTreeNode[]) => void;
      reject: (r: unknown) => void;
      signal: AbortSignal;
    }
  >();

  // Outcomes queued before the call arrives.
  //
  // The component reaches its source on a microtask, so a test that mounts and then immediately
  // says "the roots are these" is speaking before anyone is listening. Buffering here keeps the
  // tests readable - `mount(); resolveRoots(...)` - instead of littering them with awaits whose
  // only job is to line up with an implementation detail.
  const queued = new Map<string, { ok: boolean; value: unknown }>();

  const open = (key: string, signal: AbortSignal): Promise<readonly DatasetTreeNode[]> => {
    calls.push(key);
    const early = queued.get(key);
    if (early) {
      queued.delete(key);
      return early.ok
        ? Promise.resolve(early.value as readonly DatasetTreeNode[])
        : Promise.reject(early.value);
    }
    const gate = deferred<readonly DatasetTreeNode[]>();
    gates.set(key, { resolve: gate.resolve, reject: gate.reject, signal });
    return gate.promise;
  };

  const settle = (key: string, ok: boolean, value: unknown): void => {
    const gate = gates.get(key);
    if (!gate) {
      queued.set(key, { ok, value });
      return;
    }
    gates.delete(key);
    if (ok) gate.resolve(value as readonly DatasetTreeNode[]);
    else gate.reject(value);
  };

  return {
    calls,
    loadRoots(context) {
      return open("<roots>", context.signal);
    },
    loadChildren(node, context) {
      return open(node.id, context.signal);
    },
    resolveRoots(nodes) {
      settle("<roots>", true, nodes);
    },
    rejectRoots(reason) {
      settle("<roots>", false, reason);
    },
    resolveChildren(id, nodes) {
      settle(id, true, nodes);
    },
    rejectChildren(id, reason) {
      settle(id, false, reason);
    },
    pending(id) {
      return gates.has(id);
    },
    signalFor(id) {
      return gates.get(id)?.signal;
    },
  };
}

/** A handful of plain nodes, for tests that do not need a whole catalog. */
export function nodes(...names: string[]): DatasetTreeNode[] {
  return names.map((name) => ({
    id: `n:${name}`,
    kind: "directory" as const,
    name,
    hasChildren: true,
  }));
}

/**
 * The same source with its completeness claim removed.
 *
 * A lazy presentation is still a supported one - a live object store cannot promise completeness -
 * and the behaviour that belongs to it (the caveat, `Reload`, a filter that only sees what has been
 * opened) has to keep being tested by something. This is that something.
 */
export function lazySource(inner: DatasetTreeSource): RecordingSource {
  const wrapped = recordingSource(inner);
  return {
    calls: wrapped.calls,
    loadRoots: (context) => wrapped.loadRoots(context),
    loadChildren: (node, context) => wrapped.loadChildren(node, context),
  };
}
