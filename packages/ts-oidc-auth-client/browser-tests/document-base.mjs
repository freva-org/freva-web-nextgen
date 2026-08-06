/**
 * Real-browser proof that a `<base>` element cannot move a validated request.
 *
 * Fetch resolves a relative request URL against the document's API base URL,
 * which `<base href>` controls - NOT against `location.href`. A client that
 * validates against `location.href` and then hands fetch the original relative
 * string sends the credential somewhere it never checked.
 *
 * Also covers return-path normalization in a real URL parser.
 */
import http from "node:http";
import { eachBrowser, report, requireDist, serveDist } from "./harness.mjs";

requireDist();

const received = [];

function cors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin ?? "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type");
}

// Origin B - the base element's target. Nothing credentialed may arrive here.
const b = http.createServer((req, res) => {
  cors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }
  received.push({
    url: req.url,
    authorization: req.headers["authorization"] ?? null,
  });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end("{}");
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
  if (url.pathname.startsWith("/dist/")) {
    const body = serveDist(url.pathname);
    if (!body) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { "Content-Type": "text/javascript" });
    return res.end(body);
  }
  if (url.pathname === "/data") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end("{}");
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  // The hostile part: a base element pointing at another origin.
  res.end(`<!doctype html><meta charset=utf-8><base href="${B}/"><title>base</title>`);
});
await new Promise((r) => a.listen(0, "localhost", r));
const A = `http://localhost:${a.address().port}`;

const results = await eachBrowser(async (browser) => {
  received.length = 0;
  const page = await browser.newPage();
  await page.goto(`${A}/page`);

  const out = await page.evaluate(
    async ({ A }) => {
      const mod = await import(`${A}/dist/index.js`);
      const r = { documentBase: document.baseURI };

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
        security: { allowedResourceOrigins: [A], warnOnBrowserReadableRefresh: false },
      });

      // A relative fetch under a hostile <base> must be REFUSED, because the
      // browser would resolve it to origin B, which is not allow-listed.
      try {
        await auth.fetch("/data");
        r.relativeFetch = "completed";
      } catch (e) {
        r.relativeFetch = `blocked:${e.constructor.name}`;
      }

      // An absolute same-origin URL is unaffected by the base element.
      try {
        await auth.fetch(`${A}/data`);
        r.absoluteFetch = "completed";
      } catch (e) {
        r.absoluteFetch = `blocked:${e.constructor.name}`;
      }

      // Return-path normalization in a real URL parser.
      const hostile = [
        "/" + String.fromCharCode(9) + "/evil.example/x",
        "/" + String.fromCharCode(92) + "evil.example",
        "//evil.example",
      ];
      r.returnPathsRejected = hostile.every((p) => {
        try {
          auth.login({ next: p });
          return false;
        } catch {
          return true;
        }
      });
      return r;
    },
    { A, B },
  );

  await page.close();
  const leaked = received.filter((x) => x.authorization);
  const pass =
    out.relativeFetch.startsWith("blocked") &&
    out.absoluteFetch === "completed" &&
    out.returnPathsRejected &&
    leaked.length === 0;
  return {
    pass,
    detail:
      `documentBaseIsOtherOrigin=${out.documentBase.startsWith(B)}` +
      ` relativeFetch=${out.relativeFetch} absoluteFetch=${out.absoluteFetch}` +
      ` returnPathsRejected=${out.returnPathsRejected}` +
      ` credentialsReachingBaseOrigin=${leaked.length}`,
  };
});

a.close();
b.close();
process.exit(report("document base + return path", results));
