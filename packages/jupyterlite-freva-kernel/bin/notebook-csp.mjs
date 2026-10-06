// The notebook document's Content-Security-Policy. Served ONLY on the playground origin, and only
// for the notebook site: the portal's own pages keep their policy.
//
// Measured, not assumed (browser-tests/notebook.mjs asserts zero violations under exactly this):
//   - scripts: `'self'` and the runtime's origin, plus `'wasm-unsafe-eval'` for the interpreter.
//     No `'unsafe-eval'` - the settings registry is replaced by an eval-free one - and no
//     `'unsafe-inline'`: the inline bootstrap is moved to a file at build time.
//   - styles: `'unsafe-inline'` IS needed. JupyterLab and CodeMirror inject their stylesheets as
//     <style> elements at run time; with `style-src 'self'` the notebook renders without layout.
//     Python-authored markup never gets a style: the output sanitiser removes every <style> and
//     style attribute before anything reaches the DOM.

function origin(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError(`not an http(s) origin: ${value}`);
  }
  return url.origin;
}

/**
 * @param {object} options
 * @param {string} [options.runtimeIndexUrl] where the Pyodide runtime is served, when not 'self'
 * @param {string[]} [options.connectSources] further connect-src sources: origins, or "https:"
 * @param {string[]} [options.frameAncestors] default 'none': the notebook is a top-level page
 * @param {string[]} [options.frameSources] origins the notebook may frame (default none), e.g. a
 *   data viewer the site opted into
 * @param {string[]} [options.imageSources] origins images may come from besides 'self', data: and
 *   blob: (default none), e.g. where an assistant serves the figures its code saved
 */
export function notebookCsp({
  runtimeIndexUrl,
  connectSources = [],
  frameAncestors = ["'none'"],
  frameSources = [],
  imageSources = [],
} = {}) {
  const runtime =
    runtimeIndexUrl && /^https?:/.test(runtimeIndexUrl) ? origin(runtimeIndexUrl) : null;
  const connect = [
    ...(runtime ? [runtime] : []),
    ...connectSources.map((s) => (s === "https:" ? s : origin(s))),
  ]
    .filter((s, i, all) => all.indexOf(s) === i)
    .sort();
  // Whole origins only: a frame is a third-party document, never a scheme-wide grant.
  const frames = frameSources
    .map((s) => origin(s))
    .filter((s, i, all) => all.indexOf(s) === i)
    .sort();
  // Whole HTTPS origins (or http on localhost) only, never a scheme.
  const images = imageSources
    .filter((s) => /^https:\/\//.test(s) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(s))
    .map((s) => origin(s))
    .filter((s, i, all) => all.indexOf(s) === i)
    .sort();
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
    `frame-ancestors ${frameAncestors.join(" ")}`,
    `script-src 'self' 'wasm-unsafe-eval'${runtime ? ` ${runtime}` : ""}`,
    "worker-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    // `attachment:` is JupyterLab's own placeholder for a markdown attachment: rendered first,
    // then rewritten to a data: URL. It names no scheme a browser can fetch, so allowing it
    // grants nothing; refusing it only reports a violation for every attachment.
    `img-src 'self' data: blob: attachment:${images.length ? ` ${images.join(" ")}` : ""}`,
    "font-src 'self'",
    "manifest-src 'self'",
    `connect-src 'self'${connect.length ? ` ${connect.join(" ")}` : ""} data: blob:`,
    ...(frames.length ? [`frame-src ${frames.join(" ")}`] : []),
  ].join("; ");
}
