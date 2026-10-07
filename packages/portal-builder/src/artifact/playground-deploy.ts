// The deployment description for the separate-origin playground.
//
// The child document is emitted inside the portal artifact, because the same bundler compiles
// it and it shares the content-hashed asset directory, but it is not deployed there: it goes
// to the origin the configuration names, and NOTHING ELSE of the portal goes with it. The
// artifact therefore says exactly which files those are, in both directions - a missing file
// is a playground that does not start, a spare one is the portal's own code served from the
// origin whose whole purpose is that visitor Python cannot reach the portal. The list is a
// closure over the bundler's own record - the child page's `<script src>` and
// `<link rel=stylesheet>`, then the transitive closure of that entry chunk's static and
// dynamic imports and their stylesheets - rather than over file names, so a chunk split
// differently next release is still found. The Worker is handled by name because
// `@freva-org/browser-python` emits it BESIDE the module graph: no chunk imports it and no
// closure reaches it, and a playground deployed without it has nowhere to run its interpreter.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GraphRecord } from "./evidence.js";
import type { PlaygroundArtifactData } from "../model/types.js";
import { compareCodePoints } from "../util/order.js";
import { NOTEBOOK_ARTIFACT_DIR, NOTEBOOK_PATH, underBase } from "../model/notebook.js";
import { ADDONS_DIR, WHEELHOUSE_DIR } from "../model/python-materials.js";
import { callbackPolicy } from "./same-origin.js";

/** Emitted names that belong to the child and reach it through no import edge. */
const EMITTED_BESIDE = ["browser-python.worker"];

/**
 * The artifact files a document LOADS: `src` of scripts, images and media, `href` of `<link>`s.
 * Never an `<a href>`, which is navigation (the callback's "Back to the notebook"), not a file
 * the page needs. URLs carry the deployment's base path; the artifact's paths do not.
 */
function referencedByHtml(html: string, basePath: string): string[] {
  const out = new Set<string>();
  const base = basePath.endsWith("/") ? basePath : `${basePath}/`;
  const tags = /<(script|img|source|link)\b([^>]*)>/gi;
  for (let m = tags.exec(html); m; m = tags.exec(html)) {
    const attr = m[1]!.toLowerCase() === "link" ? "href" : "src";
    const value = new RegExp(`\\b${attr}\\s*=\\s*"([^"]+)"`, "i").exec(m[2] ?? "")?.[1] ?? "";
    if (!value.startsWith(base)) continue;
    out.add(value.slice(base.length));
  }
  return [...out];
}

export interface PlaygroundDeployment {
  schemaVersion: 1;
  /** The origin this is to be served from, exactly as configured. */
  origin: string;
  /** The portal origin the child will answer, and nothing else. */
  hostOrigin: string;
  /**
   * The path this origin serves the deployment under: the portal's base path, which the compiler
   * wrote into every URL of these pages. Files go to `<root><basePath><path>`.
   */
  basePath: string;
  /** The document to serve at `basePath`. */
  entry: string;
  /**
   * The notebook's shared sign-in callback document, served at `callbackPath` on this origin.
   * Absent when the notebook signs in to nothing.
   */
  callback?: { path: string; file: string };
  /** Every artifact-relative file to copy, the entry included. Sorted, exact. */
  files: string[];
  /** Response headers the child origin must send. */
  headers: Record<string, string>;
  /**
   * Headers for paths under a prefix, replacing `headers` there: the notebook (`/notebook/`) is
   * a top-level page with a Content-Security-Policy of its own. Absent without a notebook.
   */
  pathHeaders?: Record<string, Record<string, string>>;
  /** How many examples the deployed manifest registers. */
  registeredExamples: number;
}

/**
 * The child origin's own Content Security Policy, written here rather than left to the
 * deployment because every value in it is a consequence of how the child was built, which the
 * deployment cannot know. `frame-ancestors` is the portal and only the portal - a playground
 * any page could frame is a playground any page could ask to run something. `script-src 'self'`
 * needs no `'unsafe-inline'` because the configuration and the manifest travel as
 * `application/json` blocks; `'wasm-unsafe-eval'` is what a WebAssembly interpreter needs, and
 * `worker-src 'self' blob:` is what Pyodide's own loader needs. `connect-src` reaches the
 * runtime CDN the profile pins, and `default-src 'none'` refuses anything not named here
 * rather than allowing it by omission.
 */
function childCsp(playground: PlaygroundArtifactData): string {
  const runtime = new URL(playground.runtimeIndexUrl).origin;
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${playground.hostOrigin}`,
    // The RUNTIME'S ORIGIN is in `script-src` as well as `connect-src`, because `pyodide.mjs`
    // is a module the interpreter imports - a script, from another origin - not only bytes it
    // fetches. Naming it in `connect-src` alone gives a playground that downloads its own
    // runtime and is then refused permission to run it.
    `script-src 'self' 'wasm-unsafe-eval' ${runtime}`,
    "worker-src 'self' blob:",
    "style-src 'self'",
    // `style-src-attr 'unsafe-inline'`, and only the attribute form. jQuery Terminal builds
    // its own markup and sets style ATTRIBUTES on it - cursor position, measured character
    // widths - which `style-src 'self'` refuses; without this the console loads, renders and
    // is unusable, the caret in the wrong place and the terminal unable to measure itself.
    // This is the narrowest grant that fixes it: `style-src` itself stays `'self'`, so no
    // `<style>` element and no stylesheet from anywhere else is permitted. The portal's own
    // policy carries the same grant for the same reason when the playground is same-origin.
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    // THE STORAGE ORIGINS THE EXAMPLES READ, and nothing beyond them. A registered recipe for
    // a live store is a program that opens that store: the interpreter fetches its metadata
    // and chunks over HTTP from the gateway the dataset tree is configured against, and under
    // `default-src 'none'` that fetch is refused unless the origin is named - invisibly, since
    // the run simply raises. These are the origins the portal's own policy already carries for
    // the tree's listings, so the child is never reachable anywhere the parent was not, plus
    // the deployment's allowlist and the resolved PACKAGE POLICY's origins - the same policy
    // object the parent's `connect-src` and the terminal's package help are written from, so
    // the three cannot describe it differently. The open policy adds `https:`: a scheme
    // source, any TLS origin and never plaintext, with no other directive touched, so nothing
    // new may be EXECUTED, only fetched - `*` would also carry `ws:`, `data:` and plaintext.
    // This directive matters most in the two-origin topology: the Worker that runs the
    // visitor's Python is on THIS origin, under THIS policy.
    `connect-src 'self' ${runtime} ${[
      ...(playground.dataOrigins ?? []),
      ...(playground.connectOrigins ?? []),
      ...(playground.packageOrigins ?? []),
      ...(playground.anyHttpsOrigin ? ["https:"] : []),
    ]
      .filter((origin, index, all) => all.indexOf(origin) === index)
      .sort()
      .join(" ")} data: blob:`
      .replace(/ {2,}/g, " ")
      .trim(),
  ].join("; ");
}

/**
 * Describe the deployment, or return `undefined` when there is no playground origin.
 * `entryHtml` is read from the finished artifact rather than predicted: the emitted document
 * is the authority on what it loads, the same rule the budget model follows.
 */
export function describePlaygroundDeployment(
  playground: PlaygroundArtifactData | undefined,
  artifactDir: string,
  graph: GraphRecord,
  emittedFiles: readonly string[],
  notebook?: { csp: string },
): PlaygroundDeployment | undefined {
  if (!playground) return undefined;
  const basePath = playground.basePath ?? "/";
  const entry = "playground-origin/index.html";
  let html: string;
  try {
    html = readFileSync(join(artifactDir, ...entry.split("/")), "utf8");
  } catch {
    return undefined;
  }

  const wanted = new Set<string>([entry]);
  const byFile = new Map(graph.chunks.map((chunk) => [chunk.file, chunk]));
  const queue: string[] = [];
  const documents = [html];
  // The shared sign-in callback, with what it loads.
  let callback: { path: string; file: string } | undefined;
  let callbackCsp = "";
  if (playground.authCallbackPath) {
    const file = `playground-origin/${playground.authCallbackPath.replace(/^\/+/, "")}index.html`;
    try {
      const page = readFileSync(join(artifactDir, ...file.split("/")), "utf8");
      documents.push(page);
      callbackCsp = callbackPolicy(page).header;
      wanted.add(file);
      callback = { path: underBase(basePath, playground.authCallbackPath), file };
    } catch {
      return undefined;
    }
  }
  for (const ref of documents.flatMap((page) => referencedByHtml(page, basePath))) {
    wanted.add(ref);
    if (ref.endsWith(".js")) queue.push(ref);
  }

  // The closure, over both edge kinds: a dynamic import is exactly how the console, the engine
  // and the bridge are reached.
  while (queue.length > 0) {
    const file = queue.pop()!;
    const chunk = byFile.get(file);
    if (!chunk) continue;
    for (const css of chunk.css ?? []) wanted.add(css);
    for (const next of [...(chunk.imports ?? []), ...(chunk.dynamicImports ?? [])]) {
      if (wanted.has(next)) continue;
      wanted.add(next);
      queue.push(next);
    }
  }

  for (const name of EMITTED_BESIDE) {
    for (const file of emittedFiles) {
      // The bundler's own, never the notebook's copy of the same Worker (a same-origin notebook
      // is the portal's, and a separate one is listed whole below).
      if (file.startsWith(`${NOTEBOOK_PATH}/`) || file.startsWith(`${NOTEBOOK_ARTIFACT_DIR}/`)) {
        continue;
      }
      if (file.split("/").pop()?.startsWith(name)) wanted.add(file);
    }
  }
  // The Python materials this build serves itself (add-ons, the Freva wheels): the interpreters on
  // this origin - a framed console, the notebook's kernel - ask for them at a root-relative path,
  // which is this origin. Left out, every add-on is a 404 there.
  for (const file of emittedFiles) {
    if (file.startsWith(`${ADDONS_DIR}/`) || file.startsWith(`${WHEELHOUSE_DIR}/`))
      wanted.add(file);
  }
  // The notebook site, whole: it was checked against its inventory when the build took it.
  if (notebook) {
    for (const file of emittedFiles) {
      if (file.startsWith(`${NOTEBOOK_ARTIFACT_DIR}/`)) wanted.add(file);
    }
  }

  return {
    schemaVersion: 1,
    origin: playground.origin,
    hostOrigin: playground.hostOrigin,
    basePath,
    entry,
    ...(callback ? { callback } : {}),
    files: [...wanted].sort(compareCodePoints),
    headers: {
      "Content-Security-Policy": childCsp(playground),
      // Cross-origin isolation is NOT requested, and that is a decision rather than an
      // omission. `SharedArrayBuffer` would need it, and requiring it of the deployment would
      // also require every asset the interpreter fetches to carry CORP headers, including the
      // runtime CDN's. The engine runs without it; a deployment that wants it can add the two
      // headers itself.
      "Cross-Origin-Resource-Policy": "same-origin",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
    ...(notebook || callback
      ? {
          pathHeaders: {
            ...(notebook
              ? {
                  [underBase(basePath, `${NOTEBOOK_PATH}/`)]: {
                    "Content-Security-Policy": notebook.csp,
                    "Cross-Origin-Resource-Policy": "same-origin",
                    "Referrer-Policy": "no-referrer",
                    "X-Content-Type-Options": "nosniff",
                  },
                }
              : {}),
            // The callback receives authorization responses: never cached, never framed, never
            // referred on, and nothing but its own script.
            ...(callback
              ? {
                  [callback.path]: {
                    "Content-Security-Policy": callbackCsp,
                    "Cache-Control": "no-store",
                    "Cross-Origin-Resource-Policy": "same-origin",
                    "Referrer-Policy": "no-referrer",
                    "X-Content-Type-Options": "nosniff",
                  },
                }
              : {}),
          },
        }
      : {}),
    registeredExamples: playground.examples.length,
  };
}

/** The human half of the same thing: what to copy, where, and with which headers. */
export function playgroundDeployReadme(deployment: PlaygroundDeployment): string {
  const headers = Object.entries(deployment.headers)
    .map(([name, value]) => `    ${name}: ${value}`)
    .join("\n");
  // Everything goes under the deployment's base path on that origin.
  const root = `<playground-root>${deployment.basePath.replace(/\/+$/, "")}`;
  const notebookPrefix = underBase(deployment.basePath, `${NOTEBOOK_PATH}/`);
  return `# Deploying this playground

This directory is NOT part of the portal's own site. It is the separate-origin Python playground,
and it belongs at:

    ${deployment.origin}${deployment.basePath}

Serve \`index.html\` as the document at \`${deployment.basePath}\` on that origin - the portal's own base
path, which the pages' URLs already carry - with the files listed in \`deploy.json\` at the same
paths under it. Nothing else from the portal artifact goes to this origin - that separation is the
entire reason the playground has an origin of its own.

## Copy exactly these files

\`deploy.json\` lists them, artifact-relative and complete:

    jq -r '.files[]' <artifact>/playground-origin/deploy.json \\
      | rsync -a --files-from=- <artifact>/ ${root}/
    mv ${root}/playground-origin/index.html ${root}/index.html${
      deployment.pathHeaders?.[notebookPrefix]
        ? `\n    mv ${root}/${NOTEBOOK_ARTIFACT_DIR} ${root}/${NOTEBOOK_PATH}`
        : ""
    }${
      deployment.callback
        ? `\n    mkdir -p <playground-root>${deployment.callback.path}` +
          `\n    mv ${root}/${deployment.callback.file} <playground-root>${deployment.callback.path}index.html`
        : ""
    }

${deployment.files.length} files, registering ${deployment.registeredExamples} example${
    deployment.registeredExamples === 1 ? "" : "s"
  }.

## Headers this origin must send

${headers}

\`frame-ancestors\` names the portal and only the portal. A playground any page can frame is a
playground any page can ask to run something.
${
  deployment.callback
    ? `\n## The sign-in callback\n\nThe notebook signs in through a popup that returns to ${deployment.origin}${deployment.callback.path}\n(the same path as the portal's own callback). Register that URL with the identity provider as a\nredirect URI and a post-logout redirect URI, and in freva-rest's redirect allow-list. The old\n${deployment.origin}${notebookPrefix}freva-login-callback.html stays in the notebook during the migration.\n`
    : ""
}${
    deployment.pathHeaders
      ? Object.entries(deployment.pathHeaders)
          .map(
            ([prefix, values]) =>
              `\n## Headers under ${prefix}\n\nServed with these headers INSTEAD of the ones above:\n\n${Object.entries(
                values,
              )
                .map(([name, value]) => `    ${name}: ${value}`)
                .join("\n")}\n`,
          )
          .join("")
      : ""
  }
## What this playground will and will not do

It answers three questions from ${deployment.hostOrigin}: what artifacts exist, send me one, and
run the example you know by this name. A run request carries an id and a SHA-256 and never source;
both are resolved against \`examples\` in this document, and a request naming an unknown id - or a
known one under a digest this build did not register - is refused. The manifest's digests are
verified against their own sources before the interpreter module is imported at all.
`;
}
