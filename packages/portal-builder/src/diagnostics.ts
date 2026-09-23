// Every message the builder emits about consumer input goes through here. Every diagnostic
// carries a stable code, a severity, a file path and either a JSON Pointer or a source
// position, and `--diagnostics json` carries the same information a human sees. Formatting the
// two separately is how they drift, so there is one record type and two renderers.

import { compareCodePoints } from "./util/order.js";

export type Severity = "error" | "warning" | "info";

/** A parser- or config-reported position. Columns appear only when faithfully known. */
export interface SourcePosition {
  line: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
}

export interface Diagnostic {
  code: string;
  severity: Severity;
  message: string;
  /** Source-root-relative POSIX path of the file the message is about. */
  file?: string;
  /** RFC 6901 JSON Pointer into the parsed document, for configuration messages. */
  pointer?: string;
  position?: SourcePosition;
  /** A concrete, contract-preserving next step, when one exists. */
  hint?: string;
}

/** The configuration/build diagnostic codes. Content codes live in the profile. */
export const CODES = {
  // Source root and containment
  FP1001: "Path escapes the trusted source root",
  FP1002: "Symlink in a project input",
  FP1003: "Output, temporary or backup tree overlaps an input",
  FP1004: "Path name is not Unicode NFC",
  FP1005: "Output path collision",
  FP1006: "Missing input file",
  // YAML and schema
  FP1101: "YAML or JSON parse error",
  FP1102: "Forbidden YAML feature",
  FP1103: "Duplicate YAML key",
  FP1104: "Schema validation failed",
  FP1105: "Unsupported schemaVersion",
  // Model resolution
  FP1201: "Unknown reference",
  FP1202: "Disabled component reference omitted",
  FP1203: "Enabled component without a valid service",
  FP1204: "Service kind mismatch",
  FP1205: "Invalid service URL",
  FP1206: "Unused service",
  FP1207: "Invalid canonical URL",
  FP1208: "Route or mount collision",
  FP1209: "Duplicate component kind instance",
  FP1210: "Credential-looking value in configuration",
  // `bag.error` takes a plain string, so a code missing from this table is not a type error.
  FP1211: "Required builder-owned materials are missing",
  FP1212: "Theme token accepted but not applied",
  // Distinct from FP1210: an unresolvable package, or one that resolves to an empty tree, is
  // not a credential problem. A deployment whose checkout lacks the badge's vendored `dist/`
  // needs to be told that, not that its configuration contains a credential.
  FP1213: "Required package is not installed",
  FP1214: "Installed package carries no publishable runtime",
  FP1215: "Conflicting playground configuration on one page",
  FP1216: "Conflicting playground origin across the portal",
  FP1217: "An access recipe is shown without a run control",
  FP1218: "Runnable content without a playground configuration",
  FP1219: "Invalid Python playground configuration",
  FP1220: "Credential persistence on the portal's own origin",
  FP1221: "A runnable code block in a place that is not a page",
  FP1222: "Python playground configured but unused",
  // Announcements
  FP1301: "Missing --effective-at for a dated announcement",
  FP1302: "Invalid announcement interval",
  FP1303: "Duplicate announcement id",
  FP1304: "--effective-at supplied but unused",
  // Assets, downloads, subsites
  FP1401: "Asset type not on the embeddable allowlist",
  FP1402: "Rejected SVG content",
  FP1403: "Trusted subsite policy violation",
  FP1404: "Trusted subsite entry point missing",
  FP1405: "Trusted subsite external static resource",
  FP1406: "Trusted subsite inline event handler or javascript: URL",
  FP1407: "Resource limit exceeded",
  FP1408: "Unreferenced static file",
  // Migration of the retired runtime surface
  FP1501: "Retired runtime field has no build-time representation",
  // Component evidence and artifact
  FP1601: "Disabled component appears in the build graph",
  FP1602: "Disabled component appears in the copy manifest",
  FP1603: "Artifact verification failed",
  FP1604: "Prepared component materials are missing",
  FP1606: "Embedded component stylesheet is not contained",
  // Environment
  FP1701: "RST helper handshake mismatch",
  FP1702: "Build-time renderer unavailable",
  // Reproducibility
  FP1801: "Missing or invalid SOURCE_DATE_EPOCH for a release build",
} as const;

export type Code = keyof typeof CODES;

export class DiagnosticBag {
  readonly items: Diagnostic[] = [];

  add(d: Diagnostic): void {
    this.items.push(d);
  }

  error(code: string, message: string, rest: Partial<Diagnostic> = {}): void {
    this.add({ ...rest, code, severity: "error", message });
  }

  warn(code: string, message: string, rest: Partial<Diagnostic> = {}): void {
    this.add({ ...rest, code, severity: "warning", message });
  }

  info(code: string, message: string, rest: Partial<Diagnostic> = {}): void {
    this.add({ ...rest, code, severity: "info", message });
  }

  get errors(): Diagnostic[] {
    return this.items.filter((d) => d.severity === "error");
  }

  get warnings(): Diagnostic[] {
    return this.items.filter((d) => d.severity === "warning");
  }

  /**
   * `warningsAsErrors` is applied here rather than at each call site, so a
   * warning is still *reported* as the warning it is and the promotion is one
   * auditable decision.
   */
  failed(warningsAsErrors: boolean): boolean {
    return this.errors.length > 0 || (warningsAsErrors && this.warnings.length > 0);
  }

  merge(other: DiagnosticBag | Diagnostic[]): void {
    const items = Array.isArray(other) ? other : other.items;
    for (const d of items) this.items.push(d);
  }

  /** Stable ordering: severity, then file, then position, then code. */
  sorted(): Diagnostic[] {
    const rank: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
    return [...this.items].sort(
      (a, b) =>
        rank[a.severity] - rank[b.severity] ||
        compareCodePoints(a.file ?? "", b.file ?? "") ||
        (a.position?.line ?? 0) - (b.position?.line ?? 0) ||
        compareCodePoints(a.pointer ?? "", b.pointer ?? "") ||
        compareCodePoints(a.code, b.code),
    );
  }
}

/** The `--diagnostics json` payload. Identical information to the human form. */
export function toJson(bag: DiagnosticBag): string {
  return JSON.stringify({ schemaVersion: 1, diagnostics: bag.sorted() }, null, 2);
}

export function formatDiagnostic(d: Diagnostic): string {
  const where = d.file
    ? d.position
      ? `${d.file}:${d.position.line}${d.position.column ? `:${d.position.column}` : ""}`
      : d.pointer
        ? `${d.file}#${d.pointer}`
        : d.file
    : (d.pointer ?? "");
  const head = `${d.severity} ${d.code}${where ? ` ${where}` : ""}: ${d.message}`;
  return d.hint ? `${head}\n    hint: ${d.hint}` : head;
}

export function formatHuman(bag: DiagnosticBag): string {
  return bag.sorted().map(formatDiagnostic).join("\n");
}

/** A build stops with this rather than a bare Error, so the CLI can print properly. */
export class BuildFailure extends Error {
  constructor(
    message: string,
    readonly bag: DiagnosticBag,
  ) {
    super(message);
    this.name = "BuildFailure";
  }
}
