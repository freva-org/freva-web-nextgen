import type { Diagnostic } from "../diagnostics.js";
import type { IrCode, IrNode } from "./ir.js";
import { resolveLanguage } from "./languages.js";
import { lineOf } from "./location.js";

// What marks a code block as runnable, and what a marked block becomes.
//
// ONE word, on the fence, beside the language - not a language of its own. `py-runnable` would
// be easier to parse and wrong in every other way: a highlighter would not know it, a reader
// would not recognise it, and a document that stopped being runnable would need its language
// rewritten. Execution is metadata about a Python block; the block is still Python. The
// identity a marked block gets is deterministic, collision-safe and deliberately NOT a hash of
// the source: an id that changed with an edit would make the parent and the separate-origin
// child disagree after a typo fix in one, and the digest beside it makes a mismatch loud.

/** The fence word, and the RST option name. One spelling, two lanes. */
export const RUNNABLE_MARKER = "try-in-python";

/**
 * A source path, escaped so two different paths can never compose into one id. The same rule
 * the dataset tree uses for its own ids: percent-escape the separator and the escape
 * character, so `a/b` and `a%2Fb` stay distinguishable and a forged delimiter buys nothing.
 */
export function segment(value: string): string {
  return value.replace(/%/g, "%25").replace(/#/g, "%23");
}

/**
 * The id of the n-th code block of a document, counted over EVERY code block in the file and
 * not only the runnable ones, so the number means something a reader can find: "the third code
 * block in guide.md". Counting only marked blocks would renumber every later id when a marker
 * is added earlier, silently changing identity on a deployment that already shipped a manifest.
 */
export function runnableId(file: string, occurrence: number): string {
  return `content:${segment(file)}#${occurrence}`;
}

/**
 * A title for the terminal's divider: the author's, or one derived from where the block is.
 * Derived rather than invented, and deterministic, because it ends up in a manifest that two
 * deployments compare.
 */
export function runnableTitle(file: string, occurrence: number, title: string | undefined): string {
  const named = title?.trim();
  if (named) return named;
  const base = file.split("/").pop() ?? file;
  return `${base} · block ${occurrence}`;
}

/**
 * The two refusals both lanes share: a marker on the wrong language, and a marker on nothing.
 * Here rather than in each parser, because the rule is about the BLOCK and not how it was
 * spelled: markdown writes ```` ```python try-in-python ```` and RST writes `:try-in-python:`,
 * and a rule implemented twice would eventually mean two different things. Both are build-time
 * and source-located, because the alternative is a control that ships and does nothing, or
 * runs an empty string in an interpreter the visitor waited half a minute for.
 */
export function validateRunnable(
  nodes: IrNode[],
  file: string,
  languages: readonly string[],
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const walk = (list: readonly IrNode[]): void => {
    for (const node of list) {
      if (node.type === "code" && (node as IrCode).runnable === true) {
        const code = node as IrCode;
        const line = lineOf(code.loc);
        const resolved = resolveLanguage(code.lang, languages);
        const at = { file, ...(line !== undefined ? { position: { line } } : {}) };
        if (resolved.label !== "python") {
          diagnostics.push({
            code: "PC1022",
            severity: "error",
            message:
              `'${RUNNABLE_MARKER}' is only meaningful on a Python code block, not on ` +
              `'${code.lang ?? "an unlabelled block"}'.`,
            hint: "Python is written as python, py or python3.",
            ...at,
          });
          delete code.runnable;
        } else if (code.value.trim() === "") {
          diagnostics.push({
            code: "PC1022",
            severity: "error",
            message: "An empty code block cannot be run.",
            ...at,
          });
          delete code.runnable;
        }
      }
      const children = (node as { children?: IrNode[] }).children;
      if (Array.isArray(children)) walk(children);
    }
  };
  walk(nodes);
  return diagnostics;
}
