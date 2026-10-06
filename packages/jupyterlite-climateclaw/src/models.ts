// The model list. jupyterlite-ai 0.20.1's model picker lists configured provider entries (one
// model each) and has no provider-side `fetchModels` yet, so after sign-in the models from
// `GET /availablechatbots` become one ClimateClaw entry each. The entry `climateclaw` (the
// operator's default, from the settings overrides) is kept, with its model replaced when the server
// does not serve it; other providers are untouched.

import { PROVIDER_ID } from "./config.js";

export interface ProviderEntry {
  id: string;
  name: string;
  provider: string;
  model: string;
  [key: string]: unknown;
}

export function entryId(model: string, defaultModel: string): string {
  return model === defaultModel ? PROVIDER_ID : `${PROVIDER_ID}:${model}`;
}

/** `wanted` when the server serves it (or the list is unknown), else `fallback`. */
export function servedModel(wanted: string, served: readonly string[], fallback: string): string {
  return !wanted || served.length === 0 || served.includes(wanted) ? wanted || fallback : fallback;
}

/** The provider list with one ClimateClaw entry per model, or null when nothing changes. */
export function reconcileModels(
  current: readonly ProviderEntry[],
  models: readonly string[],
  defaultModel: string,
  defaultName: string,
): ProviderEntry[] | null {
  const others = current.filter((p) => p.provider !== PROVIDER_ID);
  const existingDefault = current.find((p) => p.id === PROVIDER_ID);
  const wanted: ProviderEntry[] = [];
  // The configured default only if the server serves it (or the list is unknown), for a new
  // entry as much as for an existing one.
  const fallback = servedModel(defaultModel, models, models[0] ?? "");
  if (existingDefault && models.length > 0 && !models.includes(existingDefault.model)) {
    // The configured model is not one this server serves: use one it does.
    wanted.push({ ...existingDefault, model: servedModel(defaultModel, models, models[0]!) });
  } else if (existingDefault) wanted.push(existingDefault);
  else if (fallback) {
    wanted.push({ id: PROVIDER_ID, name: defaultName, provider: PROVIDER_ID, model: fallback });
  }
  const defaultEntryModel = wanted[0]?.model ?? fallback;
  for (const model of models) {
    if (model === defaultEntryModel) continue;
    const id = `${PROVIDER_ID}:${model}`;
    const previous = current.find((p) => p.id === id);
    wanted.push(previous ?? { id, name: `ClimateClaw · ${model}`, provider: PROVIDER_ID, model });
  }
  const next = [...others, ...wanted];
  const same =
    next.length === current.length &&
    next.every((p, i) => {
      const q = current[i];
      return q !== undefined && q.id === p.id && q.model === p.model && q.provider === p.provider;
    });
  return same ? null : next;
}

/** What the model list sync reads and writes; jupyterlite-ai's settings model in production. */
export interface ModelSyncTarget {
  providers(): ProviderEntry[];
  hasDefaultProvider(): boolean;
  update(providers: ProviderEntry[]): Promise<unknown>;
  activate(id: string): Promise<unknown>;
}

/**
 * Keeps the model picker in step with the models the server serves: once now - a sign-in can be
 * restored before this runs, and then no change would ever announce it - and after every sign-in
 * change. Each run belongs to the sign-in state it started in: a run overtaken by a newer one (a
 * sign-out, another sign-in) changes nothing - not the providers, not the active provider, not the
 * published model list. Returns the disconnect.
 */
export function startModelSync(options: {
  auth: {
    readonly signedIn: boolean;
    changed: { connect(fn: () => void): unknown; disconnect(fn: () => void): unknown };
  };
  fetchModels: () => Promise<string[]>;
  defaultModel: string;
  name: string;
  settings: ModelSyncTarget;
  /** The models the server serves, as now known (empty when signed out). */
  publish?: (models: string[]) => void;
}): () => void {
  const { auth, settings } = options;
  let generation = 0;
  const sync = async () => {
    const mine = (generation += 1);
    const current = () => mine === generation;
    if (!auth.signedIn) {
      options.publish?.([]);
      return;
    }
    const models = await options.fetchModels();
    if (!current() || !auth.signedIn) return;
    options.publish?.(models);
    const next = reconcileModels(settings.providers(), models, options.defaultModel, options.name);
    if (next) await settings.update(next);
    if (!current()) return;
    if (!settings.hasDefaultProvider() && next?.some((p) => p.id === PROVIDER_ID)) {
      await settings.activate(PROVIDER_ID);
    }
  };
  const run = () => void sync().catch((error) => console.warn("ClimateClaw:", error));
  auth.changed.connect(run);
  run();
  return () => void auth.changed.disconnect(run);
}
