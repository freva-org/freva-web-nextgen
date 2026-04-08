import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ZarrPoller } from "../ZarrPoller";

const ZARR_URL = "https://example.com/store.zarr";

function mockFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("ZarrPoller", () => {
  it("calls onStatus with the status code from the response", async () => {
    globalThis.fetch = mockFetch(200, { status: 4 });
    const onStatus = vi.fn();

    const poller = new ZarrPoller(ZARR_URL, { onStatus, intervalMs: 1000 });
    poller.start();
    await vi.advanceTimersByTimeAsync(0); // flush initial poll

    expect(onStatus).toHaveBeenCalledWith(4);
    poller.stop();
  });

  it("stops polling automatically on terminal status code 0 (ok)", async () => {
    globalThis.fetch = mockFetch(200, { status: 0 });
    const onStatus = vi.fn();

    const poller = new ZarrPoller(ZARR_URL, { onStatus, intervalMs: 1000 });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    const callCount = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callCount);
  });

  it("calls onError on network failure", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network error"));
    const onError = vi.fn();

    const poller = new ZarrPoller(ZARR_URL, { onError, intervalMs: 1000 });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(onError).toHaveBeenCalledWith("network error");
    poller.stop();
  });

  it("calls onStatus(5) on non-ok HTTP response", async () => {
    globalThis.fetch = mockFetch(500, {});
    const onStatus = vi.fn();

    const poller = new ZarrPoller(ZARR_URL, { onStatus, intervalMs: 1000 });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(onStatus).toHaveBeenCalledWith(5);
    poller.stop();
  });

  it("uses custom getStatusUrl", async () => {
    globalThis.fetch = mockFetch(200, { status: 3 });
    const getStatusUrl = vi.fn(
      (encoded: string) => `https://custom.example.com/status?url=${encoded}`,
    );

    const poller = new ZarrPoller(ZARR_URL, { getStatusUrl, intervalMs: 1000 });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(getStatusUrl).toHaveBeenCalledWith(encodeURIComponent(ZARR_URL));
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("custom.example.com"),
      expect.any(Object),
    );
    poller.stop();
  });

  it("stop() prevents further callbacks after being called", async () => {
    globalThis.fetch = mockFetch(200, { status: 3 });
    const onStatus = vi.fn();

    const poller = new ZarrPoller(ZARR_URL, { onStatus, intervalMs: 1000 });
    poller.start();
    poller.stop();
    await vi.advanceTimersByTimeAsync(0);

    expect(onStatus).not.toHaveBeenCalled();
  });

  it("uses custom getAuthHeaders", async () => {
    globalThis.fetch = mockFetch(200, { status: 3 });
    const getAuthHeaders = vi.fn(() => ({ Authorization: "Bearer mytoken" }));

    const poller = new ZarrPoller(ZARR_URL, { getAuthHeaders, intervalMs: 1000 });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: { Authorization: "Bearer mytoken" } }),
    );
    poller.stop();
  });
});
