// @vitest-environment jsdom
// The example gallery: a card per example with its notebook's own figure, its first paragraph
// and its steps; a search; "Start here" and "Your copy"; a click chooses. Notebooks are read a few
// at a time and remembered for the session.
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  const g = globalThis as { DragEvent?: unknown; MouseEvent: typeof MouseEvent };
  g.DragEvent ??= class extends g.MouseEvent {};
});

const { ExampleGallery, shorten, summarize } = await import("../src/gallery.js");

const notebook = (title: string, paragraph: string, png = "iVBORw0KGgo=") => ({
  cells: [
    { cell_type: "markdown", source: [`# ${title}\n`, "\n", `${paragraph}\n`] },
    { cell_type: "code", source: "import xarray", outputs: [] },
    {
      cell_type: "code",
      source: "plt.show()",
      outputs: [{ output_type: "display_data", data: { "image/png": png, "text/plain": "<f>" } }],
    },
  ],
});

describe("a notebook, summarized for its card", () => {
  it("its first picture, its first paragraph as plain text, and its steps", () => {
    const s = summarize(notebook("Zonal mean", "Average over [longitude](https://x) with `mean`."));
    expect(s.image).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(s.description).toBe("Average over longitude with mean.");
    expect(s.steps).toBe(2);
    expect(summarize({ cells: [] })).toEqual({ image: null, description: "", steps: 0 });
    expect(summarize(null)).toEqual({ image: null, description: "", steps: 0 });
  });

  it("a long introduction is cut at a sentence", () => {
    const long = `${"A first sentence that says a lot. ".repeat(3)}And one more.`;
    expect(shorten(long, 70)).toBe(
      "A first sentence that says a lot. A first sentence that says a lot.",
    );
    expect(shorten("Short.", 70)).toBe("Short.");
  });
});

describe("the gallery", () => {
  const seeds = [
    { path: "examples/01_first_map.ipynb", title: "A map of one month" },
    { path: "examples/04_zonal_mean.ipynb", title: "Zonal mean" },
    { path: "examples/era5.ipynb", title: "ERA5, July 2021" },
  ];
  const texts: Record<string, string> = {
    "examples/01_first_map.ipynb": "The first thing anybody wants is to look at it.",
    "examples/04_zonal_mean.ipynb": "Average every latitude band.",
    "examples/era5.ipynb": "One month of temperature, found through Freva.",
  };

  function open(choose = vi.fn(), cache = new Map()) {
    const read = vi.fn(async (path: string) => notebook(path, texts[path]!));
    const gallery = new ExampleGallery({
      seeds,
      start: "examples/era5.ipynb",
      read,
      hasCopy: async (path) => path === "examples/04_zonal_mean.ipynb",
      choose,
      cache,
    });
    document.body.append(gallery.node);
    return { gallery, read, choose };
  }

  it("draws a card per example: its figure, text, steps, Start here and Your copy", async () => {
    const { gallery } = open();
    expect(gallery.cards).toHaveLength(3);
    expect(gallery.cards[0]!.classList.contains("jp-mod-loading")).toBe(true);
    await gallery.loaded;
    const [map, zonal, start] = gallery.cards;
    expect(map!.querySelector("img")!.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
    expect(map!.textContent).toContain("A map of one month");
    expect(map!.textContent).toContain("look at it");
    expect(map!.textContent).toContain("2 steps");
    expect(map!.querySelector(".jp-FrevaData-galleryNumber")!.textContent).toBe("01");
    expect(zonal!.textContent).toContain("Your copy");
    expect(zonal!.textContent).toContain("Continue");
    expect(start!.querySelector(".jp-FrevaData-galleryRibbon")!.textContent).toBe("Start here");
    gallery.dispose();
  });

  it("a search keeps the cards with every word, in the title or the text", async () => {
    const { gallery } = open();
    await gallery.loaded;
    gallery.filter("latitude band");
    expect(gallery.cards.map((c) => c.hidden)).toEqual([true, false, true]);
    gallery.filter("nothing like this");
    expect(gallery.cards.every((c) => c.hidden)).toBe(true);
    expect(gallery.node.querySelector<HTMLElement>(".jp-FrevaData-galleryEmpty")!.hidden).toBe(
      false,
    );
    gallery.filter("");
    expect(gallery.cards.some((c) => c.hidden)).toBe(false);
    gallery.dispose();
  });

  it("a click chooses its example; a second opening reads nothing again", async () => {
    const cache = new Map();
    const first = open(vi.fn(), cache);
    await first.gallery.loaded;
    first.gallery.cards[1]!.click();
    expect(first.choose).toHaveBeenCalledWith(seeds[1]);
    expect(first.read).toHaveBeenCalledTimes(3);
    first.gallery.dispose();
    const again = open(vi.fn(), cache);
    await again.gallery.loaded;
    expect(again.read).not.toHaveBeenCalled();
    again.gallery.dispose();
  });
});
