/**
 * Real-browser proof of query-aware callback matching, RFC 9207 issuer
 * validation, duplicate-parameter rejection and address-bar scrubbing.
 */
import http from "node:http";
import { eachBrowser, report, requireDist, serveDist } from "./harness.mjs";

requireDist();

const ISS = "https://idp.test/realms/freva";

const srv = http.createServer((req, res) => {
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
  if (url.pathname === "/auth/v2/callback") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return res.end(
      JSON.stringify({
        access_token: "aaa.bbb.ccc",
        refresh_token: "aaa.bbb.ccc",
        token_type: "Bearer",
        expires: Math.floor(Date.now() / 1000) + 3600,
        scope: "openid",
      }),
    );
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end("<!doctype html><meta charset=utf-8><title>cb</title>");
});
await new Promise((r) => srv.listen(0, "localhost", r));
const A = `http://localhost:${srv.address().port}`;

const results = await eachBrowser(async (browser) => {
  const page = await browser.newPage();
  await page.goto(`${A}/cb?tenant=a&code=REALCODE&state=s1&iss=${encodeURIComponent(ISS)}`);
  const out = await page.evaluate(
    async ({ A, ISS }) => {
      const mod = await import(`${A}/dist/index.js`);
      const mk = () =>
        new mod.PyOidcAuthClient({
          authBaseUrl: `${A}/auth/v2`,
          redirectUri: `${A}/cb?tenant=a`,
          storage: new mod.MemoryStorage(),
          crossTab: false,
          security: {
            allowedRedirectUris: [`${A}/cb?tenant=a`],
            requireLoginTransaction: false,
            acknowledgeNoLoginTransaction: true,
            warnOnBrowserReadableRefresh: false,
            expectedIssuer: ISS,
          },
        });
      const r = {};
      const auth = mk();

      // ROUTING: a structurally registered callback is still routed to the
      // handler even when the response itself is invalid — otherwise the app's
      // router skips it and the code stays in the URL.
      r.routesValid = auth.isCallbackUrl();
      r.routesDuplicateCode = auth.isCallbackUrl(`${A}/cb?tenant=a&code=x&code=z&state=y`);
      r.routesDuplicateState = auth.isCallbackUrl(`${A}/cb?tenant=a&code=x&state=y&state=z`);
      r.routesMixed = auth.isCallbackUrl(`${A}/cb?tenant=a&code=x&state=y&error=denied`);
      r.routesBadIssuer = auth.isCallbackUrl(
        `${A}/cb?tenant=a&code=x&state=y&iss=https://evil.example`,
      );
      // A different route or a swapped static parameter is NOT ours.
      r.rejectsTenantSwap = !auth.isCallbackUrl(`${A}/cb?tenant=EVIL&code=x&state=y`);
      r.rejectsOtherRoute = !auth.isCallbackUrl(`${A}/elsewhere?code=x&state=y`);

      // VALIDATION: each invalid response throws, and scrubs first.
      const check = async (qs) => {
        history.replaceState(null, "", `/cb?tenant=a&${qs}`);
        try {
          await mk().handleCallback();
          return { threw: false, href: location.href };
        } catch {
          return { threw: true, href: location.href, search: location.search };
        }
      };
      const dup = await check("code=SCRUBME1&code=z&state=y");
      r.dupThrew = dup.threw;
      r.dupScrubbed = !dup.href.includes("SCRUBME1");
      r.dupKeptStatic = dup.search === "?tenant=a";
      const mixed = await check("code=SCRUBME2&state=y&error=denied");
      r.mixedThrew = mixed.threw;
      r.mixedScrubbed = !mixed.href.includes("SCRUBME2");
      const badIss = await check("code=SCRUBME3&state=y&iss=https%3A%2F%2Fevil.example");
      r.issThrew = badIss.threw;
      r.issScrubbed = !badIss.href.includes("SCRUBME3");

      // HAPPY PATH: real exchange over the network, static parameter preserved.
      history.replaceState(
        null,
        "",
        `/cb?tenant=a&code=REALCODE&state=s1&iss=${encodeURIComponent(ISS)}`,
      );
      const tok = await mk().handleCallback();
      r.exchanged = tok.accessToken === "aaa.bbb.ccc";
      r.finalSearch = location.search;
      r.codeLeftInUrl = location.href.includes("REALCODE");
      return r;
    },
    { A, ISS },
  );
  await page.close();

  const pass = Object.entries(out).every(([k, v]) =>
    k === "finalSearch" ? v === "?tenant=a" : k === "codeLeftInUrl" ? v === false : v === true,
  );
  const routing = `routes(valid/dup/state/mixed/iss)=${[out.routesValid, out.routesDuplicateCode, out.routesDuplicateState, out.routesMixed, out.routesBadIssuer].join("/")}`;
  const rejects = `notOurs(tenant/route)=${out.rejectsTenantSwap}/${out.rejectsOtherRoute}`;
  const scrub = `threw+scrubbed dup=${out.dupThrew}/${out.dupScrubbed} mixed=${out.mixedThrew}/${out.mixedScrubbed} iss=${out.issThrew}/${out.issScrubbed} staticKept=${out.dupKeptStatic}`;
  return {
    pass,
    detail: `${routing} ${rejects} ${scrub} exchanged=${out.exchanged} search=${out.finalSearch} codeInUrl=${out.codeLeftInUrl}`,
  };
});

srv.close();
process.exit(report("callback handling", results));
