// A mock Freva host for the browser suites: the py-oidc-auth API (login through a fake identity
// provider page, callback, token, userinfo, revoke), every ClimateClaw endpoint this extension
// uses with fixture variant streams, and a read-only S3 gateway over a directory of Zarr stores.
// It records every request, so a suite can assert what the browser sent - and what it did not.
//
//   MOCK_FREVA_PORT=4330 node browser-tests/mock-freva.mjs <callback URL>...   # standalone
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

export const AUTH = "/api/freva-nextgen/auth/v2";
export const API = "/api/chatbot";
export const RUN_AND_FIX_PREFIX =
  "Execute the following Python code with your code interpreter EXACTLY";
export const MODELS = ["gpt-test", "gpt-fast"];
/** Modules the mock's DKRZ does not have (its Run at DKRZ import check says so). */
export const MISSING_AT_DKRZ = new Set(["healpix_geo", "not_at_dkrz"]);

// fixtures

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A real PNG of noise, large enough that its base64 spans several 8 KiB lines. */
export function noisePng(width = 96, height = 96, seed = 7) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // truecolour
  let x = seed;
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let i = 1; i < row.length; i++) {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      row[i] = x & 0xff;
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const PNG_B64 = noisePng().toString("base64");

function imageLines(id) {
  const out = [];
  for (let i = 0; i < PNG_B64.length; i += 8192) {
    out.push({ variant: "Image", content: PNG_B64.slice(i, i + 8192), id });
  }
  return out;
}

function codeChunks(code, id) {
  const args = JSON.stringify({ code });
  const out = [];
  for (let i = 0; i < args.length; i += 7)
    out.push({ variant: "Code", content: args.slice(i, i + 7), id });
  return out;
}

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
function fakeJwt(sub, ttl) {
  const now = Math.floor(Date.now() / 1000);
  return `${b64url({ alg: "none", typ: "JWT" })}.${b64url({ sub, exp: now + ttl, iat: now, jti: randomBytes(6).toString("hex") })}.sig`;
}

// the server

/**
 * @param {object} options
 * @param {string[]} options.redirectUris  the registered callback URLs (freva-rest's allow-list)
 * @param {string} [options.zarrRoot]  a directory of Zarr stores, served as bucket `data`
 * @param {boolean} [options.coop]  the identity provider page severs the opener (COOP)
 * @param {number} [options.port]  0 for any
 * @param {boolean} [options.revoke]  serve POST /revoke (Freva's py-oidc-auth has none);
 *   default on unless MOCK_FREVA_REVOKE=0
 */
export async function startMockFreva({
  redirectUris = [],
  zarrRoot,
  coop = true,
  port = 0,
  revoke = process.env.MOCK_FREVA_REVOKE !== "0",
} = {}) {
  const log = [];
  const tokens = new Map(); // access token -> username
  const codes = new Map(); // code -> state
  const states = new Set();
  const threads = new Map(); // id -> { variants, topic, date, stopped, streaming }
  const feedback = []; // userfeedback bodies
  const logouts = []; // post_logout_redirect_uri of each end-session
  const stops = [];
  /** Streams refused because their thread was already streaming (HTTP 409). */
  const conflicts = [];
  let threadCount = 0;
  const allowed = new Set(redirectUris);
  /** The next sign-in is cancelled at the provider (error=access_denied). */
  let denyNext = false;
  let coopNow = coop;
  let base = "";

  const cors = (req) => ({
    "access-control-allow-origin": req.headers.origin ?? "*",
    "access-control-allow-headers": "authorization, content-type, accept",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-max-age": "600",
    vary: "Origin",
  });
  const json = (req, res, status, body) => {
    res.writeHead(status, { "content-type": "application/json", ...cors(req) });
    res.end(JSON.stringify(body));
  };
  const bodyOf = (req) =>
    new Promise((resolve) => {
      const parts = [];
      req.on("data", (d) => parts.push(d));
      req.on("end", () => {
        const text = Buffer.concat(parts).toString("utf8");
        try {
          resolve(text ? JSON.parse(text) : {});
        } catch {
          resolve({ __invalid: text });
        }
      });
    });
  const userOf = (req) => {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    return tokens.get(token) ?? null;
  };
  const issue = (user) => {
    const access = fakeJwt(user, 3600);
    tokens.set(access, user);
    return {
      access_token: access,
      refresh_token: access,
      token_type: "Bearer",
      expires: Math.floor(Date.now() / 1000) + 3600,
      refresh_expires: Math.floor(Date.now() / 1000) + 7200,
      scope: "openid profile",
    };
  };

  const stream = async (req, res, body, user) => {
    const id = body.thread_id;
    const input = String(body.input ?? "");
    if (!id) return json(req, res, 422, { detail: "Thread-id not found." });
    if (!input) return json(req, res, 422, { detail: "Input not found." });
    if (body.chatbot && !MODELS.includes(body.chatbot)) {
      return json(req, res, 422, { detail: `Chatbot model '${body.chatbot}' not found.` });
    }
    let thread = threads.get(id);
    const isNew = !thread;
    if (!thread) {
      thread = {
        variants: [],
        topic: input.replace(/\s+/g, " ").slice(0, 40),
        date: new Date().toISOString(),
        user,
      };
      threads.set(id, thread);
    }
    if (thread.streaming) {
      conflicts.push(id);
      return json(req, res, 409, { detail: "already streaming" });
    }
    thread.streaming = true;
    thread.stopped = false;
    res.writeHead(200, {
      "content-type": "application/x-ndjson",
      "cache-control": "no-cache, no-transform",
      ...cors(req),
    });
    const send = (v) => {
      thread.variants.push(v);
      res.write(`${JSON.stringify(v)}\n`);
    };
    const pause = (ms) => new Promise((r) => setTimeout(r, ms));
    if (isNew) send({ variant: "ServerHint", content: { thread_id: id } });
    thread.variants.push({ variant: "User", content: input });
    try {
      if (input.startsWith(RUN_AND_FIX_PREFIX)) {
        // The cell is the last python block; a check of its imports comes first when it has some.
        const blocks = [...input.matchAll(/```python\n([\s\S]*?)\n```/g)].map((m) => m[1]);
        const code = blocks.at(-1) ?? "";
        if (blocks.length > 1) {
          const check = blocks[0];
          const asked = JSON.parse(/\[(?:"[^"]*",?\s*)*\]/.exec(check)?.[0] ?? "[]");
          const missing = asked.filter((m) => MISSING_AT_DKRZ.has(m));
          for (const v of codeChunks(check, "call_c1")) send(v);
          send({
            variant: "CodeOutput",
            content: {
              stdout: `climateclaw-missing: ${missing.join(",")}\n`,
              stderr: "",
              result_repr: "",
              display_data: [],
              error: "",
              created_files: [],
            },
            id: "call_c1",
          });
          if (missing.length) {
            send({ variant: "Assistant", content: `MISSING: ${missing.join(", ")}` });
            send({ variant: "StreamEnd", content: "Stream ended." });
            return;
          }
        }
        if (code.includes("NOFIX")) {
          // Three runs - the cell as written, then two fixes - none of which works.
          for (const [n, name] of ["f", "g", "h"].entries()) {
            for (const v of codeChunks(n === 0 ? code : `${name}()`, `call_n${n}`)) send(v);
            send({
              variant: "CodeOutput",
              content: {
                stdout: "",
                stderr: "",
                result_repr: "",
                display_data: [],
                error: `NameError: name '${name}' is not defined`,
                created_files: [],
              },
              id: `call_n${n}`,
            });
          }
          send({ variant: "Assistant", content: "GAVE UP: nothing defines the function" });
          send({ variant: "StreamEnd", content: "Stream ended." });
          return;
        }
        for (const v of codeChunks(code, "call_r1")) send(v);
        // A slow run, so that another cell's Run & fix overlaps it.
        if (code.includes("SLOWFIX")) await pause(2500);
        if (code.includes("1/0")) {
          send({
            variant: "CodeOutput",
            content: {
              stdout: "",
              stderr: "",
              result_repr: "",
              display_data: [],
              error: "Traceback (most recent call last):\nZeroDivisionError: division by zero",
              created_files: [],
            },
            id: "call_r1",
          });
          const fixed = code.replace("1/0", "1/1");
          for (const v of codeChunks(fixed, "call_r2")) send(v);
          send({
            variant: "CodeOutput",
            content: {
              stdout: "fixed run\n",
              result_repr: "1.0",
              stderr: "",
              display_data: [],
              error: "",
              created_files: [],
            },
            id: "call_r2",
          });
          send({ variant: "Assistant", content: "Replaced 1/0 with 1/1." });
        } else {
          send({
            variant: "CodeOutput",
            content: {
              stdout: "ran at dkrz\n",
              stderr: "",
              result_repr: "",
              display_data: [],
              error: "",
              created_files: [],
            },
            id: "call_r1",
          });
          for (const v of imageLines("call_r1_0")) send(v);
        }
      } else if (input.includes("SAVEFIG")) {
        // A figure saved with savefig and closed: not streamed, only named with its preview URL.
        const code = "plt.plot([1, 2, 3])\nplt.savefig('era5_tas_july.png')\nplt.close()";
        for (const v of codeChunks(code, "call_s1")) send(v);
        send({
          variant: "CodeOutput",
          content: {
            stdout: "",
            stderr: "",
            result_repr: "",
            display_data: [],
            error: "",
            created_files: [
              {
                path: "era5_tas_july.png",
                mime_type: "image/png",
                preview_url: `${base}/static/preview/climateclaw/${id}/era5_tas_july.png`,
              },
            ],
          },
          id: "call_s1",
        });
        send({ variant: "Assistant", content: "The map is saved as era5_tas_july.png." });
      } else if (input.includes("BROKEN")) {
        // Code that fails at DKRZ: its error goes to the cell, its name to the chat.
        for (const v of codeChunks("print(1/0)", "call_b1")) send(v);
        send({
          variant: "CodeOutput",
          content: {
            stdout: "",
            stderr: "",
            result_repr: "",
            display_data: [],
            error: "Traceback (most recent call last):\nZeroDivisionError: division by zero",
          },
          id: "call_b1",
        });
        send({ variant: "Assistant", content: "That divided by zero." });
      } else if (input.includes("TYPEOUT")) {
        // A reply that thinks first, then streams its code slowly: it types into its cell.
        await pause(700);
        send({ variant: "Assistant", content: "Typing it out." });
        await pause(300);
        const code = Array.from(
          { length: 12 },
          (_, i) => `# typed by ClimateClaw, line ${i + 1}\nx${i} = ${i}`,
        ).join("\n");
        for (const v of codeChunks(code, "call_t1")) {
          send(v);
          await pause(30);
        }
        await pause(400);
        send({
          variant: "CodeOutput",
          content: { stdout: "typed\n", stderr: "", result_repr: "", display_data: [], error: "" },
          id: "call_t1",
        });
        await pause(300);
        send({ variant: "Assistant", content: "\n\nAll typed." });
      } else if (input.includes("SLOW")) {
        send({ variant: "Assistant", content: "Working on it" });
        let i = 0;
        for (; i < 300 && !thread.stopped && !res.destroyed; i++) {
          await pause(100);
          if (i % 5 === 0) send({ variant: "ServerHint", content: { memory: 1, cpu_usage: 2 } });
          if (i % 5 === 2) send({ variant: "Assistant", content: "." });
        }
        thread.slowEnded = { iterations: i, stopped: thread.stopped, destroyed: res.destroyed };
        send({ variant: "StreamEnd", content: "Stream is stopped by user." });
        return;
      } else if (input.includes("FAIL")) {
        send({ variant: "ServerError", content: "the code interpreter is not available" });
      } else {
        send({ variant: "Assistant", content: "Here is " });
        send({
          variant: "ServerHint",
          content: {
            busy: true,
            detail: "Executing previous code blocks... Please wait a moment.",
          },
        });
        send({ variant: "Assistant", content: "the global mean." });
        for (const v of codeChunks("import numpy as np\nprint(np.mean([1, 2, 3]))", "call_1")) {
          send(v);
          await pause(5);
        }
        send({ variant: "ServerHint", content: { memory: 1 } });
        send({
          variant: "CodeOutput",
          content: {
            stdout: "2.0\n",
            stderr: "",
            result_repr: "",
            display_data: [{ "text/plain": "<Figure size 640x480>" }],
            error: "",
            created_files: [],
          },
          id: "call_1",
        });
        for (const v of imageLines("call_1_0")) send(v);
        send({ variant: "ToolCall", content: "{}", tool_name: "web_search", id: "t1" });
        send({ variant: "ToolOutput", content: "results", tool_name: "web_search", id: "t1" });
        send({ variant: "Assistant", content: "\n\nDone: the mean is 2.0." });
      }
      send({ variant: "StreamEnd", content: "Stream ended." });
    } finally {
      thread.streaming = false;
      res.end();
    }
  };

  const s3List = (req, res, url) => {
    // GET /s3/<bucket>?list-type=2&prefix=...&delimiter=/  over `zarrRoot`, bucket "data".
    const [, , bucket] = url.pathname.split("/");
    const prefix = url.searchParams.get("prefix") ?? "";
    if (bucket !== "data" || !zarrRoot) {
      res.writeHead(404, cors(req));
      return res.end();
    }
    const dir = join(zarrRoot, ...prefix.split("/").filter(Boolean));
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    const prefixes = entries.filter((e) => e.isDirectory()).map((e) => `${prefix}${e.name}/`);
    const files = entries
      .filter((e) => e.isFile())
      .map((e) => ({ key: `${prefix}${e.name}`, size: statSync(join(dir, e.name)).size }));
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
      `<Name>data</Name><Prefix>${prefix}</Prefix><KeyCount>${prefixes.length + files.length}</KeyCount>` +
      `<MaxKeys>1000</MaxKeys><Delimiter>/</Delimiter><IsTruncated>false</IsTruncated>` +
      files
        .map(
          (f) =>
            `<Contents><Key>${f.key}</Key><Size>${f.size}</Size><LastModified>2026-01-01T00:00:00.000Z</LastModified></Contents>`,
        )
        .join("") +
      prefixes.map((p) => `<CommonPrefixes><Prefix>${p}</Prefix></CommonPrefixes>`).join("") +
      `</ListBucketResult>`;
    res.writeHead(200, { "content-type": "application/xml", ...cors(req) });
    res.end(xml);
  };

  const s3Object = (req, res, url) => {
    const [, , bucket, ...rest] = url.pathname.split("/");
    const file = join(zarrRoot ?? "/nonexistent", ...rest.map(decodeURIComponent));
    if (bucket !== "data" || !zarrRoot || rest.some((p) => p === "..")) {
      res.writeHead(404, cors(req));
      return res.end();
    }
    try {
      const bytes = readFileSync(file);
      res.writeHead(200, { "content-type": "application/octet-stream", ...cors(req) });
      res.end(bytes);
    } catch {
      res.writeHead(404, cors(req));
      res.end();
    }
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const path = url.pathname;
    log.push({
      method: req.method,
      path,
      query: url.search,
      origin: req.headers.origin ?? null,
      authorization: req.headers.authorization ?? null,
      headers: { ...req.headers },
    });
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors(req));
      return res.end();
    }
    // The mock's own control, for a probe driving it from outside the process
    if (path === "/__mock/deny-next-login" && req.method === "POST") {
      denyNext = true;
      return json(req, res, 200, {});
    }
    // Whether the provider's page severs the popup's opener (COOP), as Keycloak may or may not.
    if (path === "/__mock/coop" && req.method === "POST") {
      coopNow = url.searchParams.get("on") !== "0";
      return json(req, res, 200, { coop: coopNow });
    }
    // auth
    if (path === `${AUTH}/login`) {
      const redirect = url.searchParams.get("redirect_uri") ?? "";
      if (!allowed.has(redirect)) {
        res.writeHead(400, { "content-type": "text/plain" });
        return res.end(`redirect_uri ${redirect} is not registered`);
      }
      const state = randomBytes(8).toString("hex");
      states.add(state);
      res.writeHead(302, {
        location: `${base}/idp/authorize?${new URLSearchParams({ redirect_uri: redirect, state })}`,
      });
      return res.end();
    }
    if (path === "/idp/authorize") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        ...(coopNow ? { "cross-origin-opener-policy": "same-origin" } : {}),
      });
      return res.end(
        '<!doctype html><meta charset="utf-8"><title>Mock IdP</title><p>Signing you in…</p><script src="/idp/authorize.js"></script>',
      );
    }
    if (path === "/idp/authorize.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      return res.end(
        `const q = new URLSearchParams(location.search);
         fetch("/idp/code?state=" + encodeURIComponent(q.get("state"))).then((r) => r.text()).then((code) => {
           const answer = code === "DENY" ? { error: "access_denied", state: q.get("state") } : { code, state: q.get("state") };
           setTimeout(() => location.replace(q.get("redirect_uri") + "?" + new URLSearchParams(answer)), 150);
         });`,
      );
    }
    if (path === "/idp/code") {
      const state = url.searchParams.get("state") ?? "";
      if (!states.has(state)) return json(req, res, 400, { detail: "unknown state" });
      if (denyNext) {
        denyNext = false;
        res.writeHead(200, { "content-type": "text/plain" });
        return res.end("DENY");
      }
      const code = randomBytes(8).toString("hex");
      codes.set(code, state);
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end(code);
    }
    if (path === `${AUTH}/callback`) {
      const code = url.searchParams.get("code") ?? "";
      if (!codes.has(code) || codes.get(code) !== url.searchParams.get("state")) {
        return json(req, res, 400, { detail: "invalid code" });
      }
      codes.delete(code);
      return json(req, res, 200, issue("jdoe"));
    }
    if (path === `${AUTH}/token` && req.method === "POST") {
      const user = userOf(req) ?? "jdoe";
      return json(req, res, 200, issue(user));
    }
    if (path === `${AUTH}/userinfo`) {
      const user = userOf(req);
      if (!user) return json(req, res, 401, { detail: "unauthenticated" });
      return json(req, res, 200, {
        username: user,
        email: `${user}@example.org`,
        first_name: user === "jdoe" ? "Jane" : "",
        last_name: user === "jdoe" ? "Doe" : "",
      });
    }
    if (path === `${AUTH}/revoke` && revoke) {
      const header = req.headers.authorization ?? "";
      tokens.delete(header.slice(7));
      await bodyOf(req);
      return json(req, res, 200, {});
    }
    if (path === `${AUTH}/logout`) {
      // The identity provider's end-session: back to the allowed post-logout page, if any.
      logouts.push(url.searchParams.get("post_logout_redirect_uri") ?? "");
      const back = url.searchParams.get("post_logout_redirect_uri");
      if (back && allowed.has(back)) {
        res.writeHead(302, { location: back });
        return res.end();
      }
      return json(req, res, 200, {});
    }
    // ClimateClaw
    if (path.startsWith(`${API}/`)) {
      const user = userOf(req);
      if (!user) return json(req, res, 401, { detail: "Token validation failed." });
      const endpoint = path.slice(API.length + 1);
      if (endpoint === "availablechatbots" && req.method === "GET")
        return json(req, res, 200, MODELS);
      if (endpoint === "newthread" && req.method === "GET") {
        threadCount += 1;
        return json(req, res, 200, `thread-${threadCount}-${randomBytes(3).toString("hex")}`);
      }
      if (req.method !== "POST") return json(req, res, 405, { detail: "Method Not Allowed" });
      const body = await bodyOf(req);
      log[log.length - 1].body = body;
      if (endpoint === "streamresponse") return stream(req, res, body, user);
      if (endpoint === "stop") {
        stops.push(body.thread_id);
        const thread = threads.get(body.thread_id);
        if (!thread || !thread.streaming) return json(req, res, 404, { detail: "not found" });
        thread.stopped = true;
        return json(req, res, 200, { detail: "Conversation stopped." });
      }
      if (endpoint === "getuserthreads") {
        const all = [...threads.entries()]
          .filter(([, t]) => t.user === user)
          .reverse()
          .map(([thread_id, t]) => ({
            user_id: user,
            thread_id,
            date: t.date,
            topic: t.topic,
            content: [],
          }));
        const size = Number(body.num_threads ?? 20);
        const page = Number(body.page ?? 0);
        return json(req, res, 200, [all.slice(page * size, page * size + size), all.length]);
      }
      const own = (id) => {
        const thread = threads.get(id);
        return thread && thread.user === user ? thread : null;
      };
      if (endpoint === "setthreadtopic") {
        const thread = own(body.thread_id);
        if (!thread) return json(req, res, 500, { detail: "Failed to update thread topic." });
        thread.topic = String(body.topic ?? "");
        return json(req, res, 200, { detail: "Topic updated." });
      }
      if (endpoint === "deletethread") {
        if (!own(body.thread_id))
          return json(req, res, 500, { detail: "Failed to remove thread." });
        threads.delete(body.thread_id);
        return json(req, res, 200, { detail: "Thread deleted." });
      }
      if (endpoint === "userfeedback") {
        const thread = own(body.thread_id);
        if (!thread) return json(req, res, 404, { detail: "Thread not found" });
        const rated = thread.variants.filter(
          (v) => v.variant === "Assistant" || v.variant === "Code",
        );
        const target = rated[Number(body.feedback_index)];
        if (!target) return json(req, res, 422, { detail: "feedback_index outside range" });
        if (body.feedback === "remove") delete target.feedback;
        else target.feedback = body.feedback;
        feedback.push(body);
        return json(req, res, 200, { detail: "Feedback saved." });
      }
      if (endpoint === "editthread") {
        const source = own(body.source_thread_id);
        if (!source) return json(req, res, 404, { detail: "Thread not found." });
        let seen = -1;
        const cut = source.variants.findIndex(
          (v) => v.variant === "User" && (seen += 1) === Number(body.user_index),
        );
        if (cut < 0) return json(req, res, 422, { detail: "user_index outside range" });
        threadCount += 1;
        const id = `thread-${threadCount}-${randomBytes(3).toString("hex")}`;
        const history = source.variants.slice(0, cut).map((v) => ({ ...v }));
        threads.set(id, { variants: history, topic: source.topic, date: source.date, user });
        return json(req, res, 200, { new_thread_id: id, history });
      }
      if (endpoint === "getthread") {
        const thread = threads.get(body.thread_id);
        if (!thread) return json(req, res, 404, { detail: "Thread not found." });
        return json(req, res, 200, thread.variants);
      }
      return json(req, res, 404, { detail: "Not Found" });
    }
    // ClimateClaw's saved files, as the Freva website serves them (public, with CORS here)
    if (path.startsWith("/static/preview/climateclaw/")) {
      res.writeHead(200, { "content-type": "image/png", ...cors(req) });
      return res.end(noisePng(160, 100, 11));
    }
    // S3
    if (path.startsWith("/s3/")) {
      if (url.searchParams.get("list-type") === "2") return s3List(req, res, url);
      return s3Object(req, res, url);
    }
    res.writeHead(404, cors(req));
    res.end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
  return {
    url: base,
    log,
    stops,
    threads,
    feedback,
    logouts,
    conflicts,
    allowRedirect: (uri) => allowed.add(uri),
    denyNextLogin: () => {
      denyNext = true;
    },
    /** A valid access token, for requests made outside a browser. */
    issueToken: (user = "jdoe") => issue(user).access_token,
    /** Seed a stored thread (for History). */
    seedThread(id, user, topic, variants) {
      threads.set(id, { variants, topic, date: "2026-09-01T10:00:00Z", user });
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// Standalone, for trying a notebook locally: MOCK_FREVA_PORT fixes the port (default: any), and
// every argument is a login callback URL to accept. Replies are the scripted fixtures above.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const mock = await startMockFreva({
    redirectUris: process.argv.slice(2),
    port: Number(process.env.MOCK_FREVA_PORT ?? 0),
  });
  console.log(
    `mock Freva at ${mock.url} (callbacks: ${process.argv.slice(2).join(", ") || "none"})`,
  );
}
