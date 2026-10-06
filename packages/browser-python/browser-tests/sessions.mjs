// Sessions against real interpreters, the real origin private file system and real Web Locks:
// two setups side by side, the two-slot ceiling under concurrent clicks, forged choices, honest
// telemetry (WASM growth, a stale sample during a tight loop), and manual sleep - a byte-identical
// workspace after waking, Python state lost, a damaged checkpoint quarantined.
import { inBrowser, report, requireDist, requireRuntimeFor, serve } from "./harness.mjs";

requireDist();
requireRuntimeFor("sessions", "sessions.mjs");

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>sessions</title></head><body>
<script type="module">
  import { createBrowserPython } from "/dist/index.js";
  import * as session from "/dist/session/index.js";
  const indexURL = new URL("/runtime/", location.href).href;
  const policy = {
    profiles: { minimal: { allowedAddons: [] }, "xarray-zarr": { allowedAddons: [] } },
    starter: true,
    starterProfiles: ["minimal"],
    allowSkipStarter: true,
    notebook: false,
    defaults: { profile: "minimal", addons: [], runStarter: true, frontend: "console" },
  };
  const fingerprint = session.policyFingerprint(policy);
  const slots = session.createSlotBroker({ capacity: 2, scope: "sessions-test-" + crypto.randomUUID() });
  let created = 0;
  let store = null;
  const sharedStore = () => (store ??= session.openCheckpointStore());
  window.__s = {
    session,
    policy,
    slots,
    created: () => created,
    make(id, choice, options = {}) {
      const check = session.validateSetup(policy, choice);
      if (!check.ok) throw new Error(check.problems.join("; "));
      const outputs = [];
      const controller = new session.SessionController({
        id,
        setup: check.setup,
        policy: fingerprint,
        slots,
        createEngine(setup) {
          created += 1;
          const engine = createBrowserPython({ profile: setup.profile, addons: setup.addons, pyodide: { indexURL } });
          engine.onOutput((e) => outputs.push(e));
          return engine;
        },
        store: options.noStore ? () => Promise.resolve(null) : sharedStore,
        starter: (engine) => engine.run("STARTED = 'yes'"),
        attach() {},
        detach() {},
      });
      controller.outputs = outputs;
      return controller;
    },
    /** Run code; what it printed, and its error if any. */
    async py(controller, code) {
      controller.outputs.length = 0;
      const result = await controller.engine.run(code);
      const out = controller.outputs.filter((e) => e.type === "stdout").map((e) => e.text).join("");
      return { out: out.trim(), error: result.error };
    },
  };
  window.__ready = true;
</script></body></html>`;

const result = await inBrowser(async (page) => {
  const server = await serve(PAGE);
  const checks = [];
  const check = (name, pass, detail) =>
    checks.push({
      name,
      pass: Boolean(pass),
      ...(detail !== undefined ? { detail: String(detail).slice(0, 400) } : {}),
    });
  try {
    await page.goto(server.url);
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });

    // Forged choices never reach an engine.
    const forged = await page.evaluate(() => {
      const out = [];
      for (const choice of [
        { profile: "freva-client", addons: [], runStarter: false, frontend: "console" },
        { profile: "minimal", addons: ["dask"], runStarter: true, frontend: "console" },
        { profile: "minimal", addons: [], runStarter: true, frontend: "notebook" },
        {
          profile: "minimal",
          addons: [],
          runStarter: true,
          frontend: "console",
          source: "import os",
        },
      ]) {
        try {
          window.__s.make("forged", choice);
          out.push("accepted");
        } catch (error) {
          out.push(error.message);
        }
      }
      return { out, created: window.__s.created() };
    });
    check(
      "forged setup choices are refused before any engine exists",
      forged.out.every((m) => m !== "accepted") && forged.created === 0,
      JSON.stringify(forged),
    );

    // Two setups, one slot each, a third refused - with concurrent clicks.
    const two = await page.evaluate(async () => {
      const a = window.__s.make("sa", {
        profile: "minimal",
        addons: [],
        runStarter: true,
        frontend: "console",
      });
      const b = window.__s.make("sb", {
        profile: "xarray-zarr",
        addons: [],
        runStarter: false,
        frontend: "console",
      });
      const c = window.__s.make("sc", {
        profile: "minimal",
        addons: [],
        runStarter: false,
        frontend: "console",
      });
      window.__a = a;
      window.__b = b;
      window.__c = c;
      await Promise.all([a.start(), a.start(), b.start(), b.start()]);
      const runningA = a.engine.run("import time\ntime.sleep(3)");
      const runningB = b.engine.run("import time\ntime.sleep(3)");
      await new Promise((r) => setTimeout(r, 300));
      const third = await c.start().then(
        () => "started",
        (e) => e.code,
      );
      await Promise.all([runningA, runningB]);
      const created = window.__s.created();
      const starterA = await window.__s.py(a, "print(STARTED)");
      const starterB = await window.__s.py(b, "print('STARTED' in globals())");
      const xrA = await window.__s.py(a, "import sys; print('xarray' in sys.modules)");
      const xrB = await window.__s.py(b, "import sys; print('xarray' in sys.modules)");
      return {
        third,
        created,
        states: [a.state, b.state, c.state],
        starterA: starterA.out,
        starterB: starterB.out,
        xrA: xrA.out,
        xrB: xrB.out,
        held: await window.__s.slots.held(),
      };
    });
    check(
      "concurrent starts create one engine per session",
      two.created === 2,
      JSON.stringify(two),
    );
    check(
      "a third live interpreter is refused with no-slot, and creates nothing",
      two.third === "no-slot" && two.states[2] === "configured",
      JSON.stringify(two),
    );
    check(
      "each session has its own setup: the starter ran only where chosen",
      two.starterA === "yes" && two.starterB === "False",
      JSON.stringify(two),
    );
    check(
      "…and the profile is per session: xarray preloaded only in the xarray-zarr one",
      two.xrA === "False" && two.xrB === "True",
      JSON.stringify(two),
    );
    check("two slots are held, through Web Locks", two.held === 2, two.held);

    // Telemetry: WASM growth is visible; a tight loop makes the sample stale, not a hang.
    const telemetry = await page.evaluate(async () => {
      const a = window.__a;
      const before = await a.resources();
      await a.engine.run("big = bytearray(96 * 1024 * 1024)");
      await new Promise((r) => setTimeout(r, 1100));
      const after = await a.resources();
      void a.engine.run("import time\nend = time.time() + 4\nwhile time.time() < end: pass");
      await new Promise((r) => setTimeout(r, 1200));
      const t0 = performance.now();
      const stale = await a.resources();
      const took = performance.now() - t0;
      await a.engine.interrupt();
      await new Promise((r) => setTimeout(r, 4000));
      return { before, after, stale, took, line: window.__s.session.describeResources(after) };
    });
    check(
      "WASM capacity grows with a large allocation, and is reported as capacity",
      telemetry.after.wasmCapacityBytes >= telemetry.before.wasmCapacityBytes + 64 * 1024 * 1024 &&
        /WASM/.test(telemetry.line),
      JSON.stringify({
        before: telemetry.before.wasmCapacityBytes,
        after: telemetry.after.wasmCapacityBytes,
        line: telemetry.line,
      }),
    );
    check(
      "a busy worker gives a stale sample with the last values, in bounded time",
      telemetry.stale.sampleStale === true &&
        telemetry.stale.wasmCapacityBytes === telemetry.after.wasmCapacityBytes &&
        telemetry.took < 2500,
      JSON.stringify({ stale: telemetry.stale, took: telemetry.took }),
    );
    check(
      "the sample counts the page's live slots",
      telemetry.after.live === 2 && telemetry.after.capacity === 2,
      JSON.stringify(telemetry.after),
    );

    // Sleep needs writable streams in the origin private file system. Where a browser has none,
    // the one honest outcome is a refusal, checked at the end; the restore checks need a store.
    const canKeep = await page.evaluate(
      async () => (await window.__s.session.openCheckpointStore()) !== null,
    );
    if (canKeep) {
      // Sleep: refused while busy; otherwise files survive byte for byte and variables do not.
      const sleep = await page.evaluate(async () => {
        const a = window.__a;
        const running = a.engine.run("import time\ntime.sleep(1.5)");
        await new Promise((r) => setTimeout(r, 200));
        const busy = await a.sleep().then(
          () => "slept",
          (e) => e.code,
        );
        await running;
        await a.engine.run(
          "import os, hashlib\n" +
            "os.makedirs('/workspace/out/deep', exist_ok=True)\n" +
            "payload = os.urandom(20 * 1024 * 1024)\n" +
            "open('/workspace/out/deep/data.bin', 'wb').write(payload)\n" +
            "open('/workspace/notes.txt', 'w').write('héllo\\n')\n" +
            "open('/workspace/empty', 'wb').close()\n" +
            "def digests():\n" +
            "    out = {}\n" +
            "    for root, _, names in os.walk('/workspace'):\n" +
            "        for n in names:\n" +
            "            p = os.path.join(root, n)\n" +
            "            out[p] = hashlib.sha256(open(p, 'rb').read()).hexdigest()\n" +
            "    return out\n" +
            "MARK = 1\n",
        );
        const before = (
          await window.__s.py(a, "import json\nprint(json.dumps(digests(), sort_keys=True))")
        ).out;
        const generation = a.snapshot().generation;
        const t0 = performance.now();
        await a.sleep();
        const sleepMs = performance.now() - t0;
        const asleep = a.snapshot();
        const held = await window.__s.slots.held();
        const t1 = performance.now();
        await a.wake();
        const wakeMs = performance.now() - t1;
        const after = (
          await window.__s.py(
            a,
            "import os, hashlib, json\n" +
              "out = {}\n" +
              "for root, _, names in os.walk('/workspace'):\n" +
              "    for n in names:\n" +
              "        p = os.path.join(root, n)\n" +
              "        out[p] = hashlib.sha256(open(p, 'rb').read()).hexdigest()\n" +
              "print(json.dumps(out, sort_keys=True))",
          )
        ).out;
        const lost = await window.__s.py(a, "print(MARK)");
        const starter = await window.__s.py(a, "print(STARTED)");
        return {
          busy,
          before,
          after,
          asleep,
          held,
          generation,
          now: a.snapshot(),
          lost: lost.error ?? "no error",
          starter: starter.out,
          sleepMs,
          wakeMs,
        };
      });
      check("sleep is refused while Python runs", sleep.busy === "busy", sleep.busy);
      check(
        "asleep: the slot is released and the checkpoint is counted",
        sleep.asleep.state === "asleep" && sleep.held === 1 && sleep.asleep.checkpoint?.files === 3,
        JSON.stringify(sleep.asleep),
      );
      check(
        "after waking, every workspace file is byte-identical",
        typeof sleep.before === "string" &&
          sleep.before.length > 10 &&
          sleep.before === sleep.after,
        `${String(sleep.before).slice(0, 200)} | ${String(sleep.after).slice(0, 200)}`,
      );
      check(
        "…Python's variables were lost, and the starter ran again",
        /NameError/.test(sleep.lost) && sleep.starter === "yes",
        JSON.stringify(sleep),
      );
      check(
        "…in a new generation",
        sleep.now.generation === sleep.generation + 1 && sleep.now.state === "ready",
        JSON.stringify(sleep.now),
      );
      check(
        `sleep and wake with 20 MiB of files are measured (${Math.round(sleep.sleepMs)} ms / ${Math.round(sleep.wakeMs)} ms)`,
        sleep.sleepMs > 0 && sleep.wakeMs > 0,
      );

      // A damaged checkpoint: quarantined, the slot released, nothing restored.
      const damaged = await page.evaluate(async () => {
        const a = window.__a;
        await a.engine.run("open('/workspace/x.bin', 'wb').write(b'abc' * 1000)");
        await a.sleep();
        const root = await navigator.storage.getDirectory();
        const dir = await (
          await root.getDirectoryHandle("browser-python-checkpoints")
        ).getDirectoryHandle("sa");
        const manifest = JSON.parse(
          await (await (await dir.getFileHandle("manifest.json")).getFile()).text(),
        );
        const entry = manifest.files.find((f) => f.name === "x.bin");
        const handle = await dir.getFileHandle(entry.data);
        const writable = await handle.createWritable({ keepExistingData: true });
        await writable.write({ type: "write", position: 5, data: new Uint8Array([0x7a]) });
        await writable.close();
        const error = await a.wake().then(
          () => "woke",
          (e) => e.message,
        );
        const store = await window.__s.session.openCheckpointStore();
        const listed = await store.list();
        return { error, state: a.snapshot(), held: await window.__s.slots.held(), listed };
      });
      check(
        "a damaged checkpoint does not wake, and says why",
        /does not match its digest/.test(damaged.error) && damaged.state.state === "wake-error",
        JSON.stringify(damaged),
      );
      check(
        "…it is quarantined, and the slot is released",
        damaged.listed.quarantined.some((q) => q.id === "sa") && damaged.held === 1,
        JSON.stringify(damaged),
      );
    }

    // Where files cannot be kept, sleep is refused and the session stays awake.
    const nostore = await page.evaluate(async () => {
      await window.__b.close();
      const c = window.__s.make(
        "sd",
        { profile: "minimal", addons: [], runStarter: false, frontend: "console" },
        { noStore: true },
      );
      await c.start();
      const refused = await c.sleep().then(
        () => "slept",
        (e) => `${e.code}: ${e.message}`,
      );
      const state = c.state;
      await c.close();
      await window.__a.close();
      return { refused, state, held: await window.__s.slots.held() };
    });
    check(
      "without a checkpoint store, sleep is refused and offers downloading instead",
      /^unsupported: .*Download/.test(nostore.refused) && nostore.state === "ready",
      JSON.stringify(nostore),
    );
    check("closing every session releases every slot", nostore.held === 0, nostore.held);
  } finally {
    await server.close();
  }
  return checks;
});

process.exit(report("sessions: setups, slots, telemetry and sleep", result));
