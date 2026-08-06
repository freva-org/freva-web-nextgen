import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { DataInspectorElement } from "../src/elements/data-inspector";

beforeAll(() => {
  if (!customElements.get("data-inspector")) {
    customElements.define("data-inspector", DataInspectorElement);
  }
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function mount(attrs: Record<string, string> = {}): DataInspectorElement {
  const el = document.createElement("data-inspector") as DataInspectorElement;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  return el;
}

// ── Attribute accessors ──────────────────────────────────────────────────────

describe("attribute accessors", () => {
  it("open getter reflects attribute presence", () => {
    const el = mount();
    expect(el.open).toBe(false);
    el.setAttribute("open", "");
    expect(el.open).toBe(true);
  });

  it("open setter adds / removes attribute", () => {
    const el = mount();
    el.open = true;
    expect(el.hasAttribute("open")).toBe(true);
    el.open = false;
    expect(el.hasAttribute("open")).toBe(false);
  });

  it("file getter returns string for plain path", () => {
    const el = mount({ file: "/data/my.nc" });
    expect(el.file).toBe("/data/my.nc");
  });

  it("file getter parses JSON array", () => {
    const files = ["/a.nc", "/b.nc"];
    const el = mount({ file: JSON.stringify(files) });
    expect(el.file).toEqual(files);
  });

  it("file setter encodes array as JSON", () => {
    const el = mount();
    el.file = ["/a.nc", "/b.nc"];
    expect(el.getAttribute("file")).toBe(JSON.stringify(["/a.nc", "/b.nc"]));
  });

  it("file setter removes attribute when null", () => {
    const el = mount({ file: "/data/my.nc" });
    el.file = null;
    expect(el.hasAttribute("file")).toBe(false);
  });

  it("status defaults to ready when attribute absent", () => {
    const el = mount();
    expect(el.status).toBe("ready");
  });

  it("error getter returns null when absent", () => {
    const el = mount();
    expect(el.error).toBeNull();
  });

  it("error setter sets / removes attribute", () => {
    const el = mount();
    el.error = "something went wrong";
    expect(el.getAttribute("error")).toBe("something went wrong");
    el.error = null;
    expect(el.hasAttribute("error")).toBe(false);
  });

  it("zarrStatusCode getter parses integer", () => {
    const el = mount({ "zarr-status-code": "4" });
    expect(el.zarrStatusCode).toBe(4);
  });

  it("isAggregation reflects attribute presence", () => {
    const el = mount();
    expect(el.isAggregation).toBe(false);
    el.setAttribute("is-aggregation", "");
    expect(el.isAggregation).toBe(true);
  });
});

// ── Rendering ────────────────────────────────────────────────────────────────

describe("rendering", () => {
  it("renders nothing when not open", () => {
    const el = mount();
    expect(el.innerHTML.trim()).toBe("");
  });

  it("renders modal when open", () => {
    const el = mount({ open: "" });
    expect(el.querySelector("#nc-backdrop")).not.toBeNull();
  });

  it("renders close button when open", () => {
    const el = mount({ open: "" });
    expect(el.querySelector("#nc-close-btn")).not.toBeNull();
  });

  it("renders path input in single-file mode", () => {
    const el = mount({ open: "" });
    expect(el.querySelector("#nc-path-input")).not.toBeNull();
  });

  it("does not render path input in aggregation mode", () => {
    const el = mount({ open: "", "is-aggregation": "" });
    expect(el.querySelector("#nc-path-input")).toBeNull();
  });

  it("renders file list in aggregation mode", () => {
    const files = ["/a.nc", "/b.nc"];
    const el = mount({ open: "", "is-aggregation": "", file: JSON.stringify(files) });
    expect(el.innerHTML).toContain("/a.nc");
    expect(el.innerHTML).toContain("/b.nc");
  });

  it("renders error state", () => {
    const el = mount({
      open: "",
      status: "error",
      error: "File not found",
      "zarr-url": "https://z.example.com",
    });
    expect(el.innerHTML).toContain("File not found");
  });

  it("output setter triggers re-render", () => {
    const el = mount({ open: "", "zarr-url": "https://z.example.com" });
    el.output = "<table>metadata</table>";
    expect(el.innerHTML).toContain("metadata");
  });

  it("clears innerHTML when open is removed", () => {
    const el = mount({ open: "" });
    expect(el.innerHTML.trim()).not.toBe("");
    el.removeAttribute("open");
    expect(el.innerHTML.trim()).toBe("");
  });
});

// ── Events ───────────────────────────────────────────────────────────────────

describe("events", () => {
  it("emits inspector-close when close button is clicked", () => {
    const el = mount({ open: "" });
    const handler = vi.fn();
    el.addEventListener("inspector-close", handler);
    el.querySelector<HTMLButtonElement>("#nc-close-btn")!.click();
    expect(handler).toHaveBeenCalledOnce();
  });

  it("emits inspector-submit with file when load button is clicked", () => {
    const el = mount({ open: "", file: "/data/my.nc" });
    const handler = vi.fn();
    el.addEventListener("inspector-submit", handler);

    const input = el.querySelector<HTMLInputElement>("#nc-path-input")!;
    input.value = "/data/my.nc";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    el.querySelector<HTMLButtonElement>("#nc-load-btn")!.click();

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].detail.file).toBe("/data/my.nc");
  });

  it("emits inspector-submit on Enter key in path input", () => {
    const el = mount({ open: "" });
    const handler = vi.fn();
    el.addEventListener("inspector-submit", handler);

    const input = el.querySelector<HTMLInputElement>("#nc-path-input")!;
    input.value = "/data/enter.nc";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keypress", { key: "Enter", bubbles: true }));

    expect(handler).toHaveBeenCalledOnce();
  });

  it("emits inspector-close when backdrop is clicked", () => {
    const el = mount({ open: "" });
    const handler = vi.fn();
    el.addEventListener("inspector-close", handler);

    const backdrop = el.querySelector<HTMLElement>("#nc-backdrop")!;
    backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(handler).toHaveBeenCalledOnce();
  });

  it("emits inspector-submit with aggregationConfig in aggregation mode", () => {
    const files = ["/a.nc", "/b.nc"];
    const el = mount({ open: "", "is-aggregation": "", file: JSON.stringify(files) });
    const handler = vi.fn();
    el.addEventListener("inspector-submit", handler);

    el.querySelector<HTMLButtonElement>("#nc-aggregate-btn")!.click();

    expect(handler).toHaveBeenCalledOnce();
    const detail = handler.mock.calls[0][0].detail;
    expect(detail.aggregationConfig).not.toBeNull();
    expect(detail.file).toEqual(files);
  });

  it("auto-submits inspector-submit when opened with a file in single-file mode", () => {
    const el = mount({ file: "/auto.nc" });
    const handler = vi.fn();
    el.addEventListener("inspector-submit", handler);

    el.setAttribute("open", "");

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].detail.file).toBe("/auto.nc");
  });
});

// ── Tab switching ────────────────────────────────────────────────────────────

describe("tabs", () => {
  it("renders metadata and gridlook tab buttons when zarr-url is set", () => {
    const el = mount({ open: "", "zarr-url": "https://z.example.com", status: "ready" });
    el.output = "<table>data</table>";
    expect(el.querySelector('[data-tab="metadata"]')).not.toBeNull();
    expect(el.querySelector('[data-tab="gridlook"]')).not.toBeNull();
  });

  it("gridlook tab is disabled when output is not yet set", () => {
    const el = mount({ open: "", "zarr-url": "https://z.example.com", status: "loading" });
    const gridlookTab = el.querySelector<HTMLButtonElement>('[data-tab="gridlook"]')!;
    expect(gridlookTab.disabled).toBe(true);
  });

  it("metadata tab is active by default", () => {
    const el = mount({ open: "", "zarr-url": "https://z.example.com", status: "ready" });
    el.output = "<table>data</table>";
    expect(el.innerHTML).toContain("metadata");
  });
});

// ── Security ───────────────────────────────────────────────────────────────--

describe("security", () => {
  it("renders error as text, never as HTML (XSS)", () => {
    const el = mount({
      open: "",
      status: "error",
      "zarr-url": "https://z.example.com",
      error: '<img src=x onerror="window.__xss = 1">',
    });
    const msg = el.querySelector("#nc-error-msg");
    expect(msg).not.toBeNull();
    expect(msg!.querySelector("img")).toBeNull();
    expect(msg!.textContent).toContain("<img");
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined();
  });

  it("renders aggregation file paths as text, never as HTML (XSS)", () => {
    const el = mount({
      open: "",
      "is-aggregation": "",
      file: JSON.stringify(['<img src=x onerror="window.__xss2 = 1">', "/safe.nc"]),
    });
    const list = el.querySelector("#nc-file-list");
    expect(list).not.toBeNull();
    expect(list!.querySelector("img")).toBeNull();
    expect(list!.querySelectorAll("li").length).toBe(2);
    expect(list!.textContent).toContain("<img");
    expect((window as unknown as { __xss2?: number }).__xss2).toBeUndefined();
  });

  it("sets the iframe src via the DOM property without attribute injection (XSS)", () => {
    const malicious = 'https://z.example.com/store" onload="window.__xss3 = 1';
    const el = mount({ open: "", status: "ready", "zarr-url": malicious });
    el.output = "<table>meta</table>";
    el.querySelector<HTMLButtonElement>('[data-tab="gridlook"]')!.click();

    const iframe = el.querySelector<HTMLIFrameElement>("#nc-gridlook-iframe");
    expect(iframe).not.toBeNull();
    // The URL is assigned via the .src PROPERTY, so the embedded quote stays
    // inside the attribute value and cannot create a new `onload` attribute.
    expect(iframe!.getAttribute("onload")).toBeNull();
    expect(iframe!.getAttribute("sandbox")).toContain("allow-scripts");
    expect(iframe!.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(iframe!.getAttribute("src")).toBe(`https://gridlook.pages.dev/#${malicious}`);
    expect((window as unknown as { __xss3?: number }).__xss3).toBeUndefined();
  });

  it("passes the Zarr URL raw in the GridLook fragment (round-trips unchanged)", () => {
    // GridLook reads location.hash verbatim and does NOT decode it; encoding
    // the URL would make it fetch a mangled URL.
    const url = "https://data.example.com/zarr/store.zarr?token=abc&t=1";
    const el = mount({ open: "", status: "ready", "zarr-url": url });
    el.output = "<table>meta</table>";
    el.querySelector<HTMLButtonElement>('[data-tab="gridlook"]')!.click();

    const shown = el.querySelector("#nc-gridlook-url")!.textContent ?? "";
    const fragment = shown.slice(shown.indexOf("#") + 1);

    expect(shown).toBe(`https://gridlook.pages.dev/#${url}`);
    expect(fragment).toBe(url); // verbatim
    expect(fragment).not.toContain("%3A"); // not percent-encoded
    expect(fragment).not.toContain("%2F");
    expect(decodeURIComponent(fragment)).toBe(url); // decoding yields the original

    const iframe = el.querySelector<HTMLIFrameElement>("#nc-gridlook-iframe")!;
    const src = iframe.getAttribute("src") ?? "";
    expect(src.slice(src.indexOf("#") + 1)).toBe(url);
  });
});

// ── State invalidation ─────────────────────────────────────────────────────--

describe("state invalidation", () => {
  it("resets stale output / zarr-url / error when the file changes", () => {
    const el = mount({
      open: "",
      file: "/a.nc",
      "zarr-url": "https://z.example.com",
      status: "ready",
    });
    el.output = "<table>AAA-METADATA</table>";
    expect(el.innerHTML).toContain("AAA-METADATA");

    el.setAttribute("file", "/b.nc");

    expect(el.output).toBeNull();
    expect(el.hasAttribute("zarr-url")).toBe(false);
    expect(el.innerHTML).not.toContain("AAA-METADATA");
  });

  it("does not wipe an initially-provided file's derived state", () => {
    // Setting `file` for the first time (old value null) must not clear output.
    const el = mount({ open: "", "zarr-url": "https://z.example.com", status: "ready" });
    el.output = "<table>KEEP-ME</table>";
    el.setAttribute("file", "/first.nc"); // initial set: oldVal === null
    expect(el.output).toBe("<table>KEEP-ME</table>");
  });
});

// ── Persistence across re-render ───────────────────────────────────────────--

describe("render persistence", () => {
  it("never remounts the GridLook iframe on unrelated re-renders", () => {
    const el = mount({ open: "", status: "ready", "zarr-url": "https://z.example.com" });
    el.output = "<table>meta</table>";
    el.querySelector<HTMLButtonElement>('[data-tab="gridlook"]')!.click();

    const iframe1 = el.querySelector("#nc-gridlook-iframe");
    expect(iframe1).not.toBeNull();
    const src1 = (iframe1 as HTMLIFrameElement).getAttribute("src");

    // Unrelated re-renders (status re-affirmed, output re-set with same value)
    el.setAttribute("status", "ready");
    el.output = "<table>meta</table>";

    const iframe2 = el.querySelector("#nc-gridlook-iframe");
    expect(iframe2).toBe(iframe1); // same node - not recreated
    expect((iframe2 as HTMLIFrameElement).getAttribute("src")).toBe(src1);
  });

  it("does not rebuild the metadata container when output is unchanged", () => {
    const el = mount({ open: "", status: "ready", "zarr-url": "https://z.example.com" });
    el.output = "<table id='persisted'>x</table>";
    const inner = el.querySelector("#nc-metadata-inner");
    const child1 = inner!.firstElementChild;
    expect(child1).not.toBeNull();

    el.setAttribute("status", "ready"); // re-render, output unchanged

    expect(el.querySelector("#nc-metadata-inner")).toBe(inner);
    expect(inner!.firstElementChild).toBe(child1); // not re-parsed
  });

  it("preserves the path input node (and caret) across re-renders", () => {
    const el = mount({ open: "" });
    const input1 = el.querySelector("#nc-path-input");
    expect(input1).not.toBeNull();
    el.setAttribute("status", "loading");
    el.setAttribute("status", "ready");
    expect(el.querySelector("#nc-path-input")).toBe(input1); // same node
  });
});

// ── Lifecycle cleanup ──────────────────────────────────────────────────────--

describe("lifecycle cleanup", () => {
  it("clears pending copy timers on disconnect", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    const el = mount({ open: "", "zarr-url": "https://z.example.com", status: "ready" });
    el.output = "<table>x</table>";
    el.querySelector<HTMLButtonElement>("#nc-copy-zarr")!.click();
    // Flush the clipboard promise + the `.then` that schedules the reset timer.
    await Promise.resolve();
    await Promise.resolve();

    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    el.remove();
    expect(clearSpy).toHaveBeenCalled();
  });
});

// ── Zarr row de-duplication ────────────────────────────────────────────────--

describe("zarr row de-duplication", () => {
  it("suppresses the Zarr row when the store URL equals the inspected file", () => {
    const url = "https://store.example.com/data.zarr";
    const el = mount({ open: "", file: url, "zarr-url": url, status: "ready" });
    el.output = "<table>x</table>";
    // Input is already a Zarr store -> single path row, no duplicate Zarr row.
    expect(el.querySelector("#nc-zarr-row")!.hasAttribute("hidden")).toBe(true);
    // The 3D viewer tab is still available.
    expect(el.querySelector('[data-tab="gridlook"]')).not.toBeNull();
  });

  it("shows the Zarr row when a conversion produced a different URL", () => {
    const el = mount({
      open: "",
      file: "/data/file.nc",
      "zarr-url": "https://store.example.com/converted.zarr",
      status: "ready",
    });
    el.output = "<table>x</table>";
    expect(el.querySelector("#nc-zarr-row")!.hasAttribute("hidden")).toBe(false);
    expect(el.querySelector("#nc-zarr-url")!.textContent).toContain("converted.zarr");
  });
});

// ── Error shows alone ──────────────────────────────────────────────────────--

describe("error state", () => {
  it("shows the error alone, hiding stale metadata", () => {
    const el = mount({
      open: "",
      file: "/a.nc",
      "zarr-url": "https://z.example.com",
      status: "ready",
    });
    el.output = "<table>STALE-META</table>";
    // Error arrives on the same file; output is still set by the host.
    el.setAttribute("status", "error");
    el.setAttribute("error", "Boom");
    expect(el.querySelector("#nc-error")!.hasAttribute("hidden")).toBe(false);
    expect(el.querySelector("#nc-error-msg")!.textContent).toBe("Boom");
    expect(el.querySelector("#nc-metadata")!.hasAttribute("hidden")).toBe(true);
  });

  it("returns to the metadata tab on error even if the 3D tab was active", () => {
    const el = mount({ open: "", "zarr-url": "https://z.example.com", status: "ready" });
    el.output = "<table>x</table>";
    el.querySelector<HTMLButtonElement>('[data-tab="gridlook"]')!.click();
    el.setAttribute("status", "error");
    expect(el.querySelector("#nc-gridlook")!.hasAttribute("hidden")).toBe(true);
    expect(el.querySelector("#nc-error")!.hasAttribute("hidden")).toBe(false);
  });
});

// ── Accessibility ──────────────────────────────────────────────────────────--

describe("accessibility", () => {
  it("exposes dialog semantics on the modal", () => {
    const el = mount({ open: "" });
    const modal = el.querySelector(".di-modal")!;
    expect(modal.getAttribute("role")).toBe("dialog");
    expect(modal.getAttribute("aria-modal")).toBe("true");
    expect(modal.getAttribute("aria-labelledby")).toBe("nc-title");
    expect(el.querySelector("#nc-title")).not.toBeNull();
    expect(el.querySelector("#nc-close-btn")!.getAttribute("aria-label")).toBe("Close");
  });

  it("exposes tab roles and reflects the active tab via aria-selected", () => {
    const el = mount({ open: "", status: "ready", "zarr-url": "https://z.example.com" });
    el.output = "<table>x</table>";
    const meta = el.querySelector('[data-tab="metadata"]')!;
    const grid = el.querySelector('[data-tab="gridlook"]')!;
    expect(el.querySelector(".di-tabs")!.getAttribute("role")).toBe("tablist");
    expect(meta.getAttribute("role")).toBe("tab");
    expect(meta.getAttribute("aria-selected")).toBe("true");
    expect(grid.getAttribute("aria-selected")).toBe("false");
    (grid as HTMLButtonElement).click();
    expect(meta.getAttribute("aria-selected")).toBe("false");
    expect(grid.getAttribute("aria-selected")).toBe("true");
  });

  it("closes on Escape", () => {
    const el = mount({ open: "" });
    const handler = vi.fn();
    el.addEventListener("inspector-close", handler);
    el.querySelector("#nc-backdrop")!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(handler).toHaveBeenCalledOnce();
  });

  it("moves initial focus into the dialog on open", () => {
    const el = mount({ open: "" });
    expect(document.activeElement).toBe(el.querySelector("#nc-path-input"));
  });

  it("restores focus to the previously-focused element on close", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();

    const el = mount({});
    el.setAttribute("open", ""); // captures opener as the restore target
    expect(document.activeElement).not.toBe(opener); // focus moved into dialog

    el.removeAttribute("open"); // teardown restores focus
    expect(document.activeElement).toBe(opener);
  });
});

// ── GridLook refresh ───────────────────────────────────────────────────────--

describe("gridlook refresh", () => {
  it("reloads the iframe by recreating it and restoring the src", () => {
    const url = "https://z.example.com/store.zarr";
    const el = mount({ open: "", status: "ready", "zarr-url": url });
    el.output = "<table>x</table>";
    el.querySelector<HTMLButtonElement>('[data-tab="gridlook"]')!.click();

    const iframe1 = el.querySelector("#nc-gridlook-iframe");
    expect(iframe1).not.toBeNull();

    el.querySelector<HTMLButtonElement>("#nc-refresh-gridlook")!.click();

    const iframe2 = el.querySelector<HTMLIFrameElement>("#nc-gridlook-iframe");
    expect(iframe2).not.toBeNull();
    // Recreated (guaranteed reload), src restored from the known zarrUrl.
    expect(iframe2).not.toBe(iframe1);
    expect(iframe2!.getAttribute("src")).toBe(`https://gridlook.pages.dev/#${url}`);
    expect(iframe2!.getAttribute("sandbox")).toContain("allow-scripts");
  });

  it("recovers the frame on the next render after a refresh", () => {
    const url = "https://z.example.com/store.zarr";
    const el = mount({ open: "", status: "ready", "zarr-url": url });
    el.output = "<table>x</table>";
    el.querySelector<HTMLButtonElement>('[data-tab="gridlook"]')!.click();
    el.querySelector<HTMLButtonElement>("#nc-refresh-gridlook")!.click();

    // An unrelated re-render must keep a populated iframe (cache was reset).
    el.setAttribute("status", "ready");
    const iframe = el.querySelector<HTMLIFrameElement>("#nc-gridlook-iframe");
    expect(iframe).not.toBeNull();
    expect(iframe!.getAttribute("src")).toBe(`https://gridlook.pages.dev/#${url}`);
  });
});
