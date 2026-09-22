// The recommended Waterpark topology, built and measured: two origins, and a bounded bridge.
//
// WHY TWO ORIGINS. A Worker removes DOM access; it does not remove ORIGIN AUTHORITY. Visitor
// Python and any package it installs run with the full authority of the interpreter's origin -
// its cookies where CORS allows, its IndexedDB, Cache Storage and OPFS, Workers on it.
// `embedding-waterpark.mjs` is a same-origin FUNCTIONALITY test; this suite is the topology.
//
// Measured rather than assumed: a cross-origin sub-frame cannot open the file picker, which is
// why the parent owns it; a child-frame click does leave the PARENT with user activation in this
// Chromium, though the design does not rely on it; a `WritableStream` is transferable here while
// `FileSystemWritableFileStream` transfer is unproven, which is why the bridge moves BYTES and
// not sinks; the origin, source, version and session checks, each defeated deliberately; and a
// 96 MiB transfer with an identical digest and live memory bounded to about one chunk.
//
// Not covered: `showSaveFilePicker()` opens a native dialog no automation can answer, so a sink
// is injected through the same parameter the default picker goes through, and the picker's
// presence in the parent and refusal in the child are asserted separately.
import {
  ENGINE,
  capabilityAbsent,
  inFullBrowser,
  probeWorkerCapabilities,
  report,
  requireDist,
  serve,
} from "./harness.mjs";
import { contentSecurityPolicy } from "../dist/csp.js";
import { EMBED_CHANNEL, EMBED_PROTOCOL_VERSION } from "../dist/embed/protocol.js";
import { cleanupChecks, createPhases, phaseFailureCheck, withDeadline } from "./deadline.mjs";

requireDist();

const CHUNK = 4 * 1024 * 1024;

// CROSS-ORIGIN ISOLATION, for the measurement and nothing else:
// `performance.measureUserAgentSpecificMemory()` refuses a page that is not cross-origin
// isolated, and it is the only honest way to see ArrayBuffer memory in a browser. A real
// deployment needs none of this; it changes what can be MEASURED, not what is being tested.
const ISOLATE_PARENT = {
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-embedder-policy": "require-corp",
};
const ISOLATE_CHILD = {
  "cross-origin-embedder-policy": "require-corp",
  "cross-origin-resource-policy": "cross-origin",
};
/**
 * How much crosses the bridge. 96 MiB where the browser can MEASURE memory, because only a
 * transfer that large shows whether memory grows with the file. Where it cannot, 96 MiB would add
 * nothing but minutes, so a smaller transfer that is still many chunks checks the same
 * correctness: digest, chunking, one write in flight, interruption and renewal.
 */
const MEMORY_TEST_MIB = 96;
const PORTABLE_MIB = 16;

/**
 * The playground document: an engine, and the child half of the bridge. The script is EXTERNAL
 * because `script-src 'self'` is the policy under test, and an inline module would need
 * `'unsafe-inline'` or a per-response hash - a weaker policy than the one being published.
 */
const PLAYGROUND = `<!doctype html><html><head><meta charset="utf-8">
<title>playground</title><script src="/watcher.js"></script></head><body>
<script type="module" src="/playground.js"></script></body></html>`;

const PLAYGROUND_JS = (hostOrigin) => `
  import { createBrowserPython } from "/dist/index.js";
  import { attachPlaygroundBridge } from "/dist/embed/index.js";

  const python = createBrowserPython({
    profile: "minimal",
    pyodide: { indexURL: new URL("/runtime/", location.href).href },
    workspaceMaxFiles: 4,
  });
  // ATTACHED AT LOAD, exactly as a deployment does it, and the reason the reload test works at
  // all: a fixture that attaches the bridge from the test has no bridge after a navigation.
  //
  // The four bounded operations exist because a parent cannot do any of them across an origin:
  // read this transcript, clear it, clear the prompt's history, or start a new interpreter. Each
  // arrives as a NAME with no arguments, decided here with a plain string and three counters.
  const console_ = {
    text: "",
    cleared: 0,
    historyCleared: 0,
    restarts: 0,
  };
  window.__console = console_;

  const bridge = attachPlaygroundBridge({
    engine: python,
    hostOrigin: ${JSON.stringify(hostOrigin)},
    transcript: () => console_.text,
    onClearTranscript: () => { console_.cleared += 1; console_.text = ""; },
    onClearHistory: () => { console_.historyCleared += 1; },
    onRestart: async () => {
      console_.restarts += 1;
      // A restart keeps the DOCUMENT and therefore the session; only the interpreter is new.
      await python.restart();
      console_.text = "restarted\\n";
    },
  });

  /** Python's stdout, so the child can report a value the portal must agree with. */
  window.__pgOut = [];
  python.onOutput((event) => {
    if (event.type === "stdout") window.__pgOut.push(event.text);
  });

  window.__pg = {
    engine: python,
    bridge,
    sessionId: bridge.sessionId,
    start: () => python.start(),
    run: async (code) => {
      const before = window.__pgOut.length;
      const result = await python.run(code);
      return { error: result.error ?? null, stdout: window.__pgOut.slice(before).join("") };
    },
    violations: () => window.__violations,
    /** Put something in the transcript, as running code would. */
    say: (text) => { console_.text += text; return console_.text.length; },
    consoleState: () => ({ ...console_ }),
    /** The challenge the parent last hailed with, so a forgery can be built that is otherwise valid. */
    lastChallenge: null,
    /** Deliberately malformed traffic, to prove the parent's checks are doing work. */
    forge: (message, targetOrigin) =>
      parent.postMessage(message, targetOrigin ?? ${JSON.stringify(hostOrigin)}),
  };
  addEventListener("message", (event) => {
    const data = event.data;
    if (data && data.channel === "freva-python-embed" && data.kind === "hail") {
      window.__pg.lastChallenge = data.challenge;
    }
  });
  // THE TEST'S OWN LINE INTO THIS DOCUMENT, independent of the automation driver. After a real
  // reload Playwright's Firefox driver never gets an evaluation into this cross-origin sandboxed
  // frame again, while the document itself is alive and has already renewed the bridge. So the
  // fixture reads and drives the child the way the portal can: by postMessage, on a channel of
  // its own (the bridge ignores it), accepted only from the parent window at the host origin.
  // Registered at module top level, so it is listening before the bridge's handshake completes.
  const FIXTURE_OPS = {
    sessionId: () => window.__pg.sessionId,
    say: (text) => window.__pg.say(text),
    consoleState: () => window.__pg.consoleState(),
    violations: () => window.__pg.violations(),
    // Started synchronously, exactly as \`frame.evaluate(() => location.reload())\` did: the
    // navigation is under way before the answer is posted.
    reload: () => { location.reload(); return true; },
  };
  addEventListener("message", (event) => {
    const data = event.data;
    if (event.source !== parent || event.origin !== ${JSON.stringify(hostOrigin)}) return;
    if (!data || data.channel !== "fixture-control" || !(data.op in FIXTURE_OPS)) return;
    const value = FIXTURE_OPS[data.op](data.arg);
    parent.postMessage(
      { channel: "fixture-control", id: data.id, value },
      ${JSON.stringify(hostOrigin)},
    );
  });
  window.__ready = true;
`;

const WATCHER = `
  window.__violations = [];
  document.addEventListener("securitypolicyviolation", (e) => {
    window.__violations.push({ directive: e.effectiveDirective, blocked: String(e.blockedURI).slice(0, 60) });
  });
`;

/** The portal page: the host half of the bridge, the Download control, and the sink. */
const PORTAL = (playgroundUrl) => `<!doctype html><html><head><meta charset="utf-8">
<title>portal</title></head><body>
<h1>portal shell</h1>
<button id="download" disabled>Download</button>
<iframe id="pg" src="${playgroundUrl}" width="800" height="300"
        sandbox="allow-scripts allow-same-origin"></iframe>
<script type="module" src="/portal.js"></script>
</body></html>`;

const PORTAL_JS = (playgroundOrigin) => `
  import { createPlaygroundHost } from "/dist/embed/index.js";

  const frame = document.getElementById("pg");
  const button = document.getElementById("download");

  // A REAL, INCREMENTAL SHA-256, written out because the platform has no streaming hash:
  // \`crypto.subtle.digest\` takes the whole message at once, which is what this transfer exists
  // not to do. Folding chunks into a rolling value is a checksum of a checksum and would miss a
  // chunk delivered in the wrong ORDER; this is comparable with Python's \`hashlib.sha256()\`.
  function sha256Stream() {
    const K = new Uint32Array([
      0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
      0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
      0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
      0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
      0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
      0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
      0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
      0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
    ]);
    let h = new Uint32Array([
      0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19,
    ]);
    const w = new Uint32Array(64);
    let buffer = new Uint8Array(64);
    let buffered = 0;
    let total = 0;
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));

    const block = (bytes, at) => {
      for (let i = 0; i < 16; i += 1) {
        w[i] =
          (bytes[at + i * 4] << 24) | (bytes[at + i * 4 + 1] << 16) |
          (bytes[at + i * 4 + 2] << 8) | bytes[at + i * 4 + 3];
      }
      for (let i = 16; i < 64; i += 1) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      let [a, b, c, d, e, f, g, hh] = h;
      for (let i = 0; i < 64; i += 1) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) | 0;
        hh = g; g = f; f = e; e = (d + t1) | 0;
        d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h = new Uint32Array([
        (h[0] + a) | 0, (h[1] + b) | 0, (h[2] + c) | 0, (h[3] + d) | 0,
        (h[4] + e) | 0, (h[5] + f) | 0, (h[6] + g) | 0, (h[7] + hh) | 0,
      ]);
    };

    return {
      update(bytes) {
        total += bytes.length;
        let at = 0;
        if (buffered > 0) {
          const need = Math.min(64 - buffered, bytes.length);
          buffer.set(bytes.subarray(0, need), buffered);
          buffered += need;
          at = need;
          if (buffered === 64) { block(buffer, 0); buffered = 0; }
        }
        for (; at + 64 <= bytes.length; at += 64) block(bytes, at);
        if (at < bytes.length) {
          buffered = bytes.length - at;
          buffer.set(bytes.subarray(at), 0);
        }
      },
      hex() {
        const bits = total * 8;
        const tail = new Uint8Array(buffered + 72);
        tail.set(buffer.subarray(0, buffered), 0);
        tail[buffered] = 0x80;
        const padded = buffered + 1 <= 56 ? 64 : 128;
        const view = new DataView(tail.buffer);
        view.setUint32(padded - 4, bits >>> 0);
        view.setUint32(padded - 8, Math.floor(bits / 0x100000000) >>> 0);
        const snapshot = h;
        for (let at = 0; at < padded; at += 64) block(tail, at);
        const hex = [...h].map((x) => (x >>> 0).toString(16).padStart(8, "0")).join("");
        h = snapshot; // non-destructive, so hex() can be called more than once
        return hex;
      },
    };
  }

  const state = {
    artifacts: [], ready: null, written: 0, digest: null,
    /** Bytes alive in this page RIGHT NOW, tracked additively. */
    live: 0, peakLive: 0,
    /** Concurrent sink.write() calls - assigning live = chunk.byteLength cannot see two at once. */
    writing: 0, maxWriting: 0,
    retain: false, keptChunks: null, retained: 0,
    pauseAt: 0, paused: false, resume: null,
    done: false, result: null, error: null, clickActivation: null,
    /** Every transcript the playground has pushed, in order. */
    transcripts: [],
    /** Why each previous session ended, in order. */
    invalidations: [],
  };

  const host = createPlaygroundHost({
    frame,
    playgroundOrigin: ${JSON.stringify(playgroundOrigin)},
    onReady: (id) => { state.ready = id; },
    // A document the session belonged to is gone: what the fixture exposes must stop claiming a
    // session the host itself has already dropped, or a test waits on a stale id.
    onInvalidated: (why) => { state.ready = null; state.invalidations.push(why); },
    onArtifacts: (artifacts) => {
      state.artifacts = artifacts;
      button.disabled = artifacts.length === 0;
    },
    onTranscript: (transcript) => {
      state.transcripts.push(transcript);
    },
  });

  /** A sink that hashes rather than saves, and reports exactly how much is alive at once. */
  const hashingSink = () => {
    const hash = sha256Stream();
    state.hash = hash;
    return {
      async write(chunk) {
        state.writing += 1;
        state.maxWriting = Math.max(state.maxWriting, state.writing);
        state.live += chunk.byteLength;
        state.peakLive = Math.max(state.peakLive, state.live);
        if (state.pauseAt > 0 && state.written + chunk.byteLength >= state.pauseAt && !state.paused) {
          // HELD OPEN, halfway through, so memory can be measured while the transfer is really in
          // progress rather than after it has finished and everything has been collected.
          state.paused = true;
          await new Promise((resolve) => { state.resume = resolve; });
        }
        hash.update(chunk);
        state.written += chunk.byteLength;
        state.live -= chunk.byteLength;
        state.writing -= 1;
      },
      async close() {}, async abort() {},
    };
  };

  /** The control: a sink that KEEPS every chunk, so the measurement is shown to be able to fail. */
  const retainingSink = () => {
    state.keptChunks = [];
    return {
      async write(chunk) {
        state.keptChunks.push(chunk.slice());
        state.retained = state.keptChunks.length;
        state.written += chunk.byteLength;
      },
      async close() {}, async abort() {},
    };
  };

  button.addEventListener("click", async () => {
    const sink = state.retain ? retainingSink() : hashingSink();
    state.clickActivation = navigator.userActivation
      ? { isActive: navigator.userActivation.isActive } : null;
    try {
      state.result = await host.download(button.dataset.name, () => sink);
    } catch (error) {
      state.error = String(error && error.message ? error.message : error);
    }
    state.digest = state.retain ? null : state.hash.hex();
    state.done = true;
  });

  /** The fixture's line into the playground document (see FIXTURE_OPS there), bounded. */
  const fixturePending = new Map();
  let fixtureNext = 0;
  addEventListener("message", (event) => {
    if (event.origin !== ${JSON.stringify(playgroundOrigin)}) return;
    if (event.source !== frame.contentWindow) return;
    const data = event.data;
    if (!data || data.channel !== "fixture-control") return;
    const settle = fixturePending.get(data.id);
    if (settle) { fixturePending.delete(data.id); settle(data.value); }
  });
  const child = (op, arg) => new Promise((resolve, reject) => {
    fixtureNext += 1;
    const id = fixtureNext;
    const timer = setTimeout(() => {
      fixturePending.delete(id);
      reject(new Error("the playground did not answer fixture operation " + op + " within 10 s"));
    }, 10000);
    fixturePending.set(id, (value) => { clearTimeout(timer); resolve(value); });
    frame.contentWindow.postMessage(
      { channel: "fixture-control", id, op, arg }, ${JSON.stringify(playgroundOrigin)},
    );
  });

  window.__portal = {
    host,
    child,
    state,
    /** The session the HOST holds now - which the exposed ready state must agree with. */
    hostSession: () => host.sessionId,
    hasPicker: typeof window.showSaveFilePicker === "function",
    activation: () => navigator.userActivation
      ? { isActive: navigator.userActivation.isActive, hasBeenActive: navigator.userActivation.hasBeenActive }
      : null,
    transferableWritableStream: () => {
      try {
        const ch = new MessageChannel();
        const ws = new WritableStream();
        ch.port1.postMessage({ ws }, [ws]);
        return "transferable";
      } catch (e) { return String(e.name); }
    },
    resume: () => { const r = state.resume; state.resume = null; if (r) r(); return Boolean(r); },
    /** One bounded operation, resolved or refused, with the child's own reason either way. */
    perform: async (op) => {
      try {
        await host.perform(op);
        return { ok: true, message: null };
      } catch (error) {
        return { ok: false, message: String(error && error.message ? error.message : error) };
      }
    },
    /** What the host currently holds, which is what a portal's Copy control would copy. */
    transcript: () => host.transcript,
    arm: (name, opts = {}) => {
      button.dataset.name = name;
      state.written = 0; state.live = 0; state.peakLive = 0;
      state.writing = 0; state.maxWriting = 0;
      state.done = false; state.result = null; state.error = null; state.digest = null;
      state.retain = Boolean(opts.retain); state.retained = 0;
      if (!state.retain) state.keptChunks = null;
      state.pauseAt = opts.pauseAt || 0; state.paused = false; state.resume = null;
    },
  };
  window.__portalReady = true;
`;

// The memory assertions require full Chromium. Enabling the internal Blink feature in
// chrome-headless-shell crashes the target on CI before the transfer starts.
let measureUnavailable = null;
const result = await inFullBrowser(async (page) => {
  const checks = [];
  const notApplicable = [];
  const ok = (name, pass, detail) => checks.push({ name, pass, detail: String(detail ?? "") });

  // NAMED PHASES WITH REAL DEADLINES. `page.evaluate()` has no timeout of its own, so a wedge used
  // to be silent until the runner killed the process at 15 minutes. Every step below runs through
  // `phases.run(name, ms, work)`, which logs start, finish and elapsed time and REJECTS at its
  // deadline whatever the browser does next. Only then is the browser context closed, to
  // terminate what the phase abandoned; that is bounded and reported on its own, so a close that
  // never returns cannot keep this suite waiting.
  const phases = createPhases("embedding-two-origin", {
    onDeadline: () => page.context().close(),
  });
  const run = (name, ms, work) => phases.run(name, ms, work);
  const finish = async () => {
    checks.push(...(await cleanupChecks(phases)));
    return { checks, notApplicable };
  };

  // THE MEMORY MEASUREMENT IS CHROMIUM'S, and it is asked for rather than assumed: an isolated
  // page is loaded and asked whether `measureUserAgentSpecificMemory()` exists. Without it the
  // isolation headers - which exist only for the measurement - are left off, and the transfer's
  // correctness is still checked in full.
  const probe = await serve("<!doctype html><title>probe</title>", {
    headers: ISOLATE_PARENT,
    assetHeaders: ISOLATE_PARENT,
  });
  let canMeasure = false;
  try {
    canMeasure = await run("capability probe", 60_000, async () => {
      await page.goto(probe.url);
      return await page.evaluate(
        () =>
          self.crossOriginIsolated === true &&
          typeof performance.measureUserAgentSpecificMemory === "function",
      );
    });
  } catch (error) {
    checks.push(phaseFailureCheck(error));
    return await finish();
  } finally {
    await withDeadline(probe.close(), 10_000, "closing the probe server").catch(() => {});
  }
  const transferMiB = canMeasure ? MEMORY_TEST_MIB : PORTABLE_MIB;
  const transferBytes = transferMiB * 1024 * 1024;
  console.log(
    `[embedding-two-origin] transfer size: ${transferMiB} MiB ` +
      `(${canMeasure ? "memory measured" : "no memory measurement in this engine"})`,
  );
  const isolateParent = canMeasure ? ISOLATE_PARENT : {};
  const isolateChild = canMeasure ? ISOLATE_CHILD : {};
  if (!canMeasure) {
    capabilityAbsent(
      checks,
      notApplicable,
      "memory-measurement",
      `the portal's memory growth during a ${MEMORY_TEST_MIB} MiB transfer, and its negative control`,
      `performance.measureUserAgentSpecificMemory() is not provided by ${ENGINE}`,
    );
  }

  // TWO SERVERS, so the two documents really are on different origins, each carrying the header
  // the other needs. `frame-ancestors` on the playground names the PORTAL's exact origin rather
  // than `'self'`, which on a dedicated origin would mean "any page on the playground origin".
  //
  // A CHICKEN AND EGG, hence the mutable `wiring`: each policy names the other document's origin,
  // and an origin is unknown until its server listens - and re-serving gets a new port. Both
  // servers start with handlers that read `wiring`, which is completed once both ports exist.
  const wiring = {};
  const playground = await serve("", {
    handle: (req, res, url) => {
      if (url.pathname === "/playground.js") {
        res.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
          "content-security-policy": wiring.playgroundPolicy,
          ...isolateChild,
        });
        res.end(PLAYGROUND_JS(wiring.portalOrigin));
        return true;
      }
      if (url.pathname === "/watcher.js") {
        res.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
          "content-security-policy": wiring.playgroundPolicy,
          ...isolateChild,
        });
        res.end(WATCHER);
        return true;
      }
      // A NAMED path, not "/": the harness answers "/" itself with the html argument, which
      // cannot be built yet because it names the other server's origin. See `wiring`.
      if (url.pathname !== "/playground.html") return false;
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": wiring.playgroundPolicy,
        ...isolateChild,
      });
      res.end(PLAYGROUND);
      return true;
    },
    assetHeaders: isolateChild,
  });
  const portal = await serve("", {
    handle: (req, res, url) => {
      if (url.pathname === "/portal.js") {
        res.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
          "content-security-policy": wiring.portalPolicy,
          ...isolateParent,
        });
        res.end(PORTAL_JS(wiring.playgroundOrigin));
        return true;
      }
      if (url.pathname !== "/portal.html") return false;
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": wiring.portalPolicy,
        ...isolateParent,
      });
      res.end(PORTAL(wiring.playgroundUrl));
      return true;
    },
    assetHeaders: isolateParent,
  });

  const playgroundOrigin = playground.url.replace(/\/$/, "");
  const portalOrigin = portal.url.replace(/\/$/, "");
  const playgroundPolicy = contentSecurityPolicy({ frameAncestors: [portalOrigin] });
  const portalPolicy = contentSecurityPolicy({ frameSrc: [playgroundOrigin] });
  Object.assign(wiring, {
    playgroundOrigin,
    portalOrigin,
    playgroundUrl: `${playground.url}playground.html`,
    playgroundPolicy,
    portalPolicy,
  });

  try {
    ok(
      "the playground's frame-ancestors names the PORTAL's exact origin, not 'self'",
      playgroundPolicy.includes(`frame-ancestors ${portalOrigin}`) &&
        !playgroundPolicy.includes("frame-ancestors 'self'"),
      playgroundPolicy,
    );
    ok(
      "the portal's frame-src names the PLAYGROUND's exact origin, and widens nothing else",
      portalPolicy.includes(`frame-src ${playgroundOrigin}`) && !portalPolicy.includes("*"),
      portalPolicy,
    );
    ok(
      "the two documents really are on different origins",
      playgroundOrigin !== portalOrigin,
      `${portalOrigin} vs ${playgroundOrigin}`,
    );

    const frame = await run("portal and iframe navigation", 90_000, async () => {
      await page.goto(`${portal.url}portal.html`, { waitUntil: "load" });
      await page.waitForFunction(() => window.__portalReady === true, null, { timeout: 20_000 });
      const found = page.frames().find((f) => f.url().startsWith(playgroundOrigin));
      ok(
        "the playground loads inside the portal, cross-origin",
        Boolean(found),
        page
          .frames()
          .map((f) => f.url())
          .join(" | "),
      );
      if (found) {
        await found.waitForFunction(() => window.__ready === true, null, { timeout: 60_000 });
      }
      return found;
    });
    // Return the checks made so far rather than throwing: a suite that gives up must still report
    // what it established, and `inBrowser` replaces a thrown body's checks with an empty array.
    if (!frame) return await finish();

    /**
     * THE SESSION, PROVEN CURRENT before the bridge is used again. After the frame's document is
     * replaced the host drops the old session (`onInvalidated` clears what the fixture exposes)
     * and a new one exists only once the NEW document has answered a hail. Using the bridge before
     * that is a race with the handshake, not a test of it: wait for a non-null session that
     * differs from `previous`, and require the host and the fixture to agree on it.
     */
    const renewedSession = async (previous) => {
      await page.waitForFunction(
        (old) => {
          const ready = window.__portal.state.ready;
          return ready !== null && ready !== old && window.__portal.hostSession() === ready;
        },
        previous,
        { timeout: 60_000 },
      );
      return await page.evaluate(() => ({
        ready: window.__portal.state.ready,
        host: window.__portal.hostSession(),
        invalidations: [...window.__portal.state.invalidations],
      }));
    };

    /**
     * THE RENEWED PLAYGROUND DOCUMENT, REACHED through the fixture's postMessage line and proven
     * to be the new one by the session id it reports from inside itself. The Playwright `Frame`
     * is NOT used for the child after a reload: Firefox's driver never answers an evaluation in
     * this reloaded cross-origin sandboxed frame (a re-resolved frame timed out as well), while
     * the document is alive and has renewed the bridge. What the automation driver can reach is
     * logged, bounded, as a diagnostic - never counted as a check either way.
     */
    const reachRenewedPlayground = async (session) => {
      const childSession = await page.evaluate(() => window.__portal.child("sessionId"));
      const driver = await withDeadline(
        frame.evaluate(() => true),
        5_000,
        "driver evaluation",
      )
        .then(() => "answers")
        .catch((error) => String(error?.message ?? error).split("\n")[0]);
      console.log(
        `[embedding-two-origin] diagnostic: Playwright evaluation in the renewed frame: ${driver}`,
      );
      return { childSession, expected: session };
    };

    await run("platform facts", 30_000, async () => {
      // THE NATIVE PICKER is separate from the bridge. Where the engine provides
      // `showSaveFilePicker()`, the parent must be able to open it and the cross-origin child
      // must not. Where it does not, neither document has it and the portal's own sink is the
      // only route - the one every download below takes anyway.
      const portalHasPicker = await page.evaluate(() => window.__portal.hasPicker);
      if (portalHasPicker) {
        const pickerInChild = await frame.evaluate(async () => {
          try {
            await window.showSaveFilePicker({ suggestedName: "x.bin" });
            return "opened";
          } catch (e) {
            return `${e.name}: ${String(e.message).slice(0, 60)}`;
          }
        });
        ok(
          "a cross-origin sub-frame CANNOT open the file picker, which is why the parent owns it",
          /SecurityError/.test(pickerInChild),
          pickerInChild,
        );
        ok(
          "…while the portal page can: the API is present where the gesture is",
          portalHasPicker === true,
          "showSaveFilePicker in the portal",
        );
      } else {
        const childPicker = await frame.evaluate(() => typeof window.showSaveFilePicker);
        ok(
          "without a native save picker, the sub-frame has none either: the portal's sink is the route",
          childPicker === "undefined",
          `typeof showSaveFilePicker in the child: ${childPicker}`,
        );
        capabilityAbsent(
          checks,
          notApplicable,
          "save-file-picker",
          "native showSaveFilePicker (present in the portal, refused in the sub-frame)",
          `window.showSaveFilePicker is not provided by ${ENGINE}`,
        );
      }
      // A platform fact the design deliberately does NOT depend on, recorded where it holds.
      const transferable = await page.evaluate(() => window.__portal.transferableWritableStream());
      if (transferable === "transferable") {
        ok(
          "a WritableStream is transferable here - so the bridge moving BYTES is a choice, not a limit",
          true,
          "FileSystemWritableFileStream transfer remains unproven; the design does not depend on it",
        );
      } else {
        capabilityAbsent(
          checks,
          notApplicable,
          "transferable-streams",
          "transferable WritableStream (recorded only; the bridge moves bytes regardless)",
          `${ENGINE} refuses to transfer a WritableStream (${transferable})`,
        );
      }
    });

    // start, attach, hand shake. The deadline is the PHASE's: `evaluate()` takes no timeout option.
    await run("Python startup in the playground", 300_000, () =>
      frame.evaluate(() => window.__pg.start()),
    );
    const { hasWorkspace } = await run("bridge handshake", 60_000, async () => {
      const childSession = await frame.evaluate(() => window.__pg.sessionId);
      ok(
        "the playground bridge attaches and names a per-frame session",
        typeof childSession === "string" && childSession.length > 0,
        childSession,
      );
      await page.waitForFunction(() => window.__portal.state.ready !== null, null, {
        timeout: 30_000,
      });
      // Every download below needs the playground's disk-backed workspace. What the WORKER in
      // this engine reported decides; without it the artifact half - listing, the forgery checks
      // made on it, every parent-mediated download and the reload DURING a transfer - is not
      // applicable, and the bounded operations and the later iframe reload still run. An
      // independent probe worker in the same frame says whether the browser would have allowed
      // it: if it would, the package failed, and that fails.
      const playgroundWorkspace = await frame.evaluate(() => window.__pg.engine.workspace);
      const available = playgroundWorkspace?.available === true;
      if (!available) {
        const probed = await probeWorkerCapabilities(frame);
        ok(
          "the playground's missing workspace is the browser's answer, not the package's failure",
          probed.opfsUsable === false,
          JSON.stringify({ workspace: playgroundWorkspace, probe: probed }),
        );
        capabilityAbsent(
          checks,
          notApplicable,
          "sync-access-handles",
          "artifact listing, forgery checks on it, every parent-mediated download, and a reload " +
            "during a transfer",
          `this ${ENGINE} context's worker cannot back /workspace with OPFS ` +
            `(${playgroundWorkspace?.reason ?? "unknown"}${probed.opfsError ? `; ${probed.opfsError}` : ""})`,
        );
      }
      ok(
        "the handshake completes and the portal learns the playground's per-frame session id",
        typeof (await page.evaluate(() => window.__portal.state.ready)) === "string",
        await page.evaluate(() => window.__portal.state.ready),
      );
      return { hasWorkspace: available };
    });

    if (hasWorkspace) {
      const listed = await run("small artifact setup", 60_000, async () => {
        const wrote = await frame.evaluate(async () => {
          const r = await window.__pg.run(
            "with open('small.csv','w') as fh:\n    fh.write('a,b\\n1,2\\n')\n",
          );
          return {
            error: r.error ? String(r.error).split("\n").pop() : null,
            artifacts: (await window.__pg.engine.artifacts()).map((a) => a.name),
          };
        });
        ok(
          "the playground writes an artifact of its own",
          wrote.error === null && wrote.artifacts.includes("small.csv"),
          JSON.stringify(wrote),
        );
        const pushed = await page
          .waitForFunction(() => window.__portal.state.artifacts.length > 0, null, {
            timeout: 15_000,
          })
          .then(() => true)
          .catch(() => false);
        ok(
          "the playground PUSHES its new artifact list to the portal, unprompted",
          pushed,
          JSON.stringify(await page.evaluate(() => window.__portal.state)),
        );
        if (!pushed) {
          await page.evaluate(() => window.__portal.host.refresh());
          await page.waitForFunction(() => window.__portal.state.artifacts.length > 0, null, {
            timeout: 15_000,
          });
        }
        const artifacts = await page.evaluate(() => window.__portal.state.artifacts);
        ok(
          "artifact METADATA crosses the boundary - name, size, mime, state - and no bytes",
          artifacts.length === 1 &&
            artifacts[0].name === "small.csv" &&
            !Object.keys(artifacts[0]).some((k) => /byte|blob|content|token/i.test(k)),
          JSON.stringify(artifacts),
        );
        return artifacts;
      });

      // every check on the parent, defeated
      await run("forged-envelope checks", 30_000, async () => {
        const accepted = async (message, targetOrigin) => {
          await frame.evaluate(
            ([m, o]) => window.__pg.forge(m, o),
            [message, targetOrigin ?? null],
          );
          await page.waitForTimeout(120);
          return await page.evaluate(() => window.__portal.state.artifacts.map((a) => a.name));
        };
        const session = await page.evaluate(() => window.__portal.state.ready);
        // The parent's current challenge, read from the last hail the child received.
        const challenge = await frame.evaluate(() => window.__pg.lastChallenge ?? null);
        // The CURRENT protocol, imported rather than written down: a hard-coded version that had
        // fallen behind made every negative check below pass for the wrong reason.
        const good = {
          channel: EMBED_CHANNEL,
          version: EMBED_PROTOCOL_VERSION,
          sessionId: session,
          challenge,
        };
        // THE POSITIVE CONTROL: the otherwise-valid envelope IS accepted - the parent replaces its
        // list with the forged one. Only after this does "ignored" mean the one field changed.
        const control = { ...listed[0], name: "forged-control.csv" };
        const afterControl = await accepted({ ...good, kind: "artifacts", artifacts: [control] });
        ok(
          "a well-formed envelope from the child IS accepted (the control for the checks below)",
          JSON.stringify(afterControl) === JSON.stringify(["forged-control.csv"]),
          JSON.stringify({ afterControl, envelope: { ...good, challenge: Boolean(challenge) } }),
        );
        const ignoredWith = async (change) => {
          const list = await accepted({ ...good, ...change, kind: "artifacts", artifacts: [] });
          return JSON.stringify(list) === JSON.stringify(["forged-control.csv"]);
        };
        ok(
          "a message with the wrong protocol version is ignored",
          await ignoredWith({ version: EMBED_PROTOCOL_VERSION + 1 }),
          `version ${EMBED_PROTOCOL_VERSION + 1} where ${EMBED_PROTOCOL_VERSION} is current`,
        );
        ok(
          "…with the wrong session id is ignored, so a reloaded frame's traffic cannot be replayed",
          await ignoredWith({ sessionId: "not-this-frame" }),
          "foreign session",
        );
        ok(
          "…without the channel marker is ignored rather than parsed",
          await ignoredWith({ channel: "something-else" }),
          "foreign channel",
        );
        // Put the real list back before downloading from it.
        await page.evaluate(() => window.__portal.host.refresh());
        await page.waitForFunction(
          () => window.__portal.state.artifacts.some((a) => a.name === "small.csv"),
          null,
          { timeout: 15_000 },
        );
      });

      // the download, through the parent's sink
      await run("small parent-mediated download", 60_000, async () => {
        await page.evaluate(() => window.__portal.arm("small.csv"));
        await page.click("#download");
        await page.waitForFunction(() => window.__portal.state.done === true, null, {
          timeout: 60_000,
        });
        const small = await page.evaluate(() => ({
          written: window.__portal.state.written,
          result: window.__portal.state.result,
          error: window.__portal.state.error,
          activation: window.__portal.state.clickActivation,
        }));
        ok(
          "a parent-owned click drives a bounded pull of the child's artifact",
          small.error === null && small.written === 8 && small.result?.bytesWritten === 8,
          JSON.stringify(small),
        );
        // `navigator.userActivation` is how activation is OBSERVED; where the engine has no such
        // API there is nothing to observe, which is not the same as no activation.
        if (small.activation !== null) {
          ok(
            "…on the portal's own user activation",
            small.activation?.isActive === true,
            JSON.stringify(small.activation),
          );
          // the child's click, and the parent's activation
          const propagated = await page.evaluate(() => window.__portal.activation());
          ok(
            "user activation is observable in the parent after the click - recorded, not relied on",
            propagated !== null,
            JSON.stringify(propagated),
          );
        } else {
          capabilityAbsent(
            checks,
            notApplicable,
            "user-activation",
            "observing the portal's user activation",
            `navigator.userActivation is not provided by ${ENGINE}`,
          );
        }
      });

      // the large artifact, and the bound
      const built = await run(`large artifact creation (${transferMiB} MiB)`, 300_000, async () => {
        const made = await frame.evaluate(async (mib) => {
          // Joined from lines rather than embedded escapes: a `\\n` that survives one level of
          // quoting too many becomes a literal backslash-n and Python raises a SyntaxError.
          const source = [
            "import hashlib",
            "h = hashlib.sha256()",
            "block = bytes(range(256)) * 4096",
            "with open('big.bin','wb') as fh:",
            `    for _ in range(${mib} * 1024 * 1024 // len(block)):`,
            "        fh.write(block)",
            "        h.update(block)",
            "print(h.hexdigest())",
            "",
          ].join("\n");
          const r = await window.__pg.run(source);
          return {
            error: r.error ? String(r.error).split("\n").pop() : null,
            // Python's OWN digest of the bytes it wrote, so the comparison is between two
            // independent computations of one standard function rather than two copies of a trick.
            digest: (r.stdout ?? "").trim(),
            artifacts: (await window.__pg.engine.artifacts()).map((a) => `${a.name}:${a.size}`),
          };
        }, transferMiB);
        ok(
          `the playground writes a ${transferMiB} MiB artifact`,
          made.error === null && made.artifacts.some((a) => a.startsWith("big.bin:")),
          JSON.stringify(made),
        );
        ok(
          "…and Python reports its own SHA-256 of those bytes",
          /^[0-9a-f]{64}$/.test(made.digest ?? ""),
          made.digest,
        );
        return made;
      });

      const boundedDigest = await run(
        `complete artifact transfer (${transferMiB} MiB)`,
        300_000,
        async () => {
          await page.waitForFunction(
            () => window.__portal.state.artifacts.some((a) => a.name === "big.bin"),
            null,
            { timeout: 120_000 },
          );
          // MEASURED WHILE IT IS RUNNING, not after it has finished: once the transfer is over
          // every chunk has been released and the collector has had every chance to run. The sink
          // HOLDS at roughly half the file, the measurement is taken there with the transfer
          // genuinely in flight, and it is released.
          const halfway = transferBytes / 2;
          await page.evaluate((pauseAt) => window.__portal.arm("big.bin", { pauseAt }), halfway);
          const before = canMeasure ? await measure(page) : null;
          await page.click("#download");
          await page.waitForFunction(() => window.__portal.state.paused === true, null, {
            timeout: 300_000,
          });
          const during = canMeasure ? await measure(page) : null;
          const midway = await page.evaluate(() => ({
            written: window.__portal.state.written,
            live: window.__portal.state.live,
            maxWriting: window.__portal.state.maxWriting,
          }));
          ok(
            `the transfer really was in flight ${canMeasure ? "when memory was measured" : "at the midpoint"} (~half of ${transferMiB} MiB)`,
            midway.written >= halfway / 2 && midway.written < transferBytes,
            JSON.stringify(midway),
          );
          ok(
            "…with exactly one sink.write() running, tracked as a count rather than assumed",
            midway.maxWriting === 1,
            `most concurrent writes observed: ${midway.maxWriting}`,
          );
          const resumed = await page.evaluate(() => window.__portal.resume());
          ok(
            "…and it resumes when released",
            resumed === true,
            `resume() found a waiter: ${resumed}`,
          );
          await page.waitForFunction(() => window.__portal.state.done === true, null, {
            timeout: 300_000,
          });
          const big = await page.evaluate(() => ({
            written: window.__portal.state.written,
            peakLive: window.__portal.state.peakLive,
            maxWriting: window.__portal.state.maxWriting,
            error: window.__portal.state.error,
            result: window.__portal.state.result,
          }));
          ok(
            `a ${transferMiB} MiB artifact crosses the boundary in full`,
            big.error === null && big.written === transferBytes,
            JSON.stringify({ written: big.written, expected: transferBytes, error: big.error }),
          );
          ok(
            "…in chunks, never holding more than one at a time in the portal",
            big.peakLive > 0 && big.peakLive <= CHUNK && big.maxWriting === 1,
            `peak live bytes ${big.peakLive}, most concurrent writes ${big.maxWriting}`,
          );
          if (canMeasure) {
            ok(
              "…with the portal's memory growth bounded rather than proportional to the file",
              // NOT `true` when the measurement is unavailable: a check that cannot run is not a
              // check that passed.
              before !== null && during !== null && during - before < 40 * 1024 * 1024,
              before !== null && during !== null
                ? `growth ${((during - before) / 1024 / 1024).toFixed(1)} MiB across ${transferMiB} MiB ` +
                    `(isolated: ${await page.evaluate(() => crossOriginIsolated)})`
                : `performance.measureUserAgentSpecificMemory() gave nothing: ${
                    measureUnavailable ?? "no reason recorded"
                  } (isolated: ${await page.evaluate(() => crossOriginIsolated)})`,
            );
          }
          return await page.evaluate(() => window.__portal.state.digest);
        },
      );

      // THE CONTROL. A measurement that always reads "no growth" is indistinguishable from one
      // that reads nothing at all, so the same transfer is repeated with a sink that KEEPS every
      // chunk. If that one also shows no growth, the number above means nothing.
      if (canMeasure) {
        await run("memory measurement negative control", 300_000, async () => {
          await page.evaluate(() => window.__portal.arm("big.bin", { retain: true }));
          const beforeRetain = await measure(page);
          await page.click("#download");
          await page.waitForFunction(() => window.__portal.state.done === true, null, {
            timeout: 300_000,
          });
          const duringRetain = await measure(page);
          ok(
            "…and the measurement can fail: a sink that keeps every chunk shows the whole file",
            beforeRetain !== null &&
              duringRetain !== null &&
              duringRetain - beforeRetain > 40 * 1024 * 1024,
            beforeRetain !== null && duringRetain !== null
              ? `retaining growth ${((duringRetain - beforeRetain) / 1024 / 1024).toFixed(1)} MiB, ` +
                  `chunks kept ${await page.evaluate(() => window.__portal.state.retained)}`
              : "measurement unavailable",
          );
        });
      }

      ok(
        "…and the bytes are identical: the portal's streaming SHA-256 equals Python's own",
        boundedDigest === built.digest,
        JSON.stringify({ portal: boundedDigest, python: built.digest }),
      );

      // A real navigation WHILE a transfer is in flight: the frame is reloaded with a download
      // held open, so the port, the child's lease and the visitor's destination all belong to a
      // document that no longer exists. It has to settle, and the destination has to be aborted
      // rather than closed. Only replacing a real document exercises this.
      await run("interrupted transfer", 180_000, async () => {
        // 8 MiB into the 96 MiB transfer, as before; a quarter of the portable one.
        await page.evaluate(
          (pauseAt) => window.__portal.arm("big.bin", { pauseAt }),
          Math.min(8 * 1024 * 1024, transferBytes / 4),
        );
        await page.click("#download");
        await page.waitForFunction(() => window.__portal.state.paused === true, null, {
          timeout: 300_000,
        });
        const sessionBeforeReload = await page.evaluate(() => window.__portal.state.ready);
        await page.evaluate(() => window.__portal.child("reload"));
        await page.evaluate(() => window.__portal.resume());
        const interrupted = await page
          .waitForFunction(() => window.__portal.state.done === true, null, { timeout: 120_000 })
          .then(() =>
            page.evaluate(() => ({
              error: window.__portal.state.error,
              result: window.__portal.state.result,
              written: window.__portal.state.written,
            })),
          )
          .catch(() => null);
        ok(
          "a navigation DURING a transfer settles it rather than leaving it pending",
          interrupted !== null && interrupted.error !== null && interrupted.result === null,
          JSON.stringify(interrupted),
        );
        ok(
          "…having delivered only part of the file, and never reported success",
          interrupted !== null && interrupted.written > 0 && interrupted.written < transferBytes,
          JSON.stringify({ written: interrupted?.written, of: transferBytes }),
        );
        return sessionBeforeReload;
      }).then(async (sessionBeforeReload) => {
        // The replaced document must finish ITS handshake before anything uses the bridge again.
        const renewed = await run("session renewal after the interrupted transfer", 90_000, () =>
          renewedSession(sessionBeforeReload),
        );
        ok(
          "…after which a NEW session is established, and the host and the fixture agree on it",
          renewed.ready !== sessionBeforeReload &&
            renewed.ready === renewed.host &&
            renewed.invalidations.length > 0,
          JSON.stringify({ before: sessionBeforeReload, ...renewed }),
        );
        const reached = await run(
          "playground document reachable after the interrupted transfer",
          60_000,
          () => reachRenewedPlayground(renewed.ready),
        );
        ok(
          "…and the NEW playground document answers, reporting that same session",
          reached.childSession === renewed.ready,
          JSON.stringify(reached),
        );
      });
    }

    // The four bounded operations. The parent has ordinary window operations it cannot perform
    // across an origin - read the transcript, clear it, clear the prompt's history, start a new
    // interpreter - and without them a framed session's Copy copies an empty string and reports
    // success, Clear prints a warning, and Restart can only replace the whole document. Each is
    // its OWN phase with its own deadline: `host.perform()` settles within its 15 s operation
    // timeout, so a phase that overruns names exactly the step the browser wedged in.
    const said = await run("bridge operation: transcript setup", 30_000, () =>
      page.evaluate(() => window.__portal.child("say", "hello from the playground\n")),
    );
    ok("the playground has a transcript to share", said > 0, `${said} characters`);

    await run("bridge operation: transcript request", 30_000, async () => {
      const asked = await page.evaluate(() => window.__portal.perform("transcript"));
      ok(
        "a `transcript` request is answered by the playground",
        asked.ok === true,
        JSON.stringify(asked),
      );
      const held = await page.evaluate(() => window.__portal.transcript());
      ok(
        "…and the parent HOLDS the transcript, so its Copy control need not await anything",
        held !== null && held.text.includes("hello from the playground"),
        JSON.stringify(held).slice(0, 120),
      );
      ok(
        "…and it is not marked truncated at this size",
        held?.truncated === false,
        String(held?.truncated),
      );
    });

    await run("bridge operation: clear transcript", 30_000, async () => {
      const cleared = await page.evaluate(() => window.__portal.perform("clear-transcript"));
      const childAfterClear = await page.evaluate(() => window.__portal.child("consoleState"));
      ok(
        "`clear-transcript` reaches the playground's own console",
        cleared.ok === true && childAfterClear.cleared === 1 && childAfterClear.text === "",
        JSON.stringify({ cleared, childAfterClear }),
      );
      const heldAfterClear = await page.evaluate(() => window.__portal.transcript());
      ok(
        "…and the parent's copy is corrected rather than left stale",
        heldAfterClear !== null && heldAfterClear.text === "",
        JSON.stringify(heldAfterClear),
      );
    });

    await run("bridge operation: clear history", 30_000, async () => {
      const history = await page.evaluate(() => window.__portal.perform("clear-history"));
      const childAfterHistory = await page.evaluate(() => window.__portal.child("consoleState"));
      ok(
        "`clear-history` reaches it too, and is a different operation from clearing the transcript",
        history.ok === true && childAfterHistory.historyCleared === 1,
        JSON.stringify({ history, childAfterHistory }),
      );
    });

    await run("bridge operation: interpreter restart", 60_000, async () => {
      const sessionBeforeRestart = await page.evaluate(() => window.__portal.state.ready);
      const restarted = await page.evaluate(() => window.__portal.perform("restart"));
      const childAfterRestart = await page.evaluate(() => window.__portal.child("consoleState"));
      ok(
        "`restart` brings up a new interpreter in the SAME document",
        restarted.ok === true && childAfterRestart.restarts === 1,
        JSON.stringify({ restarted, childAfterRestart }),
      );
      ok(
        "…so the session survives it, and everything the parent holds stays valid",
        (await page.evaluate(() => window.__portal.state.ready)) === sessionBeforeRestart,
        `${sessionBeforeRestart} -> ${await page.evaluate(() => window.__portal.state.ready)}`,
      );
    });

    // AND NOTHING ELSE IS ASKABLE. These are four names rather than one general "call this"
    // because a peer able to reach the frame must not be able to describe an action.
    await run("bridge operation: unknown-operation refusal", 30_000, async () => {
      const unknown = await page.evaluate(() => window.__portal.perform("eval"));
      ok(
        "an operation that is not one of the four is refused by the parent before it is sent",
        unknown.ok === false,
        unknown.message,
      );
    });

    // A REAL navigation, with a real new document. A navigated iframe keeps the SAME
    // `contentWindow` - the `WindowProxy` is stable across navigations by design - while the
    // document behind it and its session are new. Binding the conversation to the first session
    // learned filters the new document's `hello` out and leaves the bridge dead until the whole
    // portal is reloaded; only a real reload proves the WindowProxy really is the same object.
    await run("iframe renewal", 150_000, async () => {
      const sessionBefore = await page.evaluate(() => {
        window.__portal.frameWindowBefore = document.getElementById("pg").contentWindow;
        return window.__portal.state.ready;
      });
      await page.evaluate(() => window.__portal.child("reload"));
      const renewal = await renewedSession(sessionBefore)
        .then((value) => ({ ok: true, value }))
        .catch((error) => ({ ok: false, error: String(error?.message ?? error).split("\n")[0] }));
      const renewed = await page.evaluate(
        (before) => ({
          before,
          after: window.__portal.state.ready,
          host: window.__portal.hostSession(),
          sameProxy:
            window.__portal.frameWindowBefore === document.getElementById("pg").contentWindow,
          artifacts: window.__portal.state.artifacts.map((a) => a.name),
        }),
        sessionBefore,
      );
      ok(
        "a real iframe reload renews the session rather than killing the bridge",
        renewal.ok &&
          renewed.after !== null &&
          renewed.after !== renewed.before &&
          renewed.after === renewed.host,
        JSON.stringify({ ...renewed, artifacts: undefined, error: renewal.error }),
      );
      if (renewal.ok) {
        const reached = await reachRenewedPlayground(renewal.value.ready);
        ok(
          "…and the renewed playground document answers, reporting that session",
          reached.childSession === renewal.value.ready,
          JSON.stringify(reached),
        );
      }
      ok(
        "…and it really is the same WindowProxy, which is why the old session filtered it out",
        renewed.sameProxy === true,
        `contentWindow identical across the navigation: ${renewed.sameProxy}`,
      );
      if (hasWorkspace) {
        ok(
          "…with the previous document's artifacts gone rather than carried over",
          !renewed.artifacts.includes("big.bin") && !renewed.artifacts.includes("small.csv"),
          JSON.stringify(renewed.artifacts),
        );
      }
    });

    await run("policy violations", 30_000, async () => {
      const violations = await page.evaluate(() => window.__portal.child("violations"));
      ok(
        "the sandbox keeps only what the playground needs: scripts, and its own origin storage",
        (await page.evaluate(() => document.getElementById("pg").getAttribute("sandbox"))) ===
          "allow-scripts allow-same-origin",
        "no allow-downloads (the portal saves), no allow-popups, no allow-top-navigation",
      );
      ok(
        "nothing in the playground was blocked by its own policy",
        violations.length === 0,
        JSON.stringify(violations),
      );
    });

    return await finish();
  } catch (error) {
    // A suite that gives up must still report what it established. `inBrowser` replaces a thrown
    // body's checks with an empty array, which `report` refuses to call a pass - honest but
    // uninformative. This keeps both, and names the phase when a deadline ended it.
    checks.push(phaseFailureCheck(error));
    return await finish();
  } finally {
    // Bounded: a server that will not close must not hold the suite either.
    await withDeadline(playground.close(), 10_000, "closing the playground server").catch(() => {});
    await withDeadline(portal.close(), 10_000, "closing the portal server").catch(() => {});
  }
});

/** Real memory, when the page is cross-origin isolated enough to be allowed to ask. */
async function measure(page) {
  const outcome = await page.evaluate(async () => {
    const api = performance.measureUserAgentSpecificMemory;
    if (typeof api !== "function") return { why: "not a function on this engine" };
    try {
      const r = await performance.measureUserAgentSpecificMemory();
      return { bytes: r.bytes };
    } catch (error) {
      return { why: String(error?.message ?? error).split("\n")[0] };
    }
  });
  if (outcome.why !== undefined) {
    measureUnavailable = outcome.why;
    return null;
  }
  return outcome.bytes;
}

process.exit(report("two-origin embedding and the parent-mediated download bridge", result));
