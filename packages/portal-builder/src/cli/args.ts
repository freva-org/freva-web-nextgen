// A small, explicit argument parser. The CLI surface is a public API, so it is parsed by
// something whose behavior is written down here rather than by a dependency whose defaults
// could change what `--source-root` means in a patch release.

export interface ParsedArgs {
  command: string;
  flags: Record<string, string | boolean>;
  positional: string[];
  /** Values of the flags that may be repeated, in the order they were given. */
  repeated?: Record<string, string[]>;
}

export class ArgumentError extends Error {}

const KNOWN_FLAGS = new Set([
  "source-root",
  "config",
  "out",
  "dir",
  "url",
  "port",
  "host",
  "effective-at",
  "diagnostics",
  "from",
  "quiet",
  "help",
  "version",
  "builder-image",
  "source-revision",
  "compress",
  "stage",
  "copy",
  "result",
  "keep",
  "stac-materials",
  "python-materials",
  // `prepare-playground`: fetch again despite a current cache, and describe without doing.
  "force",
  "dry-run",
]);

/** Flags that may be given more than once, collected in order. */
const REPEATABLE = new Set(["copy"]);

export function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  const repeated: Record<string, string[]> = {};

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf("=");
    const name = eq === -1 ? body : body.slice(0, eq);
    if (!KNOWN_FLAGS.has(name)) {
      throw new ArgumentError(
        `Unknown option '--${name}'. There is no --runtime, --api-settings or fallback mode.`,
      );
    }
    const record = (value: string): void => {
      // A repeatable flag keeps every value. Overwriting would silently drop all but the last
      // `--copy`, which is a whole input tree going missing.
      if (REPEATABLE.has(name)) (repeated[name] ??= []).push(value);
      else flags[name] = value;
    };
    if (eq !== -1) {
      record(body.slice(eq + 1));
      continue;
    }
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) {
      if (REPEATABLE.has(name)) throw new ArgumentError(`--${name} needs a value`);
      flags[name] = true;
      continue;
    }
    record(next);
    i += 1;
  }

  return { command, flags, positional, repeated };
}

export function requireFlag(args: ParsedArgs, name: string, hint: string): string {
  const value = args.flags[name];
  if (typeof value !== "string" || value === "") {
    throw new ArgumentError(`--${name} is required. ${hint}`);
  }
  return value;
}
