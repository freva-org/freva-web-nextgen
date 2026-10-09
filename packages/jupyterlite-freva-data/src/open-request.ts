import type { DatasetTreeNode, DatasetTreeSource } from "@freva-org/dataset-tree";

export const OPEN_DATASET_MESSAGE = "freva-data:open-dataset";
export const DATA_PANEL_READY_MESSAGE = "freva-data-ready";
export const SHOW_PANEL_MESSAGE = "freva-data:show-panel";
export const PANEL_PARAM = "panel";
export const DATASET_PARAM = "dataset";
const MAX_ID_LENGTH = 2048;
const MAX_REQUESTS = 64;
const MAX_NODES = 20_000;

const validId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH;

export function datasetRequest(href: string): string | null {
  try {
    const value = new URL(href).searchParams.get(DATASET_PARAM);
    return validId(value) ? value : null;
  } catch {
    return null;
  }
}

export function panelRequest(href: string): boolean {
  try {
    return new URL(href).searchParams.get(PANEL_PARAM) === "data";
  } catch {
    return false;
  }
}

export function withoutDatasetRequest(href: string): string {
  const url = new URL(href);
  url.searchParams.delete(DATASET_PARAM);
  url.searchParams.set(PANEL_PARAM, "data");
  return url.href;
}

export function panelFromMessage(data: unknown): boolean {
  return (data as { type?: unknown } | null)?.type === SHOW_PANEL_MESSAGE;
}

export function datasetFromMessage(data: unknown): string | null {
  const message = data as { type?: unknown; dataset?: unknown } | null;
  if (!message || message.type !== OPEN_DATASET_MESSAGE) return null;
  return validId(message.dataset) ? message.dataset : null;
}

const expandable = (node: DatasetTreeNode) =>
  node.kind === "collection" || node.kind === "directory";

const leadsTo = (node: DatasetTreeNode, id: string): number => {
  const prefixes = [node.id, node.path].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return Math.max(0, ...prefixes.filter((prefix) => id.startsWith(prefix)).map((p) => p.length));
};

export async function findPath(
  source: DatasetTreeSource,
  id: string,
): Promise<DatasetTreeNode[] | null> {
  const context = { signal: new AbortController().signal };
  const roots = await source.loadRoots(context);
  if (source.complete) {
    const queue: DatasetTreeNode[][] = roots.map((node) => [node]);
    for (let seen = 0; queue.length > 0 && seen < MAX_NODES; seen += 1) {
      const path = queue.shift()!;
      const node = path[path.length - 1]!;
      if (node.id === id) return path;
      if (expandable(node)) {
        for (const child of await source.loadChildren(node, context)) queue.push([...path, child]);
      }
    }
    return null;
  }
  let requests = 0;
  const search = async (
    level: readonly DatasetTreeNode[],
    path: DatasetTreeNode[],
  ): Promise<DatasetTreeNode[] | null> => {
    const hit = level.find((node) => node.id === id);
    if (hit) return [...path, hit];
    const branches = level
      .filter((node) => expandable(node) && leadsTo(node, id) > 0)
      .sort((a, b) => leadsTo(b, id) - leadsTo(a, id));
    for (const branch of branches) {
      if (requests >= MAX_REQUESTS) return null;
      requests += 1;
      const found = await search(await source.loadChildren(branch, context), [...path, branch]);
      if (found) return found;
    }
    return null;
  };
  return search(roots, []);
}
