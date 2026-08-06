import { describe, it, expect, beforeAll } from "vitest";
import { AggregationConfigElement } from "../src/elements/aggregation-config";

beforeAll(() => {
  if (!customElements.get("aggregation-config")) {
    customElements.define("aggregation-config", AggregationConfigElement);
  }
});

function mount(attrs: Record<string, string> = {}): AggregationConfigElement {
  const el = document.createElement("aggregation-config") as AggregationConfigElement;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  return el;
}

function unmount(el: Element) {
  el.remove();
}

describe("<aggregation-config>", () => {
  it("renders to the DOM on connect", () => {
    const el = mount();
    expect(el.querySelector(".aggregation-config")).not.toBeNull();
    unmount(el);
  });

  it("applies initial-config by rendering the correct selected option", () => {
    const config = JSON.stringify({ aggregate: "concat", timeout: 60 });
    const el = mount({ "initial-config": config });

    // Check the selected option is rendered with selected attribute
    const selectedOption = el.querySelector<HTMLOptionElement>(
      '[data-field="aggregate"] option[value="concat"]',
    );
    const timeout = el.querySelector<HTMLInputElement>('[data-field="timeout"]');

    expect(selectedOption?.hasAttribute("selected")).toBe(true);
    expect(timeout?.value).toBe("60");
    unmount(el);
  });

  it("emits config-change on select change", () => {
    const el = mount();
    let received: unknown = null;
    el.addEventListener("config-change", (e) => {
      received = (e as CustomEvent).detail;
    });

    const select = el.querySelector<HTMLSelectElement>('[data-field="aggregate"]')!;
    select.value = "merge";
    select.dispatchEvent(new Event("change", { bubbles: true }));

    expect((received as { aggregate: string })?.aggregate).toBe("merge");
    unmount(el);
  });

  it("shows dim field only when aggregate is concat", () => {
    const el = mount({ "initial-config": JSON.stringify({ aggregate: "concat" }) });
    const dimField = el.querySelector<HTMLElement>(".nc-dim-field");
    expect(dimField?.style.display).toBe("block");
    unmount(el);
  });

  it("hides dim field when aggregate is not concat", () => {
    const el = mount({ "initial-config": JSON.stringify({ aggregate: "merge" }) });
    const dimField = el.querySelector<HTMLElement>(".nc-dim-field");
    expect(dimField?.style.display).toBe("none");
    unmount(el);
  });

  it("toggles advanced section on button click", () => {
    const el = mount();
    const advanced = el.querySelector<HTMLElement>(".nc-advanced")!;
    expect(advanced.style.display).toBe("none");

    el.querySelector<HTMLButtonElement>("#nc-advanced-toggle")!.click();
    expect(advanced.style.display).toBe("block");

    el.querySelector<HTMLButtonElement>("#nc-advanced-toggle")!.click();
    expect(advanced.style.display).toBe("none");
    unmount(el);
  });

  it("emits reload: true when checkbox is checked", () => {
    const el = mount();
    el.querySelector<HTMLButtonElement>("#nc-advanced-toggle")!.click();

    let received: unknown = null;
    el.addEventListener("config-change", (e) => {
      received = (e as CustomEvent).detail;
    });

    const checkbox = el.querySelector<HTMLInputElement>('[data-field="reload"]')!;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));

    expect((received as { reload: boolean })?.reload).toBe(true);
    unmount(el);
  });
});
