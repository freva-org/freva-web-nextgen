/**
 * `prepare-addons` fetching a pinned artefact
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  FETCH_ATTEMPTS,
  FETCH_BACKOFF_MS,
  fetchPinned,
  transientFetchFailure,
} from "../bin/freva-addons.mjs";

const BODY = Buffer.from("a pinned wheel");
const ARTIFACT = {
  path: "dask/example.whl",
  url: "https://files.example/example.whl",
  sha256: createHash("sha256").update(BODY).digest("hex"),
};

const ok = () => new Response(BODY, { status: 200 });
const status = (code: number) => () => new Response("no", { status: code });
const reset = () => {
  throw new TypeError("fetch failed");
};

/** A fetch that plays back `steps` in order, recording every call and every pause. */
function scripted(steps: (() => Response)[]) {
  const calls: string[] = [];
  const pauses: number[] = [];
  const fetchImpl = async (url: string) => {
    calls.push(url);
    const step = steps[Math.min(calls.length - 1, steps.length - 1)]!;
    return step();
  };
  const sleep = async (ms: number) => {
    pauses.push(ms);
  };
  return { calls, pauses, options: { fetchImpl, sleep } };
}

describe("fetchPinned", () => {
  it("returns the bytes at once when the first attempt succeeds", async () => {
    const run = scripted([ok]);
    await expect(fetchPinned(ARTIFACT, run.options)).resolves.toEqual(BODY);
    expect(run.calls).toHaveLength(1);
    expect(run.pauses).toEqual([]);
  });

  it("retries a reset connection and a 503, with a growing pause, then succeeds", async () => {
    const run = scripted([reset, status(503), ok]);
    await expect(fetchPinned(ARTIFACT, run.options)).resolves.toEqual(BODY);
    expect(run.calls).toHaveLength(3);
    expect(run.pauses).toEqual(FETCH_BACKOFF_MS.slice(0, 2));
  });

  it("gives up after FETCH_ATTEMPTS, and says how many it made", async () => {
    const run = scripted([reset]);
    await expect(fetchPinned(ARTIFACT, run.options)).rejects.toThrow(
      new RegExp(`after ${FETCH_ATTEMPTS} attempts`),
    );
    expect(run.calls).toHaveLength(FETCH_ATTEMPTS);
  });

  it("never retries a 404: the artefact is not there", async () => {
    const run = scripted([status(404), ok]);
    await expect(fetchPinned(ARTIFACT, run.options)).rejects.toThrow(/responded 404/);
    expect(run.calls).toHaveLength(1);
  });

  it("never retries a digest mismatch: different bytes are refused, not re-asked for", async () => {
    const run = scripted([() => new Response("other bytes", { status: 200 }), ok]);
    await expect(fetchPinned(ARTIFACT, run.options)).rejects.toThrow(/SHA-256 mismatch/);
    expect(run.calls).toHaveLength(1);
  });

  it("classifies failures: network, 408, 429 and 5xx are transient; 4xx and mismatches are not", () => {
    expect(transientFetchFailure(new TypeError("fetch failed"))).toBe(true);
    for (const code of [408, 429, 500, 502, 503]) {
      expect(transientFetchFailure(Object.assign(new Error("x"), { status: code }))).toBe(true);
    }
    for (const code of [400, 401, 403, 404, 410]) {
      expect(transientFetchFailure(Object.assign(new Error("x"), { status: code }))).toBe(false);
    }
    expect(transientFetchFailure(new Error("SHA-256 mismatch"))).toBe(false);
  });
});
