/**
 * @vitest-environment happy-dom
 *
 * Highlighting and display rendering: the two places where Python-authored strings become DOM.
 * These are the package's security-critical console paths, so most of what follows is about what
 * must NOT happen - no markup parsed, no HTML MIME accepted, no mislabelled bytes handed to an
 * `<img>`. The rest checks that the tokens concatenate back to exactly the source, because a
 * highlighter that drops a character no longer lines up with the caret.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendHighlighted,
  highlightedElement,
  tokenClassesPerCharacter,
} from "../../src/console/highlight.js";
import {
  decodeBase64,
  looksLikePng,
  registerDisplayRenderer,
  registeredDisplayMimes,
  renderDisplay,
} from "../../src/console/display-renderers.js";
import { validateDisplay } from "../../src/protocol.js";

/** A real 1x1 PNG. */
const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const render = (source: string) => highlightedElement(source, document);

describe("syntax highlighting", () => {
  // The invariant that matters more than any colour: the rendered text IS the source. A tokeniser
  // that lost a space would produce a command that looks right and is not the one that will run.
  it.each([
    "import xarray as xr",
    "ds = xr.open_zarr(URL, consolidated=True, chunks=None)",
    '# Load one timestep\nwind = ds["sfcWind"].isel(time=0)',
    "def square(value):\n    return value ** 2",
    "# a comment with \"quotes\" and 'apostrophes'",
    'value = [["a", "b"], ["c", "d"]]',
    'path = "C:\\\\Users\\\\x"',
    's = "héllo - ünïcode ✓"',
    'q = """triple\nquoted"""',
    "    indented = True",
    "",
  ])("renders %j back as exactly itself", (source) => {
    expect(render(source).textContent).toBe(source);
  });

  it("gives keywords, strings, comments, numbers and functions their own token classes", () => {
    const element = render('# note\ndef square(value):\n    return "x" * 2');
    const classes = [...element.querySelectorAll("span")].map((s) => s.className);
    expect(classes).toContain("bp-tok-comment");
    expect(classes).toContain("bp-tok-keyword");
    expect(classes).toContain("bp-tok-string");
    expect(classes).toContain("bp-tok-number");
    expect(classes).toContain("bp-tok-function");
  });

  // The classes are THIS package's, not Prism's. A consumer styling `.token.keyword` would be
  // depending on a third party's internals; this keeps the theming contract honest.
  it("emits no Prism class names at all", () => {
    const element = render("class Thing:\n    pass");
    for (const span of element.querySelectorAll("span")) {
      expect(span.className.startsWith("bp-tok-"), span.className).toBe(true);
    }
  });

  it("does not break on a quote inside a comment", () => {
    const source = "# don't modify this comment\nvalue = 1";
    expect(render(source).textContent).toBe(source);
  });

  // HTML in Python source must arrive as TEXT nodes, never as parsed markup. `innerHTML` would
  // make this an injection; `createTextNode` makes it a string with angle brackets in it.
  it("cannot inject HTML from Python source", () => {
    const element = render('print("<img src=x onerror=alert(1)>")');
    expect(element.querySelector("img")).toBeNull();
    expect(element.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("cannot inject a script element either", () => {
    const element = render("s = '</span><script>alert(1)</script>'");
    expect(element.querySelector("script")).toBeNull();
    expect(element.textContent).toContain("<script>alert(1)</script>");
  });

  it("appendHighlighted reports how many characters it emitted", () => {
    const host = document.createElement("div");
    const source = "x = 1";
    expect(appendHighlighted(host, source, document)).toBe(source.length);
  });

  it("exposes the command as ONE coherent string to assistive technology", () => {
    // No roles, no aria-hidden, no separators: the accessible name of the container is the command.
    const element = render("import xarray as xr");
    expect(element.textContent).toBe("import xarray as xr");
    expect(element.querySelector("[aria-hidden]")).toBeNull();
    expect(element.querySelector("[role]")).toBeNull();
  });
});

// The per-character map is what makes LIVE highlighting possible: the surface owns the command
// line and rebuilds it one element per character, so colouring it means adding a class to
// elements that already exist rather than replacing markup - nothing goes near `innerHTML` or the
// library's own formatting syntax. It is only usable if the map is exactly as long as the source.
describe("per-character token map", () => {
  it.each([
    "x = 1",
    "import xarray as xr",
    "name = f\"{ds.attrs['title']!r}\"",
    'q = """triple\nquoted"""',
    "def square(value):\n    return value ** 2",
    "# a comment with 'quotes'",
    "s = 'héllo - ünïcode ✓'",
    "path = 'C:\\\\Users\\\\x'",
    "regex = r'\\d+[[a-z]]'",
  ])("maps exactly one class slot per character of %j", (source) => {
    expect(tokenClassesPerCharacter(source)?.length).toBe(source.length);
  });

  it("uses this package's own class names, never Prism's", () => {
    const classes = tokenClassesPerCharacter("def f(): pass") ?? [];
    for (const name of classes) {
      if (name !== null) expect(name.startsWith("bp-tok-"), name).toBe(true);
    }
  });

  it("gives the innermost token the character, so an f-string's expression is not just string", () => {
    const source = 'f"{value}"';
    const classes = tokenClassesPerCharacter(source) ?? [];
    // Whatever the categories, every character is accounted for and the quotes are string.
    expect(classes).toHaveLength(source.length);
    expect(classes[1]).toBe("bp-tok-string");
  });

  it("returns null for an empty source rather than an empty map", () => {
    // The caller's contract is "a map, or nothing"; an empty array would be a map of a line with
    // no characters, a distinction without a difference and easy to get wrong.
    expect(tokenClassesPerCharacter("")).toBeNull();
  });

  it("marks a comment's characters, including the ones after the hash", () => {
    const source = "x = 1  # why";
    const classes = tokenClassesPerCharacter(source) ?? [];
    expect(classes[source.indexOf("#")]).toBe("bp-tok-comment");
    expect(classes[source.length - 1]).toBe("bp-tok-comment");
  });
});

describe("display rendering", () => {
  const context = () => {
    const urls: string[] = [];
    return { urls, ctx: { document, track: (url: string) => urls.push(url) } };
  };

  beforeEach(() => {
    // happy-dom has no object-URL implementation worth relying on; a stub keeps the assertions
    // about OUR behaviour rather than about the environment's.
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:fake-url"),
      revokeObjectURL: vi.fn(),
    });
  });

  it("registers exactly two MIME types, and no more", () => {
    // The allow-list IS the security boundary. If this grows, it grew deliberately.
    expect(registeredDisplayMimes()).toEqual(["image/png", "text/plain"]);
  });

  it("builds an <img> in a <figure> for a PNG", () => {
    const { urls, ctx } = context();
    const element = renderDisplay(
      { mime: "image/png", encoding: "base64", data: TINY_PNG, metadata: { figure: 3 } },
      ctx,
    );
    const image = element?.querySelector("img");
    expect(image).toBeTruthy();
    expect(image?.getAttribute("src")).toBe("blob:fake-url");
    expect(image?.getAttribute("alt")).toBe("Matplotlib figure 3");
    expect(urls).toEqual(["blob:fake-url"]);
  });

  it("offers a download with a meaningful filename", () => {
    const { ctx } = context();
    const link = renderDisplay(
      { mime: "image/png", encoding: "base64", data: TINY_PNG, metadata: { figure: 2 } },
      ctx,
    )?.querySelector("a");
    expect(link?.getAttribute("download")).toBe("figure-2.png");
  });

  // "Declared image/png" and "is a PNG" are different claims. An `<img>` handed a mislabelled
  // blob renders a broken icon and explains nothing, so the magic bytes are checked.
  it("refuses bytes that are not actually a PNG", () => {
    const { ctx } = context();
    const notPng = btoa("this is definitely not a png");
    expect(renderDisplay({ mime: "image/png", encoding: "base64", data: notPng }, ctx)).toBeNull();
  });

  it("refuses a PNG that claims to be utf8", () => {
    const { ctx } = context();
    expect(renderDisplay({ mime: "image/png", encoding: "utf8", data: TINY_PNG }, ctx)).toBeNull();
  });

  it("renders text/plain as textContent in a <pre>", () => {
    const { ctx } = context();
    const element = renderDisplay(
      { mime: "text/plain", encoding: "utf8", data: "<b>not markup</b>" },
      ctx,
    );
    expect(element?.tagName).toBe("PRE");
    expect(element?.querySelector("b")).toBeNull();
    expect(element?.textContent).toBe("<b>not markup</b>");
  });

  // The two MIME types this console will never render. Both carry script, and the payload was
  // authored by whatever Python the visitor typed.
  it.each(["text/html", "image/svg+xml", "application/javascript"])("refuses %s", (mime) => {
    const { ctx } = context();
    expect(
      renderDisplay({ mime, encoding: "utf8", data: "<svg onload=alert(1)>" }, ctx),
    ).toBeNull();
  });

  it("decodeBase64 returns null rather than throwing on garbage", () => {
    expect(decodeBase64("not base64!!")).toBeNull();
  });

  it("looksLikePng checks the signature, not the length", () => {
    expect(looksLikePng(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      true,
    );
    expect(looksLikePng(new Uint8Array([1, 2, 3]))).toBe(false);
  });

  it("a registered renderer can be added for a new MIME type", () => {
    registerDisplayRenderer("text/csv", (output, ctx) => {
      const pre = ctx.document.createElement("pre");
      pre.textContent = output.data;
      return pre;
    });
    const { ctx } = context();
    expect(
      renderDisplay({ mime: "text/csv", encoding: "utf8", data: "a,b" }, ctx)?.textContent,
    ).toBe("a,b");
    expect(registeredDisplayMimes()).toContain("text/csv");
  });

  // …but registering one does NOT make that MIME type arrive. The worker validates every display
  // payload against the protocol's short list before posting it and the engine validates it
  // again on arrival, so a renderer for `text/csv` is never called. Widening the set is a change
  // to `DISPLAY_MIMES`, with a threat model attached.
  it("registering a renderer does not widen what the protocol will carry", () => {
    registerDisplayRenderer("text/csv", (output, ctx) => {
      const pre = ctx.document.createElement("pre");
      pre.textContent = output.data;
      return pre;
    });
    const refused = validateDisplay({ mime: "text/csv", encoding: "utf8", data: "a,b" });
    expect(refused.ok).toBe(false);
    expect(registeredDisplayMimes()).toContain("text/csv");
  });
});
