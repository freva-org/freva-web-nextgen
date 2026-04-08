/**
 * ZarrPoller — framework-agnostic replacement for the useZarrStatus React hook.
 *
 * Backend status codes:
 *   0  finished, ok
 *   1  finished, failed
 *   2  finished, not found
 *   3  waiting
 *   4  processing
 *   5  gone / unknown
 */

export interface ZarrPollerOptions {
  /** Polling interval in ms. Default: 2000 */
  intervalMs?: number;
  /** Override auth header injection. Default: reads freva_auth_token cookie. */
  getAuthHeaders?: () => Record<string, string>;
  /** Override the status endpoint URL. Receives the already-encoded zarr URL. */
  getStatusUrl?: (encodedZarrUrl: string) => string;
  /** Called whenever a new status code arrives. */
  onStatus?: (statusCode: number) => void;
  /** Called on network / parse error. */
  onError?: (error: string) => void;
}

const DEFAULT_COOKIE_NAME = "freva_auth_token=";

function defaultGetAuthHeaders(): Record<string, string> {
  const cookies = document.cookie.split(";");
  const authCookie = cookies.find((c) => c.trim().startsWith(DEFAULT_COOKIE_NAME));
  if (!authCookie) return {};
  try {
    let value = authCookie.substring(authCookie.indexOf("=") + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    return value ? { Authorization: `Bearer ${value}` } : {};
  } catch {
    return {};
  }
}

function defaultGetStatusUrl(encodedZarrUrl: string): string {
  return `/api/freva-nextgen/data-portal/zarr-utils/status?url=${encodedZarrUrl}&timeout=1`;
}

export class ZarrPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private cancelled = false;

  private readonly zarrUrl: string;
  private readonly intervalMs: number;
  private readonly getAuthHeaders: () => Record<string, string>;
  private readonly getStatusUrl: (encoded: string) => string;
  private readonly onStatus: (code: number) => void;
  private readonly onError: (err: string) => void;

  constructor(zarrUrl: string, options: ZarrPollerOptions = {}) {
    this.zarrUrl = zarrUrl;
    this.intervalMs = options.intervalMs ?? 2000;
    this.getAuthHeaders = options.getAuthHeaders ?? defaultGetAuthHeaders;
    this.getStatusUrl = options.getStatusUrl ?? defaultGetStatusUrl;
    this.onStatus = options.onStatus ?? (() => {});
    this.onError = options.onError ?? (() => {});
  }

  start(): void {
    this.cancelled = false;
    void this.poll();
    this.timer = setInterval(() => {
      void this.poll();
    }, this.intervalMs);
  }

  stop(): void {
    this.cancelled = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async poll(): Promise<void> {
    try {
      const url = this.getStatusUrl(encodeURIComponent(this.zarrUrl));
      const res = await fetch(url, {
        credentials: "same-origin",
        headers: this.getAuthHeaders(),
      });

      if (!res.ok) {
        if (!this.cancelled) this.onStatus(5);
        return;
      }

      const data = (await res.json()) as { status?: number };
      const code = data.status ?? 5;

      if (!this.cancelled) {
        this.onStatus(code);
        // Stop polling on terminal states (0 = ok, 1 = failed, 2 = not found)
        if (code <= 2) this.stop();
      }
    } catch (err) {
      if (!this.cancelled) {
        this.onError(err instanceof Error ? err.message : String(err));
      }
    }
  }
}
