import { describe, it, expect, beforeAll, vi, afterEach } from "vitest";
import { ZarrLoadingStepsElement } from "../elements/zarr-loading-steps";

beforeAll(() => {
  if (!customElements.get("zarr-loading-steps")) {
    customElements.define("zarr-loading-steps", ZarrLoadingStepsElement);
  }
});

function mount(attrs: Record<string, string> = {}): ZarrLoadingStepsElement {
  const el = document.createElement("zarr-loading-steps") as ZarrLoadingStepsElement;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("<zarr-loading-steps>", () => {
  it("renders stage dots on connect", () => {
    const el = mount({ "status-code": "3" });
    expect(el.querySelector(".zarr-stages")).not.toBeNull();
  });

  it("renders elapsed timer element", () => {
    const el = mount({ "status-code": "3" });
    expect(el.querySelector(".zarr-elapsed")).not.toBeNull();
  });

  it("renders a waiting message for status-code 3 (queued)", () => {
    const el = mount({ "status-code": "3" });
    expect(el.textContent).toContain("Waiting for a worker");
  });

  it("renders no message for status-code 0 (done)", () => {
    const el = mount({ "status-code": "0" });
    const msgContainer = el.querySelector<HTMLElement>(".zarr-msg-container")!;
    expect(msgContainer.textContent?.trim()).toBe("");
  });

  it("shows a processing message for status-code 4 (converting)", () => {
    const el = mount({ "status-code": "4" });
    const msgContainer = el.querySelector<HTMLElement>(".zarr-msg-container")!;
    // Should have some message text
    expect(msgContainer.textContent?.trim().length).toBeGreaterThan(0);
  });

  it("re-renders stages when status-code attribute changes", () => {
    const el = mount({ "status-code": "3" });
    expect(el.textContent).toContain("Waiting for a worker");

    el.setAttribute("status-code", "0");
    const msgContainer = el.querySelector<HTMLElement>(".zarr-msg-container")!;
    expect(msgContainer.textContent?.trim()).toBe("");
  });

  it("injects keyframes style into document head", () => {
    mount({ "status-code": "3" });
    expect(document.getElementById("zarr-loading-keyframes")).not.toBeNull();
  });

  it("stops timers on disconnect", () => {
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    const el = mount({ "status-code": "4" });
    el.remove();
    expect(clearSpy).toHaveBeenCalled();
  });
});
