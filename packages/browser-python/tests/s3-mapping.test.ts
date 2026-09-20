/**
 * The pure half of the anonymous `s3://` adapter: path splitting, the path-style URL it builds,
 * and every option it refuses.
 *
 * Run under CPython rather than in the browser, the way `freva-closure.test.ts` reads a wheel with
 * python3: these functions import nothing but `urllib.parse`, so the mapping and the refusals are
 * covered by a fast test instead of only by a suite that needs a runtime. The fsspec subclass
 * around them - registration, `url_for`, a real fetch - is `browser-tests/s3-adapter.mjs`.
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PY_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "python");

/** Every case, evaluated in one interpreter. A subprocess per assertion would dominate the run. */
const PROBE = `
import json, sys
sys.path.insert(0, ${JSON.stringify(PY_DIR)})
import browser_s3 as s3

E = "https://gw.example.org"

def attempt(fn):
    try:
        return {"ok": True, "value": fn()}
    except Exception as exc:
        return {"ok": False, "error": "%s: %s" % (type(exc).__name__, exc)}

print(json.dumps({
    "split": {
        "s3://bucket/a/b.zarr": attempt(lambda: list(s3.split_path("s3://bucket/a/b.zarr"))),
        "s3://bucket": attempt(lambda: list(s3.split_path("s3://bucket"))),
        "s3a://b/k": attempt(lambda: list(s3.split_path("s3a://b/k"))),
        "s3n://b/k": attempt(lambda: list(s3.split_path("s3n://b/k"))),
        "bare": attempt(lambda: list(s3.split_path("b/k"))),
        "trailing": attempt(lambda: list(s3.split_path("s3://b/k/"))),
        "double": attempt(lambda: list(s3.split_path("s3://b//k"))),
        "inner-double": attempt(lambda: list(s3.split_path("s3://b/a//c"))),
        "empty-bucket": attempt(lambda: list(s3.split_path("s3:///k"))),
        "no-bucket-at-all": attempt(lambda: list(s3.split_path("s3://"))),
        "wrong-scheme": attempt(lambda: list(s3.split_path("gs://b/k"))),
    },
    "url": {
        "plain": attempt(lambda: s3.object_url(E, "cmip6", "healpix/x.zarr/.zmetadata")),
        "endpoint-slash": attempt(lambda: s3.object_url(E + "/", "b", "k")),
        "space": attempt(lambda: s3.object_url(E, "b", "a b/c.json")),
        "hash-query": attempt(lambda: s3.object_url(E, "b", "a#b?c/d")),
        "plus-equals": attempt(lambda: s3.object_url(E, "b", "a+b=c")),
        "unicode": attempt(lambda: s3.object_url(E, "b", "gr\\u00fcn.json")),
        "inner-double": attempt(lambda: s3.object_url(E, "b", "a//c")),
        "leading-slash": attempt(lambda: s3.object_url(E, "b", "/k")),
        "trailing-slash": attempt(lambda: s3.object_url(E, "b", "k/")),
        "dot": attempt(lambda: s3.object_url(E, "b", "a/./c")),
        "dotdot": attempt(lambda: s3.object_url(E, "b", "a/../c")),
        "bucket-encoded": attempt(lambda: s3.object_url(E, "a b", "k")),
    },
    "endpoint": {
        "https": attempt(lambda: s3.check_endpoint("https://gw.example")),
        "loopback": attempt(lambda: s3.check_endpoint("http://localhost:8080")),
        "loopback-ip": attempt(lambda: s3.check_endpoint("http://127.0.0.1:5000")),
        "loopback-v6": attempt(lambda: s3.check_endpoint("http://[::1]:99")),
        "plain-http": attempt(lambda: s3.check_endpoint("http://gw.example")),
        "not-a-url": attempt(lambda: s3.check_endpoint("https://")),
        "base-path": attempt(lambda: s3.check_endpoint("https://h/base")),
        "query": attempt(lambda: s3.check_endpoint("https://h/base?token=x")),
        "fragment": attempt(lambda: s3.check_endpoint("https://h#f")),
        "userinfo": attempt(lambda: s3.check_endpoint("https://u:p@h")),
        "user-only": attempt(lambda: s3.check_endpoint("https://u@h")),
        "port-zero": attempt(lambda: s3.check_endpoint("https://h:0")),
        "port-huge": attempt(lambda: s3.check_endpoint("https://h:99999")),
        "port-text": attempt(lambda: s3.check_endpoint("https://h:abc")),
        "port-ok": attempt(lambda: s3.check_endpoint("https://h:8443")),
        "missing": attempt(lambda: s3.endpoint_from({"anon": True})),
        "from-client-kwargs": attempt(
            lambda: s3.endpoint_from({"client_kwargs": {"endpoint_url": E}})),
    },
    "options": {
        "anon-true": attempt(lambda: s3.check_options({"anon": True})),
        "anon-false": attempt(lambda: s3.check_options({"anon": False})),
        "key-secret": attempt(lambda: s3.check_options({"key": "AKIA", "secret": "x"})),
        "token": attempt(lambda: s3.check_options({"token": "t"})),
        "profile": attempt(lambda: s3.check_options({"profile": "default"})),
        "client-kwargs-credential": attempt(
            lambda: s3.check_options({"client_kwargs": {"aws_access_key_id": "A"}})),
        "none-values-ignored": attempt(lambda: s3.check_options({"key": None, "secret": None})),
    },
}))
`;

const probe = JSON.parse(execFileSync("python3", ["-c", PROBE], { encoding: "utf8" })) as Record<
  string,
  Record<string, { ok: boolean; value?: unknown; error?: string }>
>;

describe("s3:// path splitting", () => {
  it.each([
    ["s3://bucket/a/b.zarr", ["bucket", "a/b.zarr"]],
    ["s3://bucket", ["bucket", ""]],
    ["s3a://b/k", ["b", "k"]],
    ["s3n://b/k", ["b", "k"]],
    ["bare", ["b", "k"]],
    // Keys are opaque: a trailing slash, a leading slash and a doubled slash are all part of the
    // name, and four different objects in a bucket.
    ["trailing", ["b", "k/"]],
    ["double", ["b", "/k"]],
    ["inner-double", ["b", "a//c"]],
  ])("splits %s", (key, expected) => {
    expect(probe.split[key]).toEqual({ ok: true, value: expected });
  });

  // An empty bucket must not promote the key: `s3:///key` would otherwise fetch
  // `<endpoint>/<key>`, a URL that may well exist and hold something else entirely.
  it.each([
    ["empty-bucket", "needs a bucket"],
    ["no-bucket-at-all", "needs a bucket"],
    ["wrong-scheme", "Not an s3 path"],
  ])("refuses %s", (key, fragment) => {
    expect(probe.split[key].ok).toBe(false);
    expect(probe.split[key].error).toContain(fragment);
  });
});

describe("the path-style URL it builds", () => {
  const E = "https://gw.example.org";
  it.each([
    ["plain", `${E}/cmip6/healpix/x.zarr/.zmetadata`],
    ["endpoint-slash", `${E}/b/k`],
    // Per segment, so a key keeps its slashes - a gateway matching on `%2F` would 404 on a store
    // that works everywhere else.
    ["space", `${E}/b/a%20b/c.json`],
    ["hash-query", `${E}/b/a%23b%3Fc/d`],
    ["plus-equals", `${E}/b/a%2Bb%3Dc`],
    ["unicode", `${E}/b/gr%C3%BCn.json`],
    // Preserved, not tidied: `a//c` is not `a/c` in a bucket.
    ["inner-double", `${E}/b/a//c`],
    ["leading-slash", `${E}/b//k`],
    ["trailing-slash", `${E}/b/k/`],
    ["bucket-encoded", `${E}/a%20b/k`],
  ])("%s", (key, expected) => {
    expect(probe.url[key]).toEqual({ ok: true, value: expected });
  });

  // No escaping saves these: a URL parser resolves them before the request is sent, so the object
  // fetched would not be the object asked for.
  it.each(["dot", "dotdot"])("refuses a %s segment", (key) => {
    expect(probe.url[key].ok).toBe(false);
    expect(probe.url[key].error).toContain("segment");
  });
});

describe("the endpoint it will accept", () => {
  it.each([
    "https",
    "loopback",
    "loopback-ip",
    "loopback-v6",
    "from-client-kwargs",
    "base-path",
    "port-ok",
  ])("accepts %s", (key) => {
    expect(probe.endpoint[key].ok).toBe(true);
  });

  // An endpoint is an origin and an optional base path. Anything after the path is concatenated
  // in front of the key: `https://h/base?token=x` + `/bucket/key` addresses a query string, not
  // an object. Userinfo is a credential, which this filesystem refuses everywhere else.
  it.each(["query", "fragment", "userinfo", "user-only", "port-zero", "port-huge", "port-text"])(
    "refuses %s",
    (key) => {
      expect(probe.endpoint[key].ok).toBe(false);
    },
  );

  it("refuses plain http to a remote host", () => {
    expect(probe.endpoint["plain-http"].ok).toBe(false);
    expect(probe.endpoint["plain-http"].error).toContain("https://");
  });

  it("refuses a scheme with no host", () => {
    expect(probe.endpoint["not-a-url"].ok).toBe(false);
  });

  it("refuses to guess an endpoint that was not given", () => {
    expect(probe.endpoint.missing.ok).toBe(false);
    expect(probe.endpoint.missing.error).toContain("endpoint_url");
  });
});

describe("the options it refuses", () => {
  it("accepts anon=True", () => {
    expect(probe.options["anon-true"].ok).toBe(true);
  });

  it("ignores credential keys explicitly set to None", () => {
    expect(probe.options["none-values-ignored"].ok).toBe(true);
  });

  // By NAME, every one of them. A credential silently dropped is worse than one refused: the
  // request goes out unauthenticated and 403s somewhere the reader cannot see.
  it.each([
    ["anon-false", "anon=True"],
    ["key-secret", "key, secret"],
    ["token", "token"],
    ["profile", "profile"],
    ["client-kwargs-credential", "client_kwargs.aws_access_key_id"],
  ])("refuses %s", (key, fragment) => {
    expect(probe.options[key].ok).toBe(false);
    expect(probe.options[key].error).toContain(fragment);
  });
});
