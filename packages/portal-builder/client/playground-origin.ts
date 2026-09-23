/**
 * The CHILD half of a two-origin playground: the only script in the generated playground document.
 *
 * The document is deployed at the origin the portal's `dataset-tree.python` configuration names
 * and is not part of the portal - no shell, no navigation, no theme, no portal entry module. It
 * contains an interpreter, a console, and the bridge that answers the portal's three questions:
 * what artifacts exist, send me one, run the example you know by this name.
 *
 * THE PARENT CANNOT SEND PYTHON. It sends an id and a digest, both resolved against the manifest
 * THIS BUILD wrote into the document beside this script; an unknown id, or a known id under a
 * digest this build did not register it under, is refused and said so. It is enforced before
 * anything else can run - the manifest is parsed and every entry's digest checked against its own
 * source BEFORE the console module is imported and before an interpreter exists. A manifest that
 * is wrong about one snippet is a wrong manifest, so the document refuses to start at all.
 *
 * WHAT IT NEVER DOES: read a message's source, accept a manifest from the parent, post to `"*"`.
 * The portal's exact origin is compiled in, and a message from any other origin is dropped.
 */

import type { BrowserPythonAddon, BrowserPythonProfile } from "@freva-org/browser-python";
import type { PlaygroundArtifactData } from "../src/model/types.js";

/**
 * The child document's own layout, adopted at run time rather than linked: fill the frame, let the
 * console have the space, and say something when there is something to say. A constructable
 * stylesheet because a `<style>` block in the page template becomes a stylesheet asset in EVERY
 * portal's artifact, playground or not, and an inline `<style>` element is refused by the strict
 * `style-src 'self'` this document is served under.
 */
const CSS = `
:root { color-scheme: light dark; }
html, body { margin: 0; height: 100%; background: transparent; font: 14px/1.5 system-ui, sans-serif; }
#playground-root { display: flex; flex-direction: column; height: 100%; min-height: 0; }
#playground-root > * { flex: 1 1 auto; min-height: 0; }
#playground-status { margin: 0; padding: 0.4rem 0.6rem; font-size: 0.78rem; }
#playground-status[data-tone="error"] { background: rgba(255, 154, 139, 0.18); }
`;

function adoptStyles(): void {
  try {
    if (typeof CSSStyleSheet === "function" && Array.isArray(document.adoptedStyleSheets)) {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      return;
    }
  } catch {
    // an engine that has the API and refuses the sheet falls through to the element
  }
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.append(style);
}

/** The element the console module defines, as much of it as this document uses. */
interface ConsoleElement extends HTMLElement {
  start(): Promise<void>;
  execute(source: string): Promise<void>;
  runExample(example: { title: string; source: string }): Promise<void>;
  transcript(): string;
  clear(): void;
  clearHistory(): void;
  restart(): Promise<void>;
  engine?: unknown;
}

/** Say something in the document itself. A child page has no console a visitor can read. */
function status(message: string, tone: "info" | "error" = "info"): void {
  const line = document.getElementById("playground-status");
  if (!line) return;
  line.textContent = message;
  line.dataset.tone = tone;
  line.hidden = false;
}

/**
 * The build's own configuration, carried as DATA. A `<script type="application/json">` is not
 * executed by any browser and needs nothing from `script-src`, which is what lets the child
 * document run under a policy with no inline script at all - the mechanism the portal uses for a
 * catalogue.
 */
function readJson(id: string): unknown {
  const node = document.getElementById(id);
  if (!node) throw new Error(`the playground document is missing its ${id} block`);
  return JSON.parse(node.textContent ?? "");
}

export async function startPlaygroundOrigin(): Promise<void> {
  adoptStyles();
  let config: PlaygroundArtifactData;
  let manifestRaw: unknown;
  try {
    config = readJson("playground-config") as PlaygroundArtifactData;
    manifestRaw = readJson("playground-examples");
  } catch (error) {
    status(`This playground could not read its own configuration: ${String(error)}`, "error");
    return;
  }

  // VERIFICATION FIRST, and nothing heavy is imported until it passes.
  // `@freva-org/browser-python/embed` is the registry and the bridge and pulls in neither the
  // console, jQuery Terminal, Prism nor the engine - so this import is small, the check runs
  // against the manifest alone, and a build whose manifest disagrees with itself never reaches
  // the point of having an interpreter to misuse.
  const {
    createExampleRegistry,
    parseExampleManifest,
    verifyExampleManifest,
    attachPlaygroundBridge,
  } = await import("@freva-org/browser-python/embed");

  let registry;
  try {
    const examples = parseExampleManifest(manifestRaw);
    await verifyExampleManifest(examples);
    registry = createExampleRegistry(examples);
  } catch (error) {
    status(
      "This playground's example manifest failed verification and it will not run anything: " +
        (error instanceof Error ? error.message : String(error)),
      "error",
    );
    return;
  }

  const [{ defineBrowserPythonConsole }, { createBrowserPython }] = await Promise.all([
    import("@freva-org/browser-python/console"),
    import("@freva-org/browser-python"),
  ]);
  defineBrowserPythonConsole();

  // The engine is created HERE and injected rather than left to the element. The bridge holds one
  // engine reference for the life of the document - which is what makes an artifact list and a
  // streaming download survive a restart - and an element that owns its engine REPLACES the object
  // on `restart()`, leaving the bridge announcing a dead one. An injected engine is restarted in
  // place instead, which is the behaviour the element documents.
  // The profile name is the build's, already validated against the schema's closed list; the cast
  // is the boundary between a JSON string and the package's own union.
  const engine = createBrowserPython({
    profile: config.profile as BrowserPythonProfile,
    // The build's own answer: the deployment's mirror or the pinned CDN. The child's
    // Content-Security-Policy in `deploy.json` names whichever this is.
    ...(config.runtimeIndexUrl ? { pyodide: { indexURL: config.runtimeIndexUrl } } : {}),
    // The wheels, the add-ons and the credential setting: the build's answers, PROPERTIES on the
    // engine rather than attributes on the element. The element reflects `profile`, `autostart`
    // and `toolbar` and nothing else, so a `setAttribute` for `wheelhouseURL`, `addonBaseURL`,
    // `addons` or `persistCredentials` sets nothing. Given to the engine before `start()`, which
    // is the only moment any of them is read.
    ...(config.wheelhouseUrl ? { wheelhouseURL: config.wheelhouseUrl } : {}),
    ...(config.addonBaseUrl ? { addonBaseURL: config.addonBaseUrl } : {}),
    ...(config.addons && config.addons.length > 0
      ? { addons: config.addons as BrowserPythonAddon[] }
      : {}),
    ...(config.persistCredentials ? { persistCredentials: true } : {}),
  });

  const element = document.createElement("freva-python-console") as ConsoleElement;
  element.setAttribute("profile", config.profile);
  element.setAttribute("autostart", "false");
  element.setAttribute("toolbar", "status");
  element.engine = engine;
  document.getElementById("playground-root")?.append(element);

  let starting: Promise<void> | null = null;
  /**
   * Bring the interpreter up and run the portal's opening lines into it. As in a same-origin
   * session, `initialSource` runs INSIDE this promise, so an example queued behind a first press
   * cannot reach the interpreter ahead of it.
   */
  const start = (): Promise<void> => {
    if (!starting) {
      status("Starting Python…");
      starting = element
        .start()
        .then(async () => {
          if (config.initialSource) await element.execute(config.initialSource);
          status("Python is ready");
        })
        .catch((error: unknown) => {
          starting = null;
          status(error instanceof Error ? error.message : String(error), "error");
          throw error;
        });
    }
    return starting;
  };

  // The bridge is attached once the console exists, because the parent's `welcome` is the signal
  // that this document is ready to be asked for something.
  attachPlaygroundBridge({
    engine,
    hostOrigin: config.hostOrigin,
    examples: registry,
    onRunExample: async (example) => {
      await start();
      await element.runExample({ title: example.title, source: example.source });
    },
    // The four bounded operations, wired to the console in this document. The parent cannot read
    // this transcript, clear it, or bring up a new interpreter, because it cannot reach into
    // another origin's document. Each arrives as a NAME with no arguments, and what the name
    // means is decided here.
    transcript: () => element.transcript(),
    onClearTranscript: () => element.clear(),
    onClearHistory: () => element.clearHistory(),
    // A restart keeps the DOCUMENT, and therefore the session. Reloading the frame is a different
    // thing: it invalidates the session, so everything the parent holds against it - the artifact
    // list, a download in flight - has to be torn down and rebuilt.
    onRestart: async () => {
      starting = null;
      await element.restart();
      if (config.initialSource) await element.execute(config.initialSource);
      status("Python is ready");
    },
  });
  status("Ready");
}
