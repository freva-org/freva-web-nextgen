/**
 * Runnable code blocks, as a playground provider.
 *
 * The build already did the hard part: every marked block has an identity and a digest, and the
 * page already contains the exact source, in the copy control. This module puts those two facts
 * together and refuses to enable a button whose source no longer hashes to what the build
 * approved.
 *
 * THE SOURCE IS RECONSTRUCTED RATHER THAN SHIPPED AGAIN, so a page with twelve runnable snippets
 * does not carry each of them twice - once to read and once to run - with a second copy that can
 * disagree with the first. The reconstruction is not trusted: it is checked against a digest the
 * BUILD computed, so a page whose markup was edited afterwards by an injection, a proxy or a
 * well-meant find-and-replace keeps its Try controls hidden. `button.dataset` is a hint about
 * where to find the source, never the command.
 */

import {
  registerPythonBlock,
  type ExampleSource,
  type PythonPlaygroundConfig,
} from "../python-bridge.js";
import { tryPython } from "../python-bridge.js";

/** The one element the build stamps on a page that has something runnable on it. */
const HOST = "[data-portal-python-playground]";

const hex = (buffer: ArrayBuffer): string =>
  [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

async function digestOf(source: string): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  // No Web Crypto, no Try. An insecure context cannot verify anything, and a control that ran
  // unverified page text is what this check exists to prevent - so the button stays hidden and
  // Copy, which needs none of this, keeps working.
  if (!subtle) return null;
  return hex(await subtle.digest("SHA-256", new TextEncoder().encode(source)));
}

/**
 * Find the runnable blocks, verify them, and register them as one provider. Returns a promise the
 * entry chains on: the playground must not be prepared until the sources are registered, or the
 * first press finds an empty registry. Nothing here loads the interpreter, the console or the
 * terminal - a page with a Try button that nobody presses fetches none of them.
 */
export async function mountRunnableCode(): Promise<void> {
  const host = document.querySelector<HTMLElement>(HOST);
  if (!host) return;
  const raw = host.getAttribute("data-portal-python-playground");
  if (!raw) return;
  let config: PythonPlaygroundConfig;
  try {
    config = JSON.parse(raw) as PythonPlaygroundConfig;
  } catch {
    return;
  }

  const approved = new Map(config.examples.map((example) => [example.id, example]));
  const sources = new Map<string, ExampleSource>();
  const buttons = [...document.querySelectorAll<HTMLButtonElement>("button[data-portal-run]")];

  for (const button of buttons) {
    const id = button.getAttribute("data-portal-example");
    const stamped = button.getAttribute("data-portal-digest");
    if (!id || !stamped) continue;
    const registered = approved.get(id);
    // THREE THINGS HAVE TO AGREE, and the build's answer decides: the id must be one the build
    // registered, the digest on the button must be the one the build recorded for it, and the
    // source in the copy control must hash to that same digest. A page satisfying two of the
    // three has been changed since it was built.
    if (!registered || registered.sha256 !== stamped) continue;
    const copy = button
      .closest(".portal-code-figure")
      ?.querySelector<HTMLElement>("[data-portal-copy]");
    const source = copy?.getAttribute("data-portal-copy");
    if (source === null || source === undefined) continue;
    const computed = await digestOf(source);
    if (computed !== registered.sha256) continue;

    sources.set(id, { title: registered.title ?? id, source });
    button.hidden = false;
    button.addEventListener("click", () => {
      // A name and a digest - not the source, not the element, not anything the DOM could have
      // been talked into carrying. The coordinator resolves the id against the same registry this
      // function verified and refuses anything else. Focus is not moved here: the window remembers
      // what was focused when it opens and gives it back, so the visitor returns to THIS button.
      tryPython({ exampleId: id, digest: registered.sha256 });
    });
  }

  registerPythonBlock({ host, config, sources });
}
