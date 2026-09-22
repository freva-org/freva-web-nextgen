/**
 * The lifecycle edges: a version mismatch, two tabs coming up at once, and shutting down.
 *
 *     node browser-tests/workspace-lifecycle.mjs
 *
 * None occurs in development, where the page and the worker are rebuilt together, one tab is open
 * and nobody closes anything gracefully. All three occur in production, and two can lose work
 * quietly: a page cached across a deployment talks to a worker that no longer speaks its protocol,
 * and two tabs starting in the same instant race for the same OPFS session directories.
 */
import {
  bundleConsole,
  fixturePage,
  inBrowser,
  probeWorkerCapabilities,
  report,
  requireDist,
  serve,
  workspaceFallbackChecks,
} from "./harness.mjs";

requireDist();

// Read from the built package rather than written out, so a protocol bump does not silently make
// this suite assert against a version nobody speaks any more.
const { PROTOCOL_VERSION } = await import("../dist/protocol.js");

bundleConsole();

/** Post an `init` at `protocol` to a fresh worker and report the first decisive reply. */
const initAt = (protocol, id) => `(async () => {
  const worker = new Worker(new URL("/dist/worker/browser-python.worker.js", location.href), {
    type: "module",
  });
  const message = await new Promise((resolve) => {
    worker.onmessage = (event) => {
      if (event.data?.kind === "fatal" || event.data?.kind === "ready") resolve(event.data);
    };
    worker.onerror = (event) => resolve({ kind: "error", message: String(event.message) });
    worker.postMessage({
      kind: "init",
      id: ${JSON.stringify(id)},
      protocol: ${protocol},
      profile: "minimal",
      indexURL: new URL("/runtime/", location.href).href,
      packages: [],
    });
    setTimeout(() => resolve({ kind: "timeout" }), 60000);
  });
  worker.terminate();
  return message;
})()`;

/** Every session directory the origin currently holds. */
const SESSION_NAMES = `(async () => {
  const root = await navigator.storage.getDirectory();
  const sessions = await root.getDirectoryHandle("browser-python-workspace", { create: false });
  const names = [];
  for await (const name of sessions.keys()) names.push(name);
  return names;
})()`;

const result = await inBrowser(async (page) => {
  const server = await serve(fixturePage({ profile: "minimal", workspaceMaxFiles: 4 }));
  const checks = [];
  const ok = (name, pass, detail) => checks.push({ name, pass, detail: String(detail ?? "") });
  try {
    await page.goto(server.url);
    await page.waitForFunction(() => window.__py !== undefined, null, { timeout: 20000 });

    // An old page against a new worker. v1 is what the page spoke before artifacts existed; a
    // worker that accepted it would go on to answer `artifact-read` requests whose reply shape has
    // since changed.
    const stale = await page.evaluate(initAt(1, "stale"));
    ok(
      "a page speaking an older protocol is refused, not served",
      stale.kind === "fatal" && stale.id === "stale",
      JSON.stringify({ kind: stale.kind, id: stale.id }),
    );
    ok(
      "…and the refusal names both versions and both possible causes",
      /v1\b/.test(stale.message ?? "") &&
        new RegExp(`v${PROTOCOL_VERSION}\\b`).test(stale.message ?? "") &&
        /reload/i.test(stale.message ?? "") &&
        /cache/i.test(stale.message ?? ""),
      stale.message,
    );

    const future = await page.evaluate(initAt(99, "future"));
    ok(
      "a NEWER page against a cached worker is refused the same way",
      future.kind === "fatal" && /v99/.test(future.message ?? ""),
      future.message,
    );

    // Everything from here is about OPFS session directories. Asked of a Worker first, because
    // the next step is two tabs STARTING at once and the answer is needed before either does.
    const worker = await probeWorkerCapabilities(page);
    if (!worker.opfsUsable) {
      const status = await page.evaluate(() => window.__py.start().then((info) => info.workspace));
      const fallback = await workspaceFallbackChecks(page, status, worker);
      checks.push(...fallback.checks);
      return { checks, unavailable: fallback.reason };
    }

    // two tabs starting in the same instant
    const second = await page.context().newPage();
    try {
      await second.goto(server.url);
      await second.waitForFunction(() => window.__py !== undefined, null, { timeout: 20000 });

      // Started together, deliberately. Sequential startup is the easy case and is covered
      // elsewhere; this is the one where each tab's stale sweep can see the other mid-creation.
      const [first, other] = await Promise.all([
        page.evaluate(() => window.__py.start().then((info) => info.workspace)),
        second.evaluate(() => window.__py.start().then((info) => info.workspace)),
      ]);
      ok(
        "two tabs starting simultaneously both get a working, separate workspace",
        first?.available === true &&
          other?.available === true &&
          first.sessionId !== other.sessionId,
        JSON.stringify({ first: first?.sessionId, other: other?.sessionId }),
      );

      const bothWrote = await Promise.all([
        page.evaluate(async () => {
          const r = await window.__py.run(
            "with open('first.txt', 'w') as fh:\n    fh.write('one')\n",
          );
          return {
            error: r.error ?? null,
            names: (await window.__py.artifacts()).map((a) => a.name),
          };
        }),
        second.evaluate(async () => {
          const r = await window.__py.run(
            "with open('second.txt', 'w') as fh:\n    fh.write('two')\n",
          );
          return {
            error: r.error ?? null,
            names: (await window.__py.artifacts()).map((a) => a.name),
          };
        }),
      ]);
      ok(
        "…and neither sweeps away the other's storage: both writes land",
        bothWrote.every((tab) => tab.error === null) &&
          bothWrote[0].names.join() === "first.txt" &&
          bothWrote[1].names.join() === "second.txt",
        JSON.stringify(bothWrote),
      );

      const survived = await page.evaluate(() => window.__py.readArtifactText("first.txt"));
      ok(
        "…and the first tab's file is still readable after the second has been running",
        survived === "one",
        JSON.stringify(survived),
      );

      // graceful shutdown
      const gracefulSession = await second.evaluate(async () => {
        const before = window.__py.workspace()?.sessionId;
        await window.__py.engine.disposeAsync();
        return { before, state: window.__py.state() };
      });
      ok(
        "disposeAsync() shuts the second tab down cleanly and reaches the disposed state",
        gracefulSession.state === "disposed" && typeof gracefulSession.before === "string",
        JSON.stringify(gracefulSession),
      );

      const afterGraceful = await page.evaluate(SESSION_NAMES);
      ok(
        "…releasing its storage directory itself rather than leaving it for the next sweep",
        !afterGraceful.includes(gracefulSession.before),
        JSON.stringify({ remaining: afterGraceful, released: gracefulSession.before }),
      );

      // forced shutdown
      const third = await page.context().newPage();
      let forcedSession;
      try {
        await third.goto(server.url);
        await third.waitForFunction(() => window.__py !== undefined, null, { timeout: 20000 });
        forcedSession = await third.evaluate(() =>
          window.__py.start().then((info) => info.workspace.sessionId),
        );
        await third.evaluate(() =>
          window.__py.run("with open('doomed.txt', 'w') as fh:\n    fh.write('x')\n"),
        );
      } finally {
        // Closed outright: no dispose, no acknowledgement. What a crash, or a closed laptop lid,
        // looks like from the worker's side.
        await third.close();
      }

      const afterCrash = await page.evaluate(SESSION_NAMES);
      ok(
        "a tab that is killed leaves its directory behind - which is what the sweep is for",
        afterCrash.includes(forcedSession),
        JSON.stringify({ remaining: afterCrash, crashed: forcedSession }),
      );

      // Reclamation is DELIBERATELY not immediate. A directory younger than the startup grace
      // period is not examined at all - not even to look at its lock - because taking the lock is
      // two calls and a sweep landing between them would delete a directory another tab is
      // filling. So the killed tab's storage survives the next startup, and a later one reclaims it.
      const notYet = await page.evaluate(async () => {
        const { createBrowserPython } = await import("/dist/index.js");
        const sweeper = createBrowserPython({
          profile: "minimal",
          pyodide: { indexURL: new URL("/runtime/", location.href).href },
          workspaceMaxFiles: 2,
        });
        await sweeper.start();
        const root = await navigator.storage.getDirectory();
        const sessions = await root.getDirectoryHandle("browser-python-workspace", {
          create: false,
        });
        const names = [];
        for await (const name of sessions.keys()) names.push(name);
        await sweeper.disposeAsync();
        return names;
      });
      ok(
        "…and a startup moments later leaves it alone, because it might still be coming up",
        notYet.includes(forcedSession),
        JSON.stringify({ remaining: notYet, crashed: forcedSession }),
      );

      // the sweep itself, against directories it can date
      const sweep = await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const sessions = await root.getDirectoryHandle("browser-python-workspace", {
          create: true,
        });
        // Two fabricated sessions with ages in their names, which is where the age lives - see
        // `sessionAgeMs`. One abandoned, one with its lock genuinely held.
        const old = `s-${(Date.now() - 600000).toString(36)}-abandoned`;
        const held = `s-${(Date.now() - 600000).toString(36)}-alive`;
        for (const name of [old, held]) {
          const dir = await sessions.getDirectoryHandle(name, { create: true });
          await dir.getFileHandle("lock", { create: true });
        }
        // The lock is held from a WORKER, because that is the only place it can be: sync access
        // handles do not exist on the main thread, which is the constraint the whole pool design
        // is built around. A tiny worker holds it open for the duration of the sweep.
        const holder = new Worker(
          URL.createObjectURL(
            new Blob(
              [
                `self.onmessage = async (event) => {
                   const root = await navigator.storage.getDirectory();
                   const dir = await root.getDirectoryHandle("browser-python-workspace");
                   const session = await dir.getDirectoryHandle(event.data);
                   const file = await session.getFileHandle("lock");
                   self.__held = await file.createSyncAccessHandle();
                   self.postMessage("held");
                 };`,
              ],
              { type: "text/javascript" },
            ),
          ),
          { type: "module" },
        );
        await new Promise((resolve) => {
          holder.onmessage = resolve;
          holder.postMessage(held);
        });

        const { createBrowserPython } = await import("/dist/index.js");
        const sweeper = createBrowserPython({
          profile: "minimal",
          pyodide: { indexURL: new URL("/runtime/", location.href).href },
          workspaceMaxFiles: 2,
        });
        await sweeper.start();
        const names = [];
        for await (const name of sessions.keys()) names.push(name);
        await sweeper.disposeAsync();
        holder.terminate();
        await sessions.removeEntry(held, { recursive: true }).catch(() => {});
        return { names, old, held };
      });
      ok(
        "an old session whose lock nothing holds is reclaimed",
        !sweep.names.includes(sweep.old),
        JSON.stringify({ removed: sweep.old, remaining: sweep.names }),
      );
      ok(
        "…and one whose lock IS held is left strictly alone, however old it is",
        sweep.names.includes(sweep.held),
        JSON.stringify({ kept: sweep.held, remaining: sweep.names }),
      );
    } finally {
      await second.close();
    }

    return checks;
  } catch (error) {
    ok("the suite ran to the end", false, String(error?.message ?? error).split("\n")[0]);
    return checks;
  } finally {
    await server.close();
  }
});

process.exit(report("workspace lifecycle: versions, tabs and shutdown", result));
