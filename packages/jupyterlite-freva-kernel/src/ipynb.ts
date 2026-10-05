// The structural check a notebook passes before it is stored: nbformat 4.x, bounded in size, cells
// of the three known kinds with string-or-list sources. Opening a notebook never executes it; this
// only refuses files the editor would choke on or that are not notebooks.

/** Ceiling for one notebook, encoded. Large outputs belong in /workspace, not in the document. */
export const MAX_NOTEBOOK_BYTES = 32 * 1024 * 1024;
export const MAX_CELLS = 10_000;

const CELL_TYPES = new Set(["code", "markdown", "raw"]);
const CELL_ID = /^[a-zA-Z0-9-_]{1,64}$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isSource = (value: unknown): boolean =>
  typeof value === "string" ||
  (Array.isArray(value) && value.every((line) => typeof line === "string"));

/** Problems with a parsed notebook, or an empty list when it may be stored. */
export function notebookProblems(notebook: unknown, encodedBytes?: number): string[] {
  const problems: string[] = [];
  if (encodedBytes !== undefined && encodedBytes > MAX_NOTEBOOK_BYTES) {
    problems.push(
      `the notebook is ${Math.round(encodedBytes / 1024 / 1024)} MiB, over the ` +
        `${MAX_NOTEBOOK_BYTES / 1024 / 1024} MiB limit`,
    );
    return problems;
  }
  if (!isObject(notebook)) return ["not a JSON object"];
  if (notebook.nbformat !== 4) problems.push(`nbformat ${String(notebook.nbformat)} is not 4`);
  if (!Number.isInteger(notebook.nbformat_minor) || (notebook.nbformat_minor as number) < 0) {
    problems.push("nbformat_minor is missing");
  }
  if (!isObject(notebook.metadata)) problems.push("metadata is missing");
  const cells = notebook.cells;
  if (!Array.isArray(cells)) return [...problems, "cells is not a list"];
  if (cells.length > MAX_CELLS) problems.push(`${cells.length} cells is over ${MAX_CELLS}`);
  const ids = new Set<string>();
  cells.slice(0, MAX_CELLS).forEach((cell, index) => {
    const where = `cell ${index + 1}`;
    if (!isObject(cell)) {
      problems.push(`${where} is not an object`);
      return;
    }
    if (!CELL_TYPES.has(cell.cell_type as string)) {
      problems.push(`${where} has unknown type ${JSON.stringify(cell.cell_type)}`);
    }
    if (!isSource(cell.source)) problems.push(`${where} has no text source`);
    if (cell.id !== undefined) {
      if (typeof cell.id !== "string" || !CELL_ID.test(cell.id)) {
        problems.push(`${where} has an invalid id`);
      } else if (ids.has(cell.id)) problems.push(`${where} repeats the id ${cell.id}`);
      else ids.add(cell.id);
    }
    if (cell.cell_type === "code" && cell.outputs !== undefined && !Array.isArray(cell.outputs)) {
      problems.push(`${where} has outputs that are not a list`);
    }
  });
  return problems.slice(0, 20);
}

/** Parse and check notebook text; throws an Error listing what is wrong. */
export function parseNotebook(text: string): Record<string, unknown> {
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > MAX_NOTEBOOK_BYTES) {
    throw new Error(notebookProblems(null, bytes).join("; "));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const problems = notebookProblems(parsed);
  if (problems.length > 0) throw new Error(problems.join("; "));
  return parsed as Record<string, unknown>;
}
