/**
 * What survives an ACTUAL browser restart, and what is supposed not to.
 *
 * Every other suite runs inside one browser process, so what they prove about storage is a proof
 * about one page load. Two claims are about the other thing: credentials outlive the tab, because
 * the token store is IndexedDB-backed (IDBFS) and the origin's storage belongs to the profile;
 * and the OPFS workspace does NOT, with the directory a killed session left behind RECLAIMED by
 * the next one. That second claim is `removeStaleSessions`, so this suite launches a PERSISTENT
 * context against a fixed user-data directory, kills the whole browser, and launches a second one
 * against the same directory. One server serves both, because storage is per-origin.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixturePage, isStrict, report, requireDist, serve } from "./harness.mjs";

requireDist();

const checks = [];
const ok = (name, pass, detail) => checks.push({ name, pass, detail: String(detail ?? "") });

/** What the page can see of OPFS, from the outside: the session directories that exist. */
const OPFS_SESSIONS = `(async () => {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle("browser-python-workspace", { create: false });
    const names = [];
    for await (const name of dir.keys()) names.push(name);
    return names.sort();
  } catch (error) {
    return { error: String(error && error.name) };
  }
})()`;

let server;
let profileDir;
/** "pass" only survives to the end if nothing threw; the checks below can still fail it. */
let status = "pass";
let detail = "";
try {
  const playwright = await import("playwright");
  const override = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  server = await serve(fixturePage({ profile: "minimal", workspaceMaxFiles: 4 }));
  profileDir = mkdtempSync(join(tmpdir(), "browser-python-profile-"));

  /** One whole browser lifetime against the same on-disk profile. */
  const launch = async (body) => {
    const context = await playwright.chromium.launchPersistentContext(profileDir, {
      ...(override ? { executablePath: override } : {}),
      args: ["--no-sandbox"],
    });
    try {
      const page = await context.newPage();
      await page.goto(server.url, { waitUntil: "load" });
      await page.waitForFunction(() => window.__py !== undefined);
      return await body(page);
    } finally {
      // Not `page.close()`: the point is that the whole browser goes away with a workspace
      // session open, exactly as a crash or a quit does.
      await context.close();
    }
  };

  const first = await launch(async (page) => {
    await page.evaluate(() => window.__py.start());
    const state = await page.evaluate(async () => {
      await window.__py.run(
        "with open('survivor.txt', 'w') as fh:\n    fh.write('written before the restart')\n",
      );
      return {
        session: window.__py.engine.workspace?.sessionId ?? null,
        artifacts: (await window.__py.artifacts()).map((a) => a.name),
      };
    });
    // A value in IndexedDB, written the way the token store's backing FS writes one: same origin,
    // same storage bucket, no engine involvement, so this measures the BROWSER rather than us.
    await page.evaluate(async () => {
      await new Promise((resolve, reject) => {
        const open = indexedDB.open("browser-python-persistence-probe", 1);
        open.onupgradeneeded = () => open.result.createObjectStore("kv");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction("kv", "readwrite");
          tx.objectStore("kv").put("a token, as far as this test is concerned", "credential");
          tx.oncomplete = () => (open.result.close(), resolve());
          tx.onerror = () => reject(tx.error);
        };
      });
    });
    const sessions = await page.evaluate(OPFS_SESSIONS);
    return { ...state, sessions };
  });

  ok(
    "a first browser writes an artifact into a real OPFS workspace session",
    first.artifacts.join(",") === "survivor.txt" && typeof first.session === "string",
    JSON.stringify(first),
  );
  ok(
    "…and the session's directory is really on disk, under the workspace root",
    Array.isArray(first.sessions) && first.sessions.includes(first.session),
    JSON.stringify(first.sessions),
  );

  const second = await launch(async (page) => {
    const credential = await page.evaluate(async () => {
      return await new Promise((resolve, reject) => {
        const open = indexedDB.open("browser-python-persistence-probe", 1);
        open.onupgradeneeded = () => open.result.createObjectStore("kv");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const get = open.result.transaction("kv", "readonly").objectStore("kv").get("credential");
          get.onsuccess = () => (open.result.close(), resolve(get.result ?? null));
          get.onerror = () => reject(get.error);
        };
      });
    });
    // BEFORE the engine starts: the directories the dead browser left behind, still there.
    const before = await page.evaluate(OPFS_SESSIONS);
    await page.evaluate(() => window.__py.start());
    const state = await page.evaluate(async () => ({
      session: window.__py.engine.workspace?.sessionId ?? null,
      artifacts: (await window.__py.artifacts()).map((a) => a.name),
      available: window.__py.engine.workspace?.available ?? null,
    }));
    const after = await page.evaluate(OPFS_SESSIONS);
    return { credential, before, after, ...state };
  });

  ok(
    "credentials survive the browser restart: the IndexedDB value is still there",
    second.credential === "a token, as far as this test is concerned",
    JSON.stringify(second.credential),
  );
  ok(
    "the killed session's OPFS directory outlives the process that made it",
    Array.isArray(second.before) && second.before.includes(first.session),
    JSON.stringify(second.before),
  );
  ok(
    "…and is deliberately LEFT ALONE while it is younger than the startup grace period",
    Array.isArray(second.after) && second.after.includes(first.session),
    JSON.stringify(second.after),
  );
  ok(
    "the new session is a different one, and a working one",
    second.available === true && second.session !== first.session,
    JSON.stringify({ before: first.session, after: second.session }),
  );
  ok(
    "the workspace itself is NOT persistent, which is the documented contract",
    second.artifacts.length === 0,
    JSON.stringify(second.artifacts),
  );

  // PAST THE GRACE PERIOD, and only now is the reclaim due. A directory younger than
  // `STARTUP_GRACE_MS` is skipped without being opened, because a session still coming up has not
  // taken its lock yet. The two launches above are inside the window on any reasonable machine, so
  // testing the sweep means being after it: a real 30 seconds, once.
  const GRACE_MS = 30_000;
  // Measured from the YOUNGEST abandoned directory, not from the start of the suite. The grace
  // period is read out of each directory's own name, so waiting on the wrong one leaves the second
  // launch's directory legitimately too young to touch.
  const bornAt = (name) => Number.parseInt(String(name).slice(2).split("-")[0], 36);
  const youngest = Math.max(bornAt(first.session), bornAt(second.session));
  const waited = Math.max(0, GRACE_MS + 2_000 - (Date.now() - youngest));
  await new Promise((resolve) => setTimeout(resolve, waited));

  const third = await launch(async (page) => {
    const before = await page.evaluate(OPFS_SESSIONS);
    await page.evaluate(() => window.__py.start());
    return {
      before,
      after: await page.evaluate(OPFS_SESSIONS),
      session: await page.evaluate(() => window.__py.engine.workspace?.sessionId ?? null),
      available: await page.evaluate(() => window.__py.engine.workspace?.available ?? null),
    };
  });

  ok(
    "a third browser, past the grace period, RECLAIMS both abandoned directories",
    Array.isArray(third.after) &&
      !third.after.includes(first.session) &&
      !third.after.includes(second.session),
    JSON.stringify({ waitedMs: waited, before: third.before, after: third.after }),
  );
  ok(
    "…leaving only its own, so directories do not accumulate across restarts",
    Array.isArray(third.after) &&
      third.after.length === 1 &&
      third.after[0] === third.session &&
      third.available === true,
    JSON.stringify(third.after),
  );
} catch (error) {
  // A MISSING BROWSER IS A SKIP; EVERYTHING ELSE, AND EVERYTHING UNDER STRICT MODE, IS A
  // FAILURE. Recomputing the status from an empty array of checks throws this away - `[].every()`
  // is `true` - so a browser that could not launch prints FAIL, prints "0/0 checks pass" and exits
  // 0. The status set here is the one reported, and `report` refuses zero checks anyway.
  const unlaunchable = /launch|executable doesn't exist|Failed to launch/i.test(
    String(error?.message ?? error),
  );
  status = isStrict() || !unlaunchable ? "fail" : "skipped";
  detail = `${error?.message ?? error}`.split("\n")[0];
} finally {
  // TEARDOWN COUNTS TOO. A server that will not close or a profile directory that cannot be
  // removed leaves the machine dirtier than it found it, and no check would ever record it - so it
  // is recorded here, and it can only ever make the outcome worse.
  try {
    await server?.close();
    if (profileDir) rmSync(profileDir, { recursive: true, force: true });
  } catch (error) {
    status = "fail";
    detail = `${detail ? `${detail}; ` : ""}teardown failed: ${error?.message ?? error}`;
  }
}

process.exit(
  report("persistence across a real browser restart (Chromium)", { status, detail, checks }),
);
