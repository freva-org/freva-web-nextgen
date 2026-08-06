/**
 * Real-browser proof that a credentialed request never follows an
 * unvalidated cross-origin redirect.
 *
 * Baseline: a plain `fetch(..., { redirect: "follow" })` reaches origin B with
 * the custom CSRF header intact (the browser strips `Authorization` across
 * origins per the Fetch standard, but not custom headers).
 * Library: `auth.fetch` is pinned to `redirect: "error"` and sends nothing.
 */
import http from "node:http";
import { eachBrowser, report, requireDist, serveDist } from "./harness.mjs";

requireDist();

function cors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin ?? "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Authorization,X-CSRFToken,Content-Type");
}

const received = [];
let phase = "baseline";

const b = http.createServer((req, res) => {
  cors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }
  received.push({
    phase,
    authorization: req.headers["authorization"] ?? null,
    csrf: req.headers["x-csrftoken"] ?? null,
  });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
});
await new Promise((r) => b.listen(0, "127.0.0.1", r));
const B = `http://127.0.0.1:${b.address().port}`;

const a = http.createServer((req, res) => {
  cors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/phase") {
    phase = "authfetch";
    res.writeHead(204);
    return res.end();
  }
  if (url.pathname === "/redirect") {
    res.writeHead(302, { Location: `${B}/landed` });
    return res.end();
  }
  if (url.pathname.startsWith("/dist/")) {
    const body = serveDist(url.pathname);
    if (!body) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { "Content-Type": "text/javascript" });
    return res.end(body);
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end("<!doctype html><meta charset=utf-8><title>t</title>");
});
await new Promise((r) => a.listen(0, "localhost", r));
const A = `http://localhost:${a.address().port}`;

const results = await eachBrowser(async (browser) => {
  received.length = 0;
  phase = "baseline";
  const page = await browser.newPage();
  await page.goto(`${A}/`);
  const out = await page.evaluate(
    async ({ A, B }) => {
      const mod = await import(`${A}/dist/index.js`);
      const r = {};
      try {
        await fetch(`${A}/redirect`, {
          redirect: "follow",
          headers: { Authorization: "Bearer PLACEHOLDER", "X-CSRFToken": "PLACEHOLDER" },
        });
        r.baseline = "completed";
      } catch (e) {
        r.baseline = `blocked:${e.name}`;
      }

      await fetch(`${A}/phase`).catch(() => {});

      const storage = new mod.MemoryStorage();
      const t = "aaa.bbb.ccc";
      storage.save({
        accessToken: t,
        refreshToken: t,
        tokenType: "Bearer",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        sessionVersion: "v1",
      });
      const auth = new mod.PyOidcAuthClient({
        authBaseUrl: `${A}/auth/v2`,
        redirectUri: `${A}/cb`,
        storage,
        crossTab: false,
        security: { allowedResourceOrigins: [A, B], warnOnBrowserReadableRefresh: false },
      });
      try {
        await auth.fetch(`${A}/redirect`);
        r.authFetch = "completed";
      } catch (e) {
        r.authFetch = `blocked:${e.constructor.name}`;
      }
      return r;
    },
    { A, B },
  );
  await page.close();

  const mine = received.filter((x) => x.phase === "authfetch");
  const base = received.filter((x) => x.phase === "baseline");
  const baseLeaked = base.some((x) => x.authorization || x.csrf);
  const libLeaked = mine.some((x) => x.authorization || x.csrf);
  const pass = out.authFetch.startsWith("blocked") && mine.length === 0 && !libLeaked;
  return {
    pass,
    detail:
      `baseline=${out.baseline} baselineReachedB=${base.length}` +
      ` baselineLeakedCreds=${baseLeaked} | authFetch=${out.authFetch}` +
      ` reachedB=${mine.length} leakedCreds=${libLeaked}`,
  };
});

a.close();
b.close();
process.exit(report("credentialed cross-origin redirect", results));
