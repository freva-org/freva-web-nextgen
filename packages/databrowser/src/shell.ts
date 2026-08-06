// shell.ts - the shell/OS foundation for the terminal (pure + testable, no UI).
//
// Because the reproducible command targets the API explicitly (`--host <api>` / `host="<api>"`),
// it runs on the USER'S LOCAL machine - so the browser OS is the right signal for the shell
// dialect, and the host comes from the API base the app is already calling. Detection is a HINT
// (see detectOS notes); the layered policy is: config.terminal.shell -> detected default -> user
// override -> persisted. Everything here is a pure function.

export type OSKind = "windows" | "mac" | "linux" | "unknown";
export type ShellId = "bash" | "zsh" | "powershell" | "cmd";

/** A shell dialect: how a copyable command line looks and quotes values. */
export interface Shell {
  id: ShellId;
  label: string;
  /** visual prompt shown in the terminal UI (not part of the copyable command). */
  prompt: string;
  /** line-continuation character for multi-line rendering. */
  cont: string;
  /** shell-safe quoting for a single value pasted into this shell. */
  quote: (v: string) => string;
}

const SAFE_BARE = /^[A-Za-z0-9_./:@%+=-]+$/;

/**
 * POSIX single-quoting (bash/zsh). Single quotes suppress ALL expansion, so a catalogue value
 * like `$(rm -rf ~)` pasted into a terminal is inert. An embedded `'` uses the `'\''` idiom.
 */
export function bashQuote(v: string): string {
  if (v === "") return "''";
  if (SAFE_BARE.test(v)) return v;
  return `'${v.replace(/'/g, "'\\''")}'`;
}

/** PowerShell single-quoted literal: no expansion inside '…'; an embedded `'` is doubled. */
export function psQuote(v: string): string {
  if (v === "") return "''";
  if (SAFE_BARE.test(v)) return v;
  return `'${v.replace(/'/g, "''")}'`;
}

/** cmd.exe double-quoting (best-effort): quote when there's whitespace/special chars; `"`->`""`. */
export function cmdQuote(v: string): string {
  if (v === "") return '""';
  if (SAFE_BARE.test(v)) return v;
  return `"${v.replace(/"/g, '""')}"`;
}

export const SHELLS: Record<ShellId, Shell> = {
  bash: { id: "bash", label: "bash", prompt: "$", cont: "\\", quote: bashQuote },
  zsh: { id: "zsh", label: "zsh", prompt: "%", cont: "\\", quote: bashQuote },
  powershell: { id: "powershell", label: "PowerShell", prompt: "PS>", cont: "`", quote: psQuote },
  cmd: { id: "cmd", label: "cmd", prompt: "C:\\>", cont: "^", quote: cmdQuote },
};

export const SHELL_IDS: ShellId[] = ["bash", "zsh", "powershell", "cmd"];

/** The default (and only-displayed) shell per OS: PowerShell on Windows, bash everywhere else. */
export function defaultShellFor(os: OSKind): ShellId {
  return os === "windows" ? "powershell" : "bash";
}

interface NavLike {
  userAgentData?: { platform?: string };
  platform?: string;
  userAgent?: string;
}

/**
 * Best-effort browser-OS detection, in order of reliability:
 *   1. navigator.userAgentData.platform  (Chromium only, structured)
 *   2. navigator.platform                (legacy, increasingly frozen)
 *   3. navigator.userAgent               (string sniff, last resort)
 * Returns 'unknown' when nothing matches - callers must treat this as a HINT, not truth, and
 * always let the user override.
 */
export function detectOS(nav?: NavLike): OSKind {
  const n =
    nav ?? (typeof navigator !== "undefined" ? (navigator as unknown as NavLike) : undefined);
  if (!n) return "unknown";

  const uaData = n.userAgentData?.platform;
  if (typeof uaData === "string" && uaData) {
    const p = uaData.toLowerCase();
    if (p.includes("win")) return "windows";
    if (p.includes("mac")) return "mac";
    if (p.includes("linux") || p.includes("chrome os") || p.includes("android")) return "linux";
  }

  const plat = (n.platform ?? "").toLowerCase();
  if (plat) {
    if (plat.includes("win")) return "windows";
    if (plat.includes("mac")) return "mac";
    if (plat.includes("linux") || plat.includes("x11")) return "linux";
  }

  const ua = (n.userAgent ?? "").toLowerCase();
  if (ua.includes("windows")) return "windows";
  if (ua.includes("mac os") || ua.includes("macintosh")) return "mac";
  if (ua.includes("linux") || ua.includes("x11")) return "linux";
  return "unknown";
}

/**
 * The `host` for `--host` / `host=` - the API the browser is already calling. Config override wins;
 * otherwise derive from apiBase, resolving a relative base against the page origin. Returns null
 * when nothing usable is available (so the caller simply omits the host argument).
 *
 * NOTE (contract, unverified): the exact form freva-client's `--host` expects (full URL vs bare
 * hostname vs host:port) is a backend contract - kept overridable via config.terminal.host so a
 * deployment can pin the correct form; the default here is the resolved API base URL.
 */
export function deriveHost(
  apiBase: string,
  override?: string | null,
  origin?: string,
): string | null {
  if (typeof override === "string" && override.trim()) return override.trim();
  const base = (apiBase ?? "").trim();
  if (!base) return null;
  if (/^https?:\/\//i.test(base)) return base.replace(/\/+$/, "");
  const org = origin ?? (typeof location !== "undefined" ? location.origin : "");
  if (!org) return base.replace(/\/+$/, "") || null;
  try {
    return new URL(base, org).href.replace(/\/+$/, "");
  } catch {
    return base.replace(/\/+$/, "") || null;
  }
}
