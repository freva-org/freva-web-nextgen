// The RST helper's timeout must end the helper, not just the request. The protocol is one JSON
// line in, one JSON line out, with no request identifier, so the pairing is positional: if a
// render times out and the request rejects while the process keeps running, the late answer is
// indistinguishable from the answer to the *next* document and is silently handed to it.
//
// The fixture below stalls its first answer past the timeout and answers the second
// immediately, so a client that reused the stream hands document two `answeredRequest: 1`.

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RstHelper } from "../../src/rendering/rst/client.js";
import { loadProfile } from "../../src/rendering/profile.js";
import { PACKAGE_ROOT } from "../../src/util/package.js";

const { profile } = loadProfile();

const SLOW_HELPER = join(PACKAGE_ROOT, "tests", "helpers", "slow-rst-helper.py");

function handshake(): string {
  return JSON.stringify({
    protocol: profile.rst.protocol,
    package: profile.rst.helper.package,
    version: profile.rst.helper.version,
    docutils: profile.rst.docutilsVersion,
  });
}

function slowHelper(delaySeconds: number, renderTimeoutMs: number): RstHelper {
  return new RstHelper(profile, {
    renderTimeoutMs,
    candidates: [
      {
        command: process.env.PYTHON ?? "python3",
        args: [SLOW_HELPER, handshake(), String(delaySeconds)],
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      },
    ],
  });
}

describe("the RST helper's lifecycle", () => {
  it("answers normally when nothing goes wrong", async () => {
    const helper = slowHelper(0, 5_000);
    try {
      const first = (await helper.render("First.", "first.rst")) as unknown as {
        answeredRequest: number;
        name: string;
      };
      expect(first.answeredRequest).toBe(1);
      expect(first.name).toBe("first.rst");
      const second = (await helper.render("Second.", "second.rst")) as unknown as {
        answeredRequest: number;
      };
      expect(second.answeredRequest).toBe(2);
    } finally {
      helper.stop();
    }
  }, 30_000);

  it("never lets a late answer become the next document's answer", async () => {
    const helper = slowHelper(3, 250);
    try {
      await expect(helper.render("First.", "first.rst")).rejects.toThrow(/within 250ms/);

      // The second request must not receive the first document's late line: it fails, because
      // the helper this client was talking to is gone.
      await expect(helper.render("Second.", "second.rst")).rejects.toThrow(/terminated|not/);

      // And waiting past the original delay must not resurrect anything.
      await new Promise((done) => setTimeout(done, 3_500));
      await expect(helper.render("Third.", "third.rst")).rejects.toThrow();
    } finally {
      helper.stop();
    }
  }, 30_000);

  it("refuses every later request once it has been poisoned", async () => {
    const helper = slowHelper(3, 200);
    try {
      await expect(helper.render("First.", "first.rst")).rejects.toThrow();
      const outcomes = await Promise.allSettled([
        helper.render("a", "a.rst"),
        helper.render("b", "b.rst"),
        helper.render("c", "c.rst"),
      ]);
      expect(outcomes.map((o) => o.status)).toEqual(["rejected", "rejected", "rejected"]);
    } finally {
      helper.stop();
    }
  }, 30_000);

  it("stays stopped after stop(), rather than waiting on a closed stream", async () => {
    const helper = slowHelper(0, 5_000);
    await helper.render("First.", "first.rst");
    helper.stop();
    await expect(helper.render("Second.", "second.rst")).rejects.toThrow(/stopped/);
  }, 30_000);
});
