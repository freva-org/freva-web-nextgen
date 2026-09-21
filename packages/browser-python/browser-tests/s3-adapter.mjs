/**
 * Anonymous `s3://` against a path-style gateway. The mapping, the encoding and every refusal, in
 * a real interpreter with the `fsspec` wheel and no scientific stack - the Zarr read through the
 * same filesystem lives in `zarr.mjs`, which has the wheels for it.
 *
 * The fixtures are served under `/waterpark/`, so the bucket in the path is a real path segment on
 * the wire and a mapping that dropped it would 404 rather than quietly pass.
 */
import {
  fixturePage,
  inBrowser,
  report,
  requireDist,
  requireRuntimeFor,
  serve,
} from "./harness.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

requireDist();
requireRuntimeFor("anonymous s3 adapter", "s3-adapter.mjs");

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures");

const result = await inBrowser(async (page) => {
  const server = await serve(fixturePage({ profile: "minimal", packages: ["fsspec"] }), {
    roots: { "/waterpark/": FIXTURES },
  });
  const origin = server.url.replace(/\/$/, "");
  const checks = [];
  const value = async (expression) => {
    const r = await page.evaluate((e) => window.__py.push(e), expression);
    if (r.error) throw new Error(r.error);
    return r.result;
  };
  const run = async (code) => {
    const r = await page.evaluate((c) => window.__py.run(c), code);
    if (r.error) throw new Error(r.error);
    return r;
  };
  const check = (name, actual, expected, detail) =>
    checks.push({ name, pass: actual === expected, detail: detail ?? `${actual}` });
  const raises = async (name, code, fragment) => {
    const r = await page.evaluate((c) => window.__py.run(c), code);
    const text = `${r.error ?? ""}${r.stderr ?? ""}`;
    checks.push({
      name,
      pass: text.includes(fragment),
      detail: text.slice(0, 140) || "(no error)",
    });
  };

  try {
    await page.goto(server.url);
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
    await page.evaluate(() => window.__py.start());
    await run("import _freva_bridge\n_freva_bridge.install_browser_http()\nimport fsspec\n");

    for (const scheme of ["s3", "s3a", "s3n"]) {
      check(
        `registered for ${scheme}`,
        await value(`fsspec.get_filesystem_class('${scheme}').__name__`),
        "'BrowserS3FileSystem'",
      );
    }

    // The scheme goes, unlike the HTTP adapter: here the endpoint is the object's identity.
    check(
      "_strip_protocol drops the scheme and keeps bucket/key",
      await value("fsspec.get_filesystem_class('s3')._strip_protocol('s3://bucket/a/b.zarr')"),
      "'bucket/a/b.zarr'",
    );

    await run(`fs = fsspec.filesystem("s3", anon=True, endpoint_url=${JSON.stringify(origin)})\n`);
    check(
      "s3://bucket/key becomes <endpoint>/bucket/key, path style",
      await value("fs.url_for('s3://cmip6/healpix/x.zarr/.zmetadata')"),
      `'${origin}/cmip6/healpix/x.zarr/.zmetadata'`,
    );
    check(
      "a key keeps its slashes as path segments",
      await value("fs.url_for('s3://b/a/b/c')"),
      `'${origin}/b/a/b/c'`,
    );
    // Opaque, not tidied: `a//c` is a different object from `a/c` in a bucket.
    check(
      "a doubled slash inside a key is preserved",
      await value("fs.url_for('s3://b/a//c')"),
      `'${origin}/b/a//c'`,
    );
    check(
      "a space is escaped",
      await value("fs.url_for('s3://b/a b.json')"),
      `'${origin}/b/a%20b.json'`,
    );
    check(
      "and so is anything that would end the path or start a query",
      await value("fs.url_for('s3://b/a#b?c')"),
      `'${origin}/b/a%23b%3Fc'`,
    );
    check(
      "non-ASCII is percent-encoded as UTF-8",
      await value("fs.url_for('s3://b/gr\\u00fcn.json')"),
      `'${origin}/b/gr%C3%BCn.json'`,
    );

    // The read, through the mapping, against a real server. This filesystem is async-only in
    // Emscripten, so exercise the same `_` coroutines Zarr awaits; fsspec's public sync wrappers
    // require the background IO thread the browser deliberately does not have. `.zgroup` is the
    // smallest committed fixture object and exists in both store formats.
    const body = await value("(await fs._cat_file('s3://waterpark/zarr-v2/.zgroup')).decode()");
    checks.push({
      name: "a mapped key is actually fetched, and the bytes come back",
      pass: typeof body === "string" && body.includes("zarr_format"),
      detail: `${body}`.slice(0, 80),
    });
    check(
      "a missing key is missing, not an opaque failure",
      await value("await fs._exists('s3://waterpark/zarr-v2/definitely-not-here')"),
      "False",
    );

    // Every refusal, by name.
    await raises(
      "no endpoint is refused, and says what to pass",
      "fsspec.filesystem('s3', anon=True)\n",
      "endpoint_url",
    );
    await raises(
      "a plain-http endpoint that is not loopback is refused",
      "fsspec.filesystem('s3', anon=True, endpoint_url='http://gateway.example')\n",
      "https://",
    );
    await raises(
      "credentials are refused by name",
      "fsspec.filesystem('s3', key='AKIA', secret='x', endpoint_url='https://g.example')\n",
      "Credentials are not supported",
    );
    await raises(
      "anon=False is refused",
      "fsspec.filesystem('s3', anon=False, endpoint_url='https://g.example')\n",
      "anon=True",
    );
    await raises(
      "a credential hidden in client_kwargs is refused too",
      "fsspec.filesystem('s3', anon=True, endpoint_url='https://g.example', " +
        "client_kwargs={'aws_access_key_id': 'A'})\n",
      "client_kwargs.aws_access_key_id",
    );
    await raises(
      "an empty bucket is refused rather than promoting the key to one",
      "fs.url_for('s3:///key')\n",
      "needs a bucket",
    );
    await raises(
      "a dot segment is refused, because a URL parser would resolve it away",
      "fs.url_for('s3://b/a/../c')\n",
      "segment",
    );
    await raises(
      "an endpoint carrying a query string is refused",
      "fsspec.filesystem('s3', anon=True, endpoint_url='https://g.example/base?token=x')\n",
      "query string",
    );
    await raises(
      "an endpoint carrying credentials is refused",
      "fsspec.filesystem('s3', anon=True, endpoint_url='https://u:p@g.example')\n",
      "credentials in the URL",
    );
    await raises(
      "listing is refused, and names consolidated metadata",
      "await fs._ls('s3://waterpark/zarr-v2')\n",
      "consolidated metadata",
    );
    await raises(
      "writing is refused",
      "await fs._pipe_file('s3://waterpark/x', b'y')\n",
      "read-only",
    );

    return checks;
  } finally {
    await server.close();
  }
});

process.exit(report("anonymous s3:// over a path-style gateway", result));
