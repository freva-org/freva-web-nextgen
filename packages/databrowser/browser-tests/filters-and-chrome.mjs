/**
 * Four things a real engine has to answer.
 *
 *  1. Removing the BBox (or Time) chip clears the WHOLE pair. `bbox_select` must not survive as an
 *     orphan in the terminal buffer, where a later commit would put it back on the wire.
 *  2. The two terminal tabs' immutable text keeps its own per-tab colour; a generic `.te-fixed`
 *     rule must not repaint both the same grey. Computed colours, both presets.
 *  3. The minimized colour palette keeps its gaps: `display: revert` throws away the flex row.
 *  4. Inclusion and exclusion are told apart by CHARACTER and SHAPE, not by colour - measured with
 *     a red host accent, in greyscale, and under `forced-colors: active`.
 */
import { IMPORT_MAP, inChromium, report, requireDist, serve } from "./harness.mjs";

requireDist();

const api = `<script>
  window.__requests = [];
  window.fetch = async (url) => {
    const u = String(url);
    window.__requests.push(u);
    if (u.includes("/overview")) {
      return new Response(JSON.stringify({
        flavours: ["freva"], attributes: { freva: ["project", "model", "variable"] },
      }), { headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      total_count: 1,
      facets: { project: ["cmip6", 12, "cordex", 4, "cmip5", 2], model: ["m1", 6, "m2", 3],
                variable: ["tas", 9, "pr", 3] },
      primary_facets: ["project", "model", "variable"], facet_mapping: {},
      search_results: [{ file: "/archive/tas.nc", fs_type: "posix" }],
    }), { headers: { "content-type": "application/json" } });
  };
</script>`;

const page = (extraCss = "") => `<!doctype html><html><head><meta charset="utf-8">${IMPORT_MAP}
<style>html,body{margin:0;height:100%}#app{height:100%}${extraCss}</style></head>
<body><div id="app"></div>${api}
<script type="module">
  const { mountDataBrowser } = await import("@freva-org/databrowser");
  window.__h = mountDataBrowser(document.getElementById("app"), { syncUrl: false });
  await new Promise(r => setTimeout(r, 700));
  window.__ready = true;
</script></body></html>`;

const result = await inChromium(async (browser) => {
  const checks = [];
  const push = (name, pass, detail) => checks.push({ name, pass, detail: JSON.stringify(detail) });

  // 1. Time / BBox clear ATOMICALLY, with their `*_select` partner
  {
    const server = await serve(page());
    try {
      await browser.goto(server.url);
      await browser.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });

      const pair = await browser.evaluate(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const root = document.querySelector(".freva-db");
        root.querySelector('[aria-label="Command terminal"]').click();
        await sleep(400);
        const term = document.querySelector(".freva-term");
        const surface = (tab) => {
          const ed = term.querySelector(`.term-view[data-cmd="${tab}"] .te-editor`);
          const rich = ed.dataset.mode === "rich";
          return { rich, node: rich ? ed.querySelector(".te-cmd") : ed.querySelector("textarea") };
        };
        const read = (tab) => {
          const s = surface(tab);
          return (s.rich ? s.node.textContent : s.node.value) ?? "";
        };
        const type = async (tab, text) => {
          const s = surface(tab);
          s.node.focus();
          if (s.rich) s.node.textContent = text;
          else s.node.value = text;
          s.node.dispatchEvent(new InputEvent("input", { bubbles: true }));
          await sleep(150);
          s.node.blur();
          await sleep(700);
        };
        const copied = () => {
          const btn = [...term.querySelectorAll("button")].find((b) =>
            /copy/i.test(`${b.getAttribute("aria-label") ?? ""} ${b.title ?? ""}`),
          );
          return btn ? btn.getAttribute("data-copy-preview") : null;
        };
        void copied;

        const out = {};
        for (const [what, tokens, chipRe] of [
          ["bbox", "bbox=-10,10,35,60 bbox_select=strict ", /bbox/i],
          ["time", 'time="2000 TO 2010" time_select=strict ', /time/i],
        ]) {
          await type("cli", tokens);
          const on = {
            state: JSON.parse(JSON.stringify(window.__h.getState()[what])),
            cli: read("cli"),
          };
          // The user is STILL IN the terminal when they reach for the chip - which is the case
          // where an orphan can be retained.
          surface("cli").node.focus();
          await sleep(150);
          window.__requests.length = 0;
          const chip = [...root.querySelectorAll(".chips .chip")].find((c) =>
            chipRe.test(c.textContent ?? ""),
          );
          (chip?.querySelector("button") ?? chip)?.click();
          await sleep(900);
          out[what] = {
            on,
            hadChip: !!chip,
            state: window.__h.getState()[what],
            cli: read("cli"),
            py: read("py"),
            reqs: [...window.__requests],
          };
          // …and one more ordinary edit must not bring the pair back.
          await type("cli", `${read("cli")} project=cmip6 `.trim() + " ");
          out[what].after = {
            state: window.__h.getState()[what],
            cli: read("cli"),
            py: read("py"),
            reqs: [...window.__requests],
          };
          await type("cli", "");
          await sleep(300);
        }
        return out;
      });

      for (const what of ["bbox", "time"]) {
        const r = pair[what];
        const sel = `${what}_select`;
        push(
          `${what}: removing the chip clears BOTH ${what} and ${sel} - state, both terminals, the wire`,
          r.hadChip &&
            r.on.state !== null &&
            r.state === null &&
            !r.cli.includes(sel) &&
            !r.cli.includes(`${what}=`) &&
            !r.py.includes(sel) &&
            !r.py.includes(what) &&
            r.reqs.every((u) => !u.includes(sel) && !new RegExp(`[?&]${what}=`).test(u)),
          { before: r.on, after: { state: r.state, cli: r.cli, py: r.py }, reqs: r.reqs },
        );
        push(
          `${what}: a later terminal edit cannot resurrect ${sel}`,
          r.after.state === null &&
            !r.after.cli.includes(sel) &&
            !r.after.py.includes(sel) &&
            r.after.reqs.every((u) => !u.includes(sel)),
          r.after,
        );
      }
    } finally {
      await server.close();
    }
  }

  // 2. The immutable terminal text keeps its ORIGINAL, per-tab colours
  {
    const server = await serve(page());
    try {
      await browser.goto(server.url);
      await browser.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });

      const COLOURS = async (preset) => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const root = document.querySelector(".freva-db");
        if (!document.querySelector(".freva-term.show")) {
          root.querySelector('[aria-label="Command terminal"]').click();
          await sleep(400);
        }
        const term = document.querySelector(".freva-term");
        term.dataset.termTheme = preset;
        term.classList.toggle("light", preset === "light");
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const cssVar = (n) => getComputedStyle(term).getPropertyValue(n).trim();
        const norm = (c) => {
          const p = document.createElement("span");
          p.style.color = c;
          term.appendChild(p);
          const v = getComputedStyle(p).color;
          p.remove();
          return v;
        };
        const of = (node) => {
          const cs = getComputedStyle(node);
          return {
            color: cs.color,
            weight: Number(cs.fontWeight),
            opacity: Math.round(parseFloat(cs.opacity) * 100) / 100,
          };
        };
        const cli = term.querySelector('.term-view[data-cmd="cli"]');
        const py = term.querySelector('.term-view[data-cmd="py"]');
        const byText = (scope, re, sel) =>
          [...scope.querySelectorAll(sel)].find((n) => re.test(n.textContent ?? ""));
        return {
          preset,
          expect: {
            fg: norm(cssVar("--term-fg")),
            key: norm(cssVar("--term-key")),
            prompt: norm(cssVar("--term-prompt")),
          },
          cliFixed: of(byText(cli, /freva-client databrowser data-search/, ".te-fixed")),
          pyImport: of(byText(py, /from freva_client import databrowser/, ".te-fixed")),
          pyOpen: of(byText(py, /^databrowser\($/, ".te-fixed")),
          pyClose: of(byText(py, /^\)$/, ".te-fixed")),
          pyPrompt: of(byText(py, /^>>>/, ".te-prompt")),
          pyCont: (() => {
            const n = py.querySelector(".te-contprompt");
            return n ? of(n) : null;
          })(),
          key: of(cli.querySelector(".te-key") ?? cli.querySelector(".cli-prefix")),
        };
      };

      for (const preset of ["night", "light"]) {
        const c = await browser.evaluate(COLOURS, preset);
        push(
          `terminal (${preset}): bash's fixed command text is FOREGROUND weight 600 at 0.92`,
          c.cliFixed.color === c.expect.fg &&
            c.cliFixed.weight === 600 &&
            Math.abs(c.cliFixed.opacity - 0.92) < 0.02,
          { got: c.cliFixed, expectedColor: c.expect.fg },
        );
        push(
          `terminal (${preset}): python's import / databrowser( / ) are the KEY colour, not bash's`,
          c.pyImport.color === c.expect.key &&
            c.pyOpen.color === c.expect.key &&
            c.pyClose.color === c.expect.key &&
            c.pyImport.color !== c.cliFixed.color,
          {
            import: c.pyImport,
            open: c.pyOpen,
            close: c.pyClose,
            key: c.expect.key,
            bash: c.cliFixed.color,
          },
        );
        push(
          `terminal (${preset}): a real >>> prompt keeps the prompt colour at weight 700; ... stays dim`,
          c.pyPrompt.color === c.expect.prompt &&
            c.pyPrompt.weight === 700 &&
            !!c.pyCont &&
            c.pyCont.color !== c.expect.prompt &&
            c.pyCont.weight === 400,
          { prompt: c.pyPrompt, cont: c.pyCont, expected: c.expect.prompt },
        );
      }

      // 3. The minimized palette keeps its spacing
      const palette = await browser.evaluate(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const term = document.querySelector(".freva-term");
        const measure = () => {
          const panel = term.querySelector(".term-bg-panel");
          const sw = [...panel.querySelectorAll(".bg-sw")];
          const boxes = sw.map((s) => s.getBoundingClientRect());
          const sameRow = boxes.filter((b) => Math.abs(b.top - boxes[0].top) < 2);
          const gaps = [];
          for (let i = 1; i < sameRow.length; i++) {
            gaps.push(Math.round((sameRow[i].left - sameRow[i - 1].right) * 100) / 100);
          }
          const cs = getComputedStyle(panel);
          return {
            display: cs.display,
            gap: cs.gap,
            count: sw.length,
            widths: [...new Set(boxes.map((b) => Math.round(b.width)))],
            gaps: [...new Set(gaps)],
            rootH: Math.round(term.getBoundingClientRect().height),
          };
        };
        const open = (label) => {
          term.querySelector(`[aria-label="${label}"]`).click();
          return sleep(350);
        };
        // expanded
        await open("Terminal settings");
        const expanded = measure();
        await open("Terminal settings");
        // minimized
        await open("Minimize");
        const barH = Math.round(term.querySelector(".term-bar").getBoundingClientRect().height);
        await open("Terminal settings");
        const minimized = measure();
        const dockH = Math.round(term.getBoundingClientRect().height);
        await open("Terminal settings");
        term.querySelector(".term-bar").click();
        await sleep(350);
        return { expanded, minimized, barH, dockH };
      });
      push(
        "minimized palette: the swatches keep the flex row, the 7px gaps and a 24px track",
        palette.minimized.display === "flex" &&
          palette.minimized.gap === "7px" &&
          palette.minimized.count === palette.expanded.count &&
          JSON.stringify(palette.minimized.gaps) === JSON.stringify(palette.expanded.gaps) &&
          palette.minimized.gaps.every((g) => Math.abs(g - 7) <= 0.5) &&
          JSON.stringify(palette.minimized.widths) === JSON.stringify([24]),
        palette,
      );
      push(
        "minimized palette: opening it does not undo the dock's collapse",
        Math.abs(palette.dockH - palette.barH) <= 3,
        { dockH: palette.dockH, barH: palette.barH },
      );
    } finally {
      await server.close();
    }
  }

  // 4. Inclusion vs exclusion, without relying on colour
  {
    // A RED host accent: if "kept" is accent and "removed" is red, this deployment renders them
    // identically. The distinction has to survive it.
    // `!important`, because the component sets `--accent` on `.freva-db` itself: a host override has
    // to win, and this one is standing in for a deployment whose brand colour really is red.
    const server = await serve(
      page(".freva-db{--accent:#d92d20 !important;--danger:#d92d20 !important}"),
    );
    try {
      await browser.goto(server.url);
      await browser.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });

      /**
       * Put the project facet into a known mode from scratch. Every scenario below resets first,
       * so none of them depends on what the previous one left behind.
       */
      const SETUP = async (mode) => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const root = document.querySelector(".freva-db");
        const clearAll = [...root.querySelectorAll("button")].find((b) =>
          /clear all/i.test(b.textContent ?? ""),
        );
        if (clearAll && !clearAll.disabled) {
          clearAll.click();
          await sleep(700);
        }
        if (root.querySelector('.ctrl[aria-label="Browse"]'))
          root.querySelector('.ctrl[aria-label="Browse"]').click();
        await sleep(250);
        const head = [...root.querySelectorAll(".facet-head")].find((h) =>
          /project/i.test(h.textContent ?? ""),
        );
        if (!head.closest(".facet").classList.contains("open")) head.click();
        await sleep(250);
        const rows = () => [...root.querySelectorAll(".side-scroll .fval-row")];
        if (mode.include) {
          for (let i = 0; i < mode.include; i++) {
            rows()[i].querySelector(".fval").click();
            await sleep(450);
          }
        }
        if (mode.exclude) {
          for (let i = 0; i < mode.exclude; i++) {
            const rs = rows();
            rs[rs.length - 1 - i].querySelector(".fval-ex").click();
            await sleep(450);
          }
        }
        return true;
      };

      const READ = () => {
        const root = document.querySelector(".freva-db");
        const style = (n) => {
          if (!n) return null;
          const cs = getComputedStyle(n);
          return {
            text: n.querySelector(".fb-n")?.textContent ?? n.textContent,
            borderStyle: cs.borderTopStyle,
            filled: cs.backgroundColor !== "rgba(0, 0, 0, 0)",
            tag: n.tagName,
            // A button inside a button is invalid and unreachable for some AT.
            nested: n.parentElement?.closest("button") !== null,
            aria: n.getAttribute("aria-label"),
          };
        };
        const exRow = [...root.querySelectorAll(".side-scroll .fval-row.excl")][0];
        const exLabel = exRow?.querySelector(".nm");
        const exBtn = exRow?.querySelector(".fval-ex");
        return {
          inc: style(root.querySelector('.facet[data-key="project"] .fb-inc')),
          exc: style(root.querySelector('.facet[data-key="project"] .fb-exc')),
          excludedValue: exLabel
            ? {
                lineThrough: /line-through/.test(getComputedStyle(exLabel).textDecorationLine),
                marker: getComputedStyle(exLabel, "::before").content,
              }
            : null,
          excludedControl: exBtn ? getComputedStyle(exBtn).borderTopStyle : null,
          accent: getComputedStyle(root).getPropertyValue("--accent").trim(),
        };
      };

      // Mixed: one `+2` button and one `-1` button
      await browser.evaluate(SETUP, { include: 2, exclude: 1 });
      const mixed = await browser.evaluate(READ);
      push(
        "mixed mode @red accent: `+2` filled and `-1` DASHED, as TWO separate buttons",
        mixed.inc?.text === "+2" &&
          mixed.inc.filled === true &&
          mixed.inc.tag === "BUTTON" &&
          mixed.inc.nested === false &&
          mixed.exc?.text === "\u22121" &&
          mixed.exc.borderStyle === "dashed" &&
          mixed.exc.filled === false &&
          mixed.exc.tag === "BUTTON" &&
          mixed.exc.nested === false &&
          /clear 2 included project values/i.test(mixed.inc.aria ?? "") &&
          /clear 1 excluded project value/i.test(mixed.exc.aria ?? "") &&
          mixed.accent === "#d92d20",
        mixed,
      );
      push(
        "mixed mode: the excluded value in the LIST is struck, not-equal-marked, dashed control",
        mixed.excludedValue?.lineThrough === true &&
          /\u2260/.test(mixed.excludedValue?.marker ?? "") &&
          mixed.excludedControl === "dashed",
        { value: mixed.excludedValue, control: mixed.excludedControl },
      );

      // The GLOBAL header is unchanged: ONE number
      const global = await browser.evaluate(() => {
        const root = document.querySelector(".freva-db");
        const badge = root.querySelector(".side-filterhead .sf-badge");
        const n = badge.querySelector(".sf-n");
        const x = badge.querySelector(".sf-x");
        const box = badge.getBoundingClientRect();
        const rest = {
          n: n.textContent,
          nShown: getComputedStyle(n).display !== "none",
          xShown: getComputedStyle(x).display !== "none",
          w: Math.round(box.width * 100) / 100,
          h: Math.round(box.height * 100) / 100,
        };
        // No breakdown here - that belongs to the per-facet controls.
        const breakdown = badge.querySelectorAll(".fb-inc, .fb-exc").length;
        return { rest, breakdown, aria: badge.getAttribute("aria-label"), tag: badge.tagName };
      });
      push(
        "global Filter: ONE total, no +N / -N, and its accessible name is unchanged",
        global.rest.n === "3" &&
          global.rest.nShown === true &&
          global.rest.xShown === false &&
          global.breakdown === 0 &&
          global.tag === "BUTTON" &&
          /clear all 3 filters/i.test(global.aria ?? ""),
        global,
      );

      // Hover and keyboard focus both swap the number for ONE centred cross, and the number is
      // completely out of the flow while the cross shows - not merely covered by it.
      const swap = await browser.evaluate(async () => {
        const root = document.querySelector(".freva-db");
        const badge = root.querySelector(".side-filterhead .sf-badge");
        const b = badge.getBoundingClientRect();
        const read = () => {
          const n = badge.querySelector(".sf-n");
          const x = badge.querySelector(".sf-x");
          const nb = n.getBoundingClientRect();
          const xb = x.getBoundingClientRect();
          const box = badge.getBoundingClientRect();
          return {
            nShown: getComputedStyle(n).display !== "none",
            xShown: getComputedStyle(x).display !== "none",
            // "Hidden" has to mean NO BOX, not `opacity: 0` sitting under the cross.
            nBox: Math.round(nb.width) + Math.round(nb.height),
            xText: x.textContent,
            // The cross is centred in the badge.
            dx: Math.round((xb.left + xb.width / 2 - (box.left + box.width / 2)) * 10) / 10,
            dy: Math.round((xb.top + xb.height / 2 - (box.top + box.height / 2)) * 10) / 10,
            w: Math.round(box.width * 100) / 100,
            h: Math.round(box.height * 100) / 100,
            colour: getComputedStyle(x).color,
          };
        };
        return { center: { x: b.left + b.width / 2, y: b.top + b.height / 2 }, before: read() };
      });
      await browser.mouse.move(swap.center.x, swap.center.y);
      await browser.evaluate(() => new Promise((r) => setTimeout(r, 150)));
      const hovered = await browser.evaluate(() => {
        const badge = document.querySelector(".freva-db .side-filterhead .sf-badge");
        const n = badge.querySelector(".sf-n");
        const x = badge.querySelector(".sf-x");
        const nb = n.getBoundingClientRect();
        const xb = x.getBoundingClientRect();
        const box = badge.getBoundingClientRect();
        return {
          nShown: getComputedStyle(n).display !== "none",
          xShown: getComputedStyle(x).display !== "none",
          nBox: Math.round(nb.width) + Math.round(nb.height),
          xText: x.textContent,
          dx: Math.round((xb.left + xb.width / 2 - (box.left + box.width / 2)) * 10) / 10,
          dy: Math.round((xb.top + xb.height / 2 - (box.top + box.height / 2)) * 10) / 10,
          w: Math.round(box.width * 100) / 100,
          h: Math.round(box.height * 100) / 100,
          // Count PSEUDO-ELEMENT crosses as well: a red x drawn with `::after` is invisible to
          // any element query.
          crosses:
            [...badge.querySelectorAll("*")].filter(
              (e) =>
                /^[\u00d7\u2715\u2716x]$/.test((e.textContent ?? "").trim()) &&
                getComputedStyle(e).display !== "none",
            ).length +
            [badge, ...badge.querySelectorAll("*")].filter((e) =>
              /[\u00d7\u2715\u2716]/.test(getComputedStyle(e, "::after").content),
            ).length,
          xColour: getComputedStyle(x).color,
          badgeColour: getComputedStyle(badge).color,
        };
      });
      await browser.mouse.move(5, 5);
      push(
        "global Filter: hover swaps the number for ONE centred cross, with no number underneath",
        hovered.nShown === false &&
          hovered.nBox === 0 &&
          hovered.xShown === true &&
          hovered.xText === "\u00d7" &&
          hovered.crosses === 1 &&
          // NEUTRAL: the badge's own text colour, never the danger red the fixture's accent is.
          hovered.xColour === hovered.badgeColour &&
          hovered.xColour !== "rgb(217, 45, 32)" &&
          Math.abs(hovered.dx) <= 1.5 &&
          Math.abs(hovered.dy) <= 1.5 &&
          Math.abs(hovered.w - swap.before.w) <= 0.5 &&
          Math.abs(hovered.h - swap.before.h) <= 0.5,
        { before: swap.before, hovered },
      );

      // The per-facet badges swap the same way, in a NEUTRAL colour
      const facetHover = await browser.evaluate(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const root = document.querySelector(".freva-db");
        const out = {};
        for (const cls of ["fb-inc", "fb-exc"]) {
          const b = root.querySelector(`.facet[data-key="project"] .${cls}`);
          if (!b) {
            out[cls] = { missing: true };
            continue;
          }
          const before = b.getBoundingClientRect();
          b.focus(); // keyboard focus, not just hover
          await sleep(150);
          const n = b.querySelector(".fb-n");
          const x = b.querySelector(".fb-x");
          const nb = n.getBoundingClientRect();
          const xb = x.getBoundingClientRect();
          const box = b.getBoundingClientRect();
          out[cls] = {
            nShown: getComputedStyle(n).display !== "none",
            nBox: Math.round(nb.width) + Math.round(nb.height),
            xShown: getComputedStyle(x).display !== "none",
            xText: x.textContent,
            xColour: getComputedStyle(x).color,
            textColour: getComputedStyle(b).color,
            dx: Math.round((xb.left + xb.width / 2 - (box.left + box.width / 2)) * 10) / 10,
            dy: Math.round((xb.top + xb.height / 2 - (box.top + box.height / 2)) * 10) / 10,
            sameW: Math.abs(box.width - before.width) <= 0.5,
            sameH: Math.abs(box.height - before.height) <= 0.5,
            borderStyle: getComputedStyle(b).borderTopStyle,
          };
          b.blur();
          await sleep(100);
        }
        // The accent is red in this fixture: a red cross would be indistinguishable from it.
        out.accent = getComputedStyle(root).getPropertyValue("--accent").trim();
        out.danger = getComputedStyle(root).getPropertyValue("--danger").trim();
        return out;
      });
      push(
        "per-facet badges: focus swaps count -> ONE centred cross, same size, NEUTRAL colour",
        ["fb-inc", "fb-exc"].every((c) => {
          const m = facetHover[c];
          return (
            !m.missing &&
            m.nShown === false &&
            m.nBox === 0 &&
            m.xShown === true &&
            m.xText === "\u00d7" &&
            m.sameW &&
            m.sameH &&
            Math.abs(m.dx) <= 1.5 &&
            Math.abs(m.dy) <= 1.5 &&
            m.xColour === m.textColour &&
            m.xColour !== "rgb(217, 45, 32)"
          );
        }) &&
          facetHover["fb-inc"].borderStyle === "solid" &&
          facetHover["fb-exc"].borderStyle === "dashed",
        facetHover,
      );

      // Clearing one mode leaves the other alone
      const independent = await browser.evaluate(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const root = document.querySelector(".freva-db");
        window.__requests.length = 0;
        const before = JSON.parse(JSON.stringify(window.__h.getState().selected));
        const excBtn = root.querySelector('.facet[data-key="project"] .fb-exc');
        if (!excBtn) return { before, missing: "no -N control" };
        excBtn.click();
        await sleep(800);
        const afterExc = {
          selected: JSON.parse(JSON.stringify(window.__h.getState().selected)),
          searches: window.__requests.filter((u) => u.includes("extended-search")).length,
          chips: [...root.querySelectorAll(".chips .chip")].map((c) => c.textContent),
          url: window.__h.getState().selected,
          badges: [...root.querySelectorAll('.facet[data-key="project"] .fh-count')].map(
            (b) => b.className,
          ),
        };
        window.__requests.length = 0;
        root.querySelector('.facet[data-key="project"] .fb-inc')?.click();
        await sleep(800);
        const afterInc = {
          selected: JSON.parse(JSON.stringify(window.__h.getState().selected)),
          searches: window.__requests.filter((u) => u.includes("extended-search")).length,
        };
        return { before, afterExc, afterInc };
      });
      push(
        "clearing `-N` leaves the inclusions alone, in exactly ONE search",
        !independent.missing &&
          independent.before.project_not_?.length === 1 &&
          independent.afterExc?.selected.project?.length === 2 &&
          !("project_not_" in (independent.afterExc?.selected ?? {})) &&
          independent.afterExc?.searches === 1 &&
          independent.afterExc?.chips.every((c) => !/≠/.test(c ?? "")) &&
          independent.afterExc?.badges.length === 1 &&
          independent.afterExc?.badges[0].includes("fb-inc"),
        independent.afterExc,
      );
      push(
        "…and clearing `+N` afterwards empties the facet, again in ONE search",
        !independent.missing &&
          Object.keys(independent.afterInc.selected ?? { x: 1 }).length === 0 &&
          independent.afterInc?.searches === 1,
        independent.afterInc,
      );

      // Negative chips are colour-neutral
      await browser.evaluate(SETUP, { include: 0, exclude: 1 });
      const chip = await browser.evaluate(() => {
        const root = document.querySelector(".freva-db");
        const c = root.querySelector(".chips .chip.neg");
        if (!c) return { error: "no negative chip" };
        const cs = getComputedStyle(c);
        const part = (sel) => {
          const n = c.querySelector(sel);
          if (!n) return null;
          const s = getComputedStyle(n);
          return { text: n.textContent, strike: /line-through/.test(s.textDecorationLine) };
        };
        const RED = /rgb\(217, 45, 32\)/;
        return {
          error: null,
          borderStyle: cs.borderTopStyle,
          borderColour: cs.borderTopColor,
          colour: cs.color,
          textColour: getComputedStyle(root).getPropertyValue("--text").trim(),
          hatch: cs.backgroundImage,
          hasHatch: /repeating-linear-gradient/.test(cs.backgroundImage),
          animated: cs.animationName,
          // NOTHING about this chip may be the danger/accent red.
          anyRed: [cs.color, cs.borderTopColor, cs.backgroundColor, cs.backgroundImage].some((v) =>
            RED.test(v),
          ),
          k: part(".chip-k"),
          op: part(".chip-op"),
          v: part(".chip-v"),
          tag: part(".chip-tag"),
          x: !!c.querySelector(".x"),
          ellipsis: getComputedStyle(c.querySelector(".chip-v")).textOverflow,
        };
      });
      push(
        "negative chip: dotted, hatched, neutral - no red anywhere, and NOT / not-equal intact",
        !chip.error &&
          chip.borderStyle === "dotted" &&
          chip.hasHatch &&
          chip.animated === "none" &&
          chip.anyRed === false &&
          chip.tag?.text === "NOT" &&
          chip.op?.text?.includes("\u2260") &&
          chip.x === true &&
          chip.ellipsis === "ellipsis",
        chip,
      );
      push(
        "negative CHIP: nothing is struck through - there the value IS the label you have to read",
        chip.v?.strike === false &&
          chip.k?.strike === false &&
          chip.op?.strike === false &&
          chip.tag?.strike === false,
        { k: chip.k, op: chip.op, v: chip.v, tag: chip.tag },
      );

      // Dark, light, greyscale and forced colours.
      const presets = await browser.evaluate(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const root = document.querySelector(".freva-db");
        const out = {};
        for (const theme of ["day", "night"]) {
          root.setAttribute("data-theme", theme);
          await sleep(200);
          const c = root.querySelector(".chips .chip.neg");
          const cs = getComputedStyle(c);
          out[theme] = {
            borderStyle: cs.borderTopStyle,
            hasHatch: /repeating-linear-gradient/.test(cs.backgroundImage),
            colour: cs.color,
            anyRed: /rgb\(217, 45, 32\)/.test(`${cs.color}${cs.borderTopColor}`),
          };
        }
        root.style.filter = "grayscale(1)";
        const c = root.querySelector(".chips .chip.neg");
        out.mono = {
          borderStyle: getComputedStyle(c).borderTopStyle,
          hasHatch: /repeating-linear-gradient/.test(getComputedStyle(c).backgroundImage),
          tag: c.querySelector(".chip-tag")?.textContent,
          strike: /line-through/.test(
            getComputedStyle(c.querySelector(".chip-v")).textDecorationLine,
          ),
        };
        root.style.filter = "";
        return out;
      });
      await browser.emulateMedia({ forcedColors: "active" });
      const forcedChip = await browser.evaluate(() => {
        const c = document.querySelector(".freva-db .chips .chip.neg");
        const cs = getComputedStyle(c);
        return {
          borderStyle: cs.borderTopStyle,
          hatch: cs.backgroundImage,
          tag: c.querySelector(".chip-tag")?.textContent,
          op: c.querySelector(".chip-op")?.textContent,
        };
      });
      await browser.emulateMedia({ forcedColors: "none" });
      push(
        "negative chip reads the same in dark, light, greyscale and forced colours",
        ["day", "night"].every(
          (t) => presets[t].borderStyle === "dotted" && presets[t].hasHatch && !presets[t].anyRed,
        ) &&
          presets.mono.borderStyle === "dotted" &&
          presets.mono.strike === false &&
          presets.mono.tag === "NOT" &&
          // In forced colours the hatch goes and the dotted border + NOT + != carry it alone.
          forcedChip.borderStyle === "dotted" &&
          forcedChip.hatch === "none" &&
          forcedChip.tag === "NOT" &&
          forcedChip.op?.includes("\u2260"),
        { presets, forced: forcedChip },
      );

      // Time and BBox each count as ONE positive constraint
      const geo = await browser.evaluate(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const root = document.querySelector(".freva-db");
        root.querySelector('.ctrl[aria-label="Browse"]')?.click();
        await sleep(300);
        const clearAll = [...root.querySelectorAll("button")].find((b) =>
          /clear all/i.test(b.textContent ?? ""),
        );
        clearAll?.click();
        await sleep(700);
        root.querySelector('[aria-label="Command terminal"]').click();
        await sleep(400);
        const ed = document.querySelector('.freva-term .term-view[data-cmd="cli"] .te-editor');
        const rich = ed.dataset.mode === "rich";
        const node = rich ? ed.querySelector(".te-cmd") : ed.querySelector("textarea");
        node.focus();
        const text = 'bbox=-10,10,35,60 time="2000 TO 2010" project=cmip6 project_not_=cmip5 ';
        if (rich) node.textContent = text;
        else node.value = text;
        node.dispatchEvent(new InputEvent("input", { bubbles: true }));
        await sleep(150);
        node.blur();
        await sleep(900);
        document.querySelector('.freva-db [aria-label="Command terminal"]').click();
        await sleep(300);
        return {
          state: {
            time: !!window.__h.getState().time,
            bbox: !!window.__h.getState().bbox,
            selected: window.__h.getState().selected,
          },
          total: root.querySelector(".side-filterhead .sf-n")?.textContent ?? null,
          breakdown: root.querySelectorAll(".side-filterhead .fb-inc, .side-filterhead .fb-exc")
            .length,
          aria: root.querySelector(".side-filterhead .sf-badge")?.getAttribute("aria-label"),
        };
      });
      push(
        "Time and BBox each add ONE constraint to the single global total: `FILTER 4`",
        geo.state.time &&
          geo.state.bbox &&
          geo.total === "4" &&
          geo.breakdown === 0 &&
          /clear all 4 filters/i.test(geo.aria ?? ""),
        geo,
      );
    } finally {
      await server.close();
    }
  }

  return checks;
});

process.exit(
  report("paired controls, terminal colours, minimized palette, +/- indicators", result),
);
