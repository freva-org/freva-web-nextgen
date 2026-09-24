// The language registry.
//
// One table, in one place, rather than language checks scattered through the templates. It
// answers two questions: which name did the author write, and which grammar does the
// highlighter know it by. Aliases are the point: documentation says `py`, `sh`, `js`, `yml`
// and `dockerfile` while the grammars are `python`, `bash`, `javascript`, `yaml` and `docker`,
// so a consumer never rewrites a fence to get colour. A name nobody registered renders as
// readable plain text rather than being guessed into the wrong grammar: a confidently wrong
// highlight invents structure the code does not have.

/** Aliases an author may write, mapped to the grammar the highlighter loads. */
const ALIASES: Record<string, string> = {
  // Shell and console.
  sh: "bash",
  shell: "bash",
  bash: "bash",
  zsh: "bash",
  shellscript: "bash",
  console: "console",
  terminal: "console",
  session: "console",
  // Python.
  py: "python",
  python: "python",
  python3: "python",
  // Web.
  js: "javascript",
  jsx: "javascript",
  javascript: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  typescript: "typescript",
  html: "html",
  htm: "html",
  xml: "xml",
  css: "css",
  // Data and configuration.
  json: "json",
  jsonc: "jsonc",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  // Systems and tooling.
  dockerfile: "docker",
  docker: "docker",
  containerfile: "docker",
  make: "make",
  makefile: "make",
  nginx: "nginx",
  diff: "diff",
  patch: "diff",
  sql: "sql",
  // Scientific.
  r: "r",
  julia: "julia",
  c: "c",
  cpp: "cpp",
  "c++": "cpp",
  rust: "rust",
  rs: "rust",
  f90: "fortran-free-form",
  fortran: "fortran-free-form",
  "fortran-free-form": "fortran-free-form",
  f77: "fortran-fixed-form",
  "fortran-fixed-form": "fortran-fixed-form",
  // Documentation.
  md: "markdown",
  markdown: "markdown",
  rst: "rst",
  restructuredtext: "rst",
  // Explicitly no highlighting, and not a failure.
  text: "text",
  txt: "text",
  plain: "text",
  plaintext: "text",
  none: "text",
  output: "text",
};

export interface ResolvedLanguage {
  /** The grammar to highlight with, or `undefined` for readable plain text. */
  grammar?: string;
  /** The label recorded on the element, always the normalized name. */
  label: string;
  /** True when the author wrote a name nothing in the registry knows. */
  unknown: boolean;
}

/**
 * Resolve a fence's language. `text` and its aliases resolve to plain text *deliberately* and
 * are not unknown: an author who wrote ```text asked for no colour and should not get a
 * warning for saying so.
 */
export function resolveLanguage(
  raw: string | undefined,
  known: readonly string[],
): ResolvedLanguage {
  if (raw === undefined || raw.trim() === "") return { label: "text", unknown: false };
  const name = raw.trim().toLowerCase();
  const mapped = ALIASES[name];
  if (mapped === "text") return { label: "text", unknown: false };
  if (mapped && known.includes(mapped)) return { grammar: mapped, label: mapped, unknown: false };
  // A registered alias whose grammar the profile does not carry is a profile gap, not an
  // authoring mistake, but it renders the same way: plain text.
  if (mapped) return { label: mapped, unknown: true };
  if (known.includes(name)) return { grammar: name, label: name, unknown: false };
  return { label: name, unknown: true };
}

/**
 * What a reader should be told a snippet is written in. The normalized name is what the
 * machine wants (`bash`, `yaml`), not always what a person calls the thing, and the casing is
 * part of it - `TypeScript`, not `Typescript`. Anything not listed is title-cased from its own
 * name, so a language added to the profile shows up sensibly without an entry here.
 */
const DISPLAY_NAMES: Record<string, string> = {
  bash: "Bash",
  c: "C",
  console: "Console",
  cpp: "C++",
  css: "CSS",
  csv: "CSV",
  diff: "Diff",
  docker: "Dockerfile",
  dockerfile: "Dockerfile",
  fortran: "Fortran",
  "fortran-free-form": "Fortran",
  go: "Go",
  html: "HTML",
  ini: "INI",
  java: "Java",
  javascript: "JavaScript",
  json: "JSON",
  jsonc: "JSON",
  julia: "Julia",
  make: "Make",
  makefile: "Makefile",
  markdown: "Markdown",
  matlab: "MATLAB",
  ncl: "NCL",
  perl: "Perl",
  php: "PHP",
  python: "Python",
  r: "R",
  rst: "reStructuredText",
  ruby: "Ruby",
  rust: "Rust",
  sql: "SQL",
  text: "Text",
  toml: "TOML",
  tsx: "TSX",
  typescript: "TypeScript",
  xml: "XML",
  yaml: "YAML",
};

export function displayLanguage(label: string): string {
  const known = DISPLAY_NAMES[label];
  if (known) return known;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** Every alias the registry accepts, sorted, for documentation and tests. */
export function languageAliases(): string[] {
  return Object.keys(ALIASES).sort();
}
