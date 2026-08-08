/**
 * The main search dropdown's height, and the negative-facet chip round trip.
 *
 * THE HEIGHT. `.vsearch-pop` asks for `max-height: 340px`. If `positionAnchored()` writes
 * `style.maxHeight` unconditionally, from the whole visible height of the component, that inline
 * style beats the rule, the stylesheet's cap never applies and the list grows to nearly the full
 * component height. So the positioner takes an optional `maxHeight` and uses
 * `min(availableHeight, maxHeight)` for the style, the measurement, the flip and the clamp alike.
 * Only the main search bar passes one; the picker's autocomplete, the popovers and the tooltip are
 * untouched and size to the visible box.
 *
 * jsdom cannot see any of this: with no layout `hasLayout()` fails open and `positionAnchored`
 * returns before it writes a single style.
 *
 * THE NEGATIVE-FACET ROUND TRIP is the second half: type an exclusion in Bash, wait for a response
 * that no longer mentions the excluded value, remove the chip, and check both terminals forget it
 * and cannot resurrect it on the next keystroke.
 */
import { IMPORT_MAP, inChromium, report, requireDist, serve } from "./harness.mjs";

requireDist();

/**
 * A backend with MANY values for one facet - a short list cannot overflow a 340px cap, so it cannot
 * tell an applied cap from an ignored one. It also drops an excluded value from the response, the
 * way freva-rest does, which is what the negative-facet round trip needs.
 */
const api = `<script>
  const MODELS = Array.from({ length: 60 }, (_, i) => "model-" + String(i).padStart(3, "0"));
  window.__requests = [];
  window.fetch = async (url) => {
    const u = String(url);
    window.__requests.push(u);
    if (u.includes("/overview")) {
      return new Response(JSON.stringify({
        flavours: ["freva"], attributes: { freva: ["project", "model", "variable"] },
      }), { headers: { "content-type": "application/json" } });
    }
    // The server EXCLUDES what was negated: once \`model_not_=model-000\` is in the query, that
    // value is simply absent from the facet list it answers with. Everything downstream has to
    // cope with a chip whose value the vocabulary no longer contains.
    const excluded = [...u.matchAll(/model_not_=([^&]+)/g)].map((m) => decodeURIComponent(m[1]));
    const models = MODELS.filter((m) => !excluded.includes(m));
    const facets = {
      project: ["cmip6", 12, "cordex", 4],
      model: models.flatMap((m) => [m, 3]),
      variable: ["tas", 9, "pr", 3],
    };
    return new Response(JSON.stringify({
      total_count: 1, facets, primary_facets: ["project", "model", "variable"],
      facet_mapping: {}, search_results: [{ file: "/archive/tas.nc", fs_type: "posix" }],
    }), { headers: { "content-type": "application/json" } });
  };
</script>`;

const pageFor = (
  hostCss,
  hostOpen,
  hostClose,
) => `<!doctype html><html><head><meta charset="utf-8">${IMPORT_MAP}
<style>html,body{margin:0;height:100%}#app{height:100%}${hostCss}</style></head>
<body>${hostOpen}<div id="app"></div>${hostClose}
${api}
<script type="module">
  const { mountDataBrowser } = await import("@freva-org/databrowser");
  window.__h = mountDataBrowser(document.getElementById("app"), { syncUrl: false });
  await new Promise(r => setTimeout(r, 700));
  window.__ready = true;
</script></body></html>`;

const plainPage = pageFor("", "", "");
// The embedded host from `embedded-host.mjs`: a transformed, filtered, clipped, scrolled container.
const embeddedPage = pageFor(
  `.host{transform:translateZ(0);filter:saturate(1.02);overflow:hidden;height:640px;width:900px;
     margin:40px 0 1400px 60px;border:1px solid #ccc}`,
  `<div class="host">`,
  `</div>`,
);

/** Open the dropdown by typing into the main search field, then measure it. */
const MEASURE = async (query) => {
  const root = document.querySelector(".freva-db");
  const input =
    root.querySelector(".vsearch input, input.vsearch, .searchwrap input") ??
    [...root.querySelectorAll("input")].find((i) =>
      /search/i.test(`${i.placeholder} ${i.getAttribute("aria-label") ?? ""}`),
    );
  if (!input) return { error: "no search input" };
  input.focus();
  input.value = query;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 400));
  const pop = root.querySelector(".vsearch-pop");
  if (!pop || !pop.classList.contains("show")) return { error: "the dropdown did not open" };

  const rb = root.getBoundingClientRect();
  const pb = pop.getBoundingClientRect();
  const ib = input.getBoundingClientRect();
  const cs = getComputedStyle(pop);
  const items = pop.querySelectorAll(".vs-item").length;
  return {
    error: null,
    items,
    rootH: Math.round(rb.height),
    popH: Math.round(pb.height * 100) / 100,
    inlineMaxHeight: pop.style.maxHeight,
    computedMaxHeight: cs.maxHeight,
    scrolls: pop.scrollHeight > pop.clientHeight + 1,
    // …and it is still anchored to its field, inside the component, in root-local coordinates.
    position: cs.position,
    belowField: pb.top >= ib.bottom - 1,
    leftAligned: Math.abs(pb.left - ib.left) <= 24,
    insideRoot: pb.left >= rb.left - 1 && pb.right <= rb.right + 1 && pb.bottom <= rb.bottom + 1,
    parentIsRoot: pop.parentElement === root,
    // A click at the dropdown's own centre must reach the dropdown.
    hit: (() => {
      const at = document.elementFromPoint(
        Math.round(pb.left + pb.width / 2),
        Math.round(pb.top + Math.min(pb.height / 2, 40)),
      );
      return !!at && !!at.closest(".vsearch-pop");
    })(),
  };
};

const CLOSE = async () => {
  const root = document.querySelector(".freva-db");
  const input = [...root.querySelectorAll("input")].find((i) =>
    /search/i.test(`${i.placeholder} ${i.getAttribute("aria-label") ?? ""}`),
  );
  if (input) {
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.blur();
  }
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await new Promise((r) => setTimeout(r, 250));
};

const result = await inChromium(async (browser) => {
  const checks = [];
  const push = (name, pass, detail) => checks.push({ name, pass, detail: JSON.stringify(detail) });

  // 1. The height cap, on a plain page
  {
    const server = await serve(plainPage);
    try {
      await browser.goto(server.url);
      await browser.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });

      // MANY matches: 60 models all match "model-", so the list wants to be far taller than 340.
      const many = await browser.evaluate(MEASURE, "model-");
      push(
        "search dropdown: with many results it stops at 340px and scrolls its own content",
        !many.error &&
          many.items >= 20 &&
          many.popH <= 341 &&
          many.popH >= 300 &&
          many.inlineMaxHeight === "340px" &&
          many.scrolls &&
          // The whole point: it is a small fraction of the component, not nearly all of it.
          many.popH < many.rootH * 0.6,
        many,
      );
      push(
        "search dropdown: it stays anchored under its field, inside the component, and clickable",
        !many.error &&
          many.position === "absolute" &&
          many.parentIsRoot &&
          many.belowField &&
          many.leftAligned &&
          many.insideRoot &&
          many.hit,
        many,
      );

      // FEW matches: the dropdown must be content-sized, nowhere near the cap, and not scrolling.
      await browser.evaluate(CLOSE);
      const few = await browser.evaluate(MEASURE, "cordex");
      push(
        "search dropdown: with a few results it is CONTENT-SIZED, well under the cap, no scrollbar",
        !few.error &&
          few.items >= 1 &&
          few.items <= 4 &&
          few.popH < 200 &&
          !few.scrolls &&
          few.inlineMaxHeight === "340px",
        few,
      );

      // A SHORT component: the visible box is the smaller of the two, and it must still win.
      await browser.evaluate(CLOSE);
      const short = await browser.evaluate(async () => {
        document.getElementById("app").style.height = "260px";
        document.body.style.height = "260px";
        window.dispatchEvent(new Event("resize"));
        await new Promise((r) => setTimeout(r, 300));
        return true;
      });
      void short;
      const clamped = await browser.evaluate(MEASURE, "model-");
      push(
        "search dropdown: in a SHORT component the visible box still wins over the 340px request",
        !clamped.error &&
          parseFloat(clamped.inlineMaxHeight) < 340 &&
          clamped.popH <= clamped.rootH + 1 &&
          clamped.insideRoot,
        clamped,
      );
      await browser.evaluate(async () => {
        document.getElementById("app").style.height = "100%";
        document.body.style.height = "100%";
        window.dispatchEvent(new Event("resize"));
        await new Promise((r) => setTimeout(r, 300));
      });
    } finally {
      await server.close();
    }
  }

  // 2. The same, inside a transformed / filtered / clipped / scrolled host
  {
    const server = await serve(embeddedPage);
    try {
      await browser.goto(server.url);
      await browser.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });
      await browser.evaluate(async () => {
        window.scrollTo(0, 220);
        await new Promise((r) => setTimeout(r, 200));
      });
      const embedded = await browser.evaluate(MEASURE, "model-");
      push(
        "search dropdown (embedded host): capped at 340px AND still anchored inside the component",
        !embedded.error &&
          embedded.popH <= 341 &&
          embedded.inlineMaxHeight === "340px" &&
          embedded.position === "absolute" &&
          embedded.parentIsRoot &&
          embedded.belowField &&
          embedded.insideRoot &&
          embedded.hit,
        embedded,
      );
    } finally {
      await server.close();
    }
  }

  // 3. The negative-facet round trip
  //
  // Exclusions must clear completely, and stay cleared. The hard part is the middle step - by the
  // time the chip is removed, the server has already stopped listing the excluded value, so
  // nothing downstream can rediscover it from the vocabulary. If any layer keeps its own copy of
  // the exclusion, the next keystroke in either terminal re-commits it and the filter comes back.
  {
    const server = await serve(plainPage);
    try {
      await browser.goto(server.url);
      await browser.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });

      const round = await browser.evaluate(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const root = document.querySelector(".freva-db");
        root.querySelector('[aria-label="Command terminal"]').click();
        await sleep(400);

        const term = document.querySelector(".freva-term");
        const surface = (tab) => {
          const ed = term.querySelector(`.term-view[data-cmd="${tab}"] .te-editor`);
          const rich = ed.dataset.mode === "rich";
          return {
            ed,
            rich,
            node: rich ? ed.querySelector(".te-cmd") : ed.querySelector("textarea"),
          };
        };
        const read = (tab) => {
          const s = surface(tab);
          return (s.rich ? s.node.textContent : s.node.value) ?? "";
        };
        const write = async (tab, text) => {
          const s = surface(tab);
          s.node.focus();
          if (s.rich) s.node.textContent = text;
          else s.node.value = text;
          s.node.dispatchEvent(new InputEvent("input", { bubbles: true }));
          await sleep(120);
          s.node.blur(); // blur completes the in-progress token, as it always has
          await sleep(600);
        };

        // 1. Enter the exclusion in BASH.
        window.__requests.length = 0;
        await write("cli", "model_not_=model-000 ");
        const afterType = {
          selected: JSON.parse(JSON.stringify(window.__h.getState().selected)),
          cli: read("cli"),
        };

        // 2. Wait until a RESPONSE has come back that no longer offers the excluded value.
        let vocabularyDropped = false;
        for (let i = 0; i < 40; i++) {
          const facets = window.__h.getState().facets ?? [];
          const model = facets.find((f) => f.key === "model");
          const values = (model?.values ?? []).map((v) =>
            Array.isArray(v) ? v[0] : (v.value ?? v),
          );
          if (model && !values.includes("model-000")) {
            vocabularyDropped = true;
            break;
          }
          await sleep(150);
        }
        const requestedWithExclusion = window.__requests.some((u) =>
          /model_not_=model-000/.test(u),
        );

        // 3. Remove the chip from the UI.
        const chips = [...root.querySelectorAll(".chips .chip")];
        const chip = chips.find((c) => (c.textContent ?? "").includes("model-000"));
        const removeBtn = chip?.querySelector("button, .chip-x, [aria-label*='emove']") ?? chip;
        const chipText = chip ? chip.textContent : null;
        removeBtn?.click();
        await sleep(800);

        const afterRemove = {
          selected: JSON.parse(JSON.stringify(window.__h.getState().selected)),
          cli: read("cli"),
          py: read("py"),
          chips: [...root.querySelectorAll(".chips .chip")].map((c) => c.textContent),
        };

        // 4. Type ONE more ordinary character in each terminal. Nothing may resurrect it.
        window.__requests.length = 0;
        const cliBefore = read("cli");
        await write(
          "cli",
          `${cliBefore}${cliBefore && !cliBefore.endsWith(" ") ? " " : ""}project=cmip6 `,
        );
        const afterCliEdit = {
          selected: JSON.parse(JSON.stringify(window.__h.getState().selected)),
          cli: read("cli"),
        };
        term.querySelector('.cmd-tab[data-cmd="py"]')?.click();
        await sleep(300);
        const pyBefore = read("py");
        await write(
          "py",
          `${pyBefore}${pyBefore && !pyBefore.endsWith("\n") ? "\n" : ""}variable=tas,`,
        );
        const afterPyEdit = {
          selected: JSON.parse(JSON.stringify(window.__h.getState().selected)),
          py: read("py"),
        };
        const laterRequests = [...window.__requests];

        return {
          chipText,
          hadChip: !!chip,
          afterType,
          vocabularyDropped,
          requestedWithExclusion,
          afterRemove,
          afterCliEdit,
          afterPyEdit,
          resurrectedInRequest: laterRequests.some((u) => /model_not_/.test(u)),
        };
      });

      push(
        "negative facet: a Bash exclusion commits, shows a chip, and reaches the wire",
        round.afterType.selected?.model_not_?.includes("model-000") === true &&
          round.requestedWithExclusion &&
          round.hadChip,
        {
          selected: round.afterType.selected,
          cli: round.afterType.cli,
          chip: round.chipText,
          onWire: round.requestedWithExclusion,
        },
      );
      push(
        "negative facet: the response stops offering the excluded value before the chip is removed",
        round.vocabularyDropped === true,
        { vocabularyDropped: round.vocabularyDropped },
      );
      push(
        "negative facet: removing the chip clears it from state AND from both terminals",
        !("model_not_" in (round.afterRemove.selected ?? {})) &&
          !/model_not_/.test(round.afterRemove.cli) &&
          !/model-000/.test(round.afterRemove.cli) &&
          !/model_not_/.test(round.afterRemove.py) &&
          !/model-000/.test(round.afterRemove.py) &&
          round.afterRemove.chips.every((c) => !/model-000/.test(c ?? "")),
        round.afterRemove,
      );
      push(
        "negative facet: the NEXT edit in either terminal cannot resurrect it",
        !("model_not_" in (round.afterCliEdit.selected ?? {})) &&
          !("model_not_" in (round.afterPyEdit.selected ?? {})) &&
          !/model_not_/.test(round.afterCliEdit.cli) &&
          !/model_not_/.test(round.afterPyEdit.py) &&
          round.resurrectedInRequest === false,
        {
          cli: round.afterCliEdit,
          py: round.afterPyEdit,
          resurrectedInRequest: round.resurrectedInRequest,
        },
      );
    } finally {
      await server.close();
    }
  }

  return checks;
});

process.exit(report("search dropdown height; negative-facet chip round trip", result));
