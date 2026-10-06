// The notebook, end to end: the pinned Notebook interface with the Freva Python kernel, under the
// notebook's real CSP, on a separate runtime origin and a separate data origin.
//
// What it proves:
//   1. real cells in the Notebook app on ONE engine worker: pandas/xarray as sanitised HTML, a
//      Matplotlib figure, a remote Zarr read (the no-JSPI notice is in notebook-integrity.mjs);
//   2. zero CSP violations under a policy with no 'unsafe-eval' and no inline scripts;
//   3. interrupt reaches the engine; a tight loop is stopped by the hard restart, which says so;
//   4. no request leaves the three origins it was given.
// and the fixture: markdown attachment, dependent cells, SVG/PNG, a figure across cells, an error
// with stop-on-error, hostile HTML/SVG, keyboard paths, .ipynb round trip, malformed upload.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  EXIT_NOT_RUN,
  HERE,
  PKG,
  STRICT,
  cells,
  instrumentedPage,
  kernelIdle,
  launch,
  menu,
  openNotebook,
  report,
  serveSite,
  setCell,
  testSite,
  violations,
} from "./lite-harness.mjs";

const checks = [];
const check = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail });

let site;
try {
  site = await testSite();
} catch (error) {
  console.log(`NOT RUN: the notebook site could not be built: ${error.message.split("\n")[0]}`);
  process.exit(STRICT ? 1 : EXIT_NOT_RUN);
}

let browser;
try {
  browser = await launch();
} catch (error) {
  console.log(`NOT RUN: browser unavailable: ${String(error).split("\n")[0]}`);
  process.exit(STRICT ? 1 : EXIT_NOT_RUN);
}

const servers = await serveSite(site);
const context = await browser.newContext({
  acceptDownloads: true,
  viewport: { width: 1280, height: 900 },
});
const { page, record } = await instrumentedPage(context);
const workers = new Set();
page.on("worker", (w) => workers.add(w.url()));

/** Run one scenario; a failure is a failed check, never a crashed suite. */
async function scenario(name, work) {
  const started = Date.now();
  try {
    await work();
  } catch (error) {
    check(
      `${name}: completed`,
      false,
      String(error?.message ?? error)
        .split("\n")
        .slice(0, 3)
        .join(" | "),
    );
    await page
      .screenshot({ path: join(PKG, `.test-failure-${name.replace(/\W+/g, "-")}.png`) })
      .catch(() => undefined);
  }
  console.log(`  [${name}] ${Date.now() - started} ms`);
}

try {
  await scenario("fixture", async () => {
    await openNotebook(page, servers.notebook.url, "fixture.ipynb");
    await page
      .waitForFunction(
        () => /Freva/.test(document.querySelector(".jp-KernelName")?.textContent ?? ""),
        null,
        { timeout: 30_000 },
      )
      .catch(() => undefined);
    const banner = await page.locator(".jp-KernelName").first().textContent();
    check("the kernel is Freva Python", /Freva Python/.test(banner ?? ""), banner);
    await menu(page, "Run", "Run All Cells");
    await kernelIdle(page, 600_000);
    const all = await cells(page);
    const code = all.filter((c) => c.kind === "code");
    const md = all.find((c) => c.kind === "markdown");
    check(
      "a markdown attachment renders as an image",
      /<img[^>]+src="(data:image\/png|blob:)/.test(md?.html ?? ""),
      md?.html.slice(0, 200),
    );
    check(
      "counts are assigned in order, from 1, to the cells that ran",
      code.slice(0, 9).every((c, i) => c.prompt === `[${i + 1}]:`),
      code.map((c) => c.prompt).join(" "),
    );
    check("two dependent cells: x * 2 is 42", /\b42\b/.test(code[1]?.text ?? ""), code[1]?.text);
    check(
      "a pandas DataFrame renders as a sanitised table",
      /fv-html/.test(code[2]?.html ?? "") &&
        /<table[^>]*class="dataframe"/.test(code[2]?.html ?? "") &&
        !/<style/.test(code[2]?.html ?? ""),
      code[2]?.html.slice(0, 200),
    );
    check(
      "an xarray Dataset renders with its collapsible sections and namespaced ids",
      /class="xr-wrap"/.test(code[3]?.html ?? "") &&
        /id="fv[a-z0-9]+-section-/.test(code[3]?.html ?? "") &&
        !/style=/.test(code[3]?.html ?? ""),
      code[3]?.html.slice(0, 200),
    );
    const sectionToggles = await page.evaluate(() => {
      const labels = [
        ...(document
          .querySelectorAll(".jp-CodeCell")[3]
          ?.querySelectorAll("label.xr-section-summary[for]") ?? []),
      ];
      const label = labels.find((l) => !document.getElementById(l.getAttribute("for"))?.disabled);
      const input = label && document.getElementById(label.getAttribute("for"));
      if (!label || !input) return null;
      const before = input.checked;
      label.click();
      return before !== input.checked;
    });
    check(
      "…and its section labels toggle their own checkboxes",
      sectionToggles === true,
      String(sectionToggles),
    );
    check(
      "an SVG is shown as an image, never inline, with its script and foreignObject gone",
      /<img[^>]+src="blob:/.test(code[4]?.html ?? "") &&
        !/<svg[\s>][^]*<rect/.test(code[4]?.html ?? ""),
      code[4]?.html.slice(0, 200),
    );
    const svgSource = await page.evaluate(async () => {
      const img = document.querySelectorAll(".jp-CodeCell")[4]?.querySelector("img");
      return img ? await (await fetch(img.src)).text() : null;
    });
    check(
      "…and the SVG it shows has no script, handler or foreignObject",
      svgSource !== null &&
        /<rect/.test(svgSource) &&
        !/script|onload|foreignObject/i.test(svgSource),
      svgSource?.slice(0, 200),
    );
    const hostile = code[5]?.html ?? "";
    check(
      "hostile HTML is neutralised: no script, handler, style, frame, form or javascript: URL",
      !/<script|onerror|<style|style=|<iframe|<form|javascript:/i.test(hostile) &&
        /safe/.test(hostile),
      hostile.slice(0, 300),
    );
    check("…and nothing it carried ran", (await page.evaluate(() => window.__pwned)) === undefined);
    check(
      "a Matplotlib figure is displayed as a PNG",
      /<img[^>]+src="blob:/.test(code[6]?.html ?? ""),
      code[6]?.html.slice(0, 200),
    );
    check(
      "a figure built across cells is shown again as the result",
      /<img[^>]+src="blob:/.test(code[7]?.html ?? "") &&
        /jp-OutputArea-executeResult/.test(code[7]?.html ?? ""),
      code[7]?.html.slice(0, 200),
    );
    check(
      "an error keeps the output before it and shows a structured traceback",
      /before/.test(code[8]?.text ?? "") &&
        /ValueError/.test(code[8]?.text ?? "") &&
        /boom/.test(code[8]?.text ?? ""),
      code[8]?.text,
    );
    check(
      "stop-on-error: the cell after the error did not run and has no count",
      !/never/.test(code[9]?.text ?? "") && !/\d/.test(code[9]?.prompt ?? ""),
      `${code[9]?.prompt} ${code[9]?.text}`,
    );
  });

  await scenario("one engine", async () => {
    const engineWorkers = [...workers].filter((u) => u.includes("browser-python.worker.js"));
    check(
      "exactly one engine worker runs the notebook",
      engineWorkers.length === 1,
      JSON.stringify([...workers]),
    );
  });

  await scenario("keyboard", async () => {
    await openNotebook(page, servers.notebook.url, "scratch.ipynb");
    await setCell(page, 0, "6 * 7");
    await page.keyboard.press("Control+Enter");
    await kernelIdle(page);
    let all = await cells(page);
    check(
      "Ctrl+Enter runs the cell in place",
      /42/.test(all[0]?.text ?? "") && all.length === 1,
      `${all.length} cells`,
    );
    await page.locator(".jp-Notebook .jp-Cell").nth(0).locator(".cm-content").click();
    await page.keyboard.press("Shift+Enter");
    await kernelIdle(page);
    all = await cells(page);
    check("Shift+Enter runs and advances to a new cell", all.length === 2, `${all.length} cells`);
    await page.locator(".jp-Notebook .jp-Cell").nth(1).locator(".cm-content").click();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Tab");
    const inEditor = await page.evaluate(() => !!document.activeElement?.closest(".cm-editor"));
    check(
      "Escape then Tab leaves the editor",
      !inEditor,
      await page.evaluate(() => document.activeElement?.className),
    );
  });

  await scenario("completion", async () => {
    // Jupyter counts code points, the engine UTF-16 units: an astral character before the cursor
    // is where a wrong conversion shows.
    await setCell(page, 1, "value_after_emoji = 1");
    await page.keyboard.press("Control+Enter");
    await kernelIdle(page);
    await setCell(page, 1, 's = "😀😀"; value_after_e');
    await page.keyboard.press("Tab");
    await page.waitForSelector(".jp-Completer-item", { timeout: 15_000 });
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    const source = await page
      .locator(".jp-Notebook .jp-Cell")
      .nth(1)
      .locator(".cm-content")
      .textContent();
    check(
      "Tab completion through the kernel, past astral characters",
      source === 's = "😀😀"; value_after_emoji',
      source,
    );
  });

  await scenario("remote zarr", async () => {
    await setCell(
      page,
      1,
      `import xarray as xr\nds = xr.open_zarr("${servers.data.url}/zarr-v3", consolidated=True, chunks=None)\nfloat(ds["sfcWind"].isel(time=0).mean())`,
    );
    await page.keyboard.press("Control+Enter");
    await kernelIdle(page, 300_000);
    const all = await cells(page);
    check(
      "a remote Zarr store is read over HTTP from another origin",
      /\]:\s*\d+\.\d+\s*$/.test(all[1]?.text ?? ""),
      all[1]?.text?.slice(0, 300),
    );
  });

  await scenario("interrupt", async () => {
    await openNotebook(page, servers.notebook.url, "interrupt.ipynb");
    await menu(page, "Run", "Run All Cells");
    await page.waitForFunction(() =>
      document.querySelector(".jp-InputPrompt")?.textContent.includes("*"),
    );
    await page.waitForTimeout(1500);
    await page.click('[data-command="notebook:interrupt-kernel"]');
    await kernelIdle(page, 30_000);
    const all = await cells(page);
    check(
      "interrupt reaches the engine: the awaiting cell raises KeyboardInterrupt",
      /KeyboardInterrupt/.test(all[0]?.text ?? ""),
      all[0]?.text,
    );
    check(
      "…and the queued cell is cancelled, without a count",
      !/\d/.test(all[1]?.prompt ?? ""),
      all[1]?.prompt,
    );
  });

  await scenario("hard restart", async () => {
    await openNotebook(page, servers.notebook.url, "scratch.ipynb");
    await setCell(page, 0, "kept = 1\nwhile True:\n    pass");
    await page.keyboard.press("Control+Enter");
    await page.waitForTimeout(2000);
    await page.click('[data-command="notebook:interrupt-kernel"]');
    const dialog = page.locator(".jp-Dialog");
    await dialog.waitFor({ timeout: 20_000 });
    check(
      "an interrupt that does not land offers a hard restart",
      /did not stop/.test(await dialog.textContent()),
      await dialog.textContent(),
    );
    await page.click('.jp-Dialog button:has-text("Restart Python")');
    await kernelIdle(page, 300_000);
    const all = await cells(page);
    check(
      "…which stops the loop and says Python state was lost",
      /Python state was lost/.test(all[0]?.text ?? ""),
      all[0]?.text,
    );
    await setCell(page, 0, "kept");
    await page.keyboard.press("Control+Enter");
    await kernelIdle(page, 120_000);
    const after = await cells(page);
    check(
      "…and the restarted interpreter is fresh",
      /NameError/.test(after[0]?.text ?? ""),
      after[0]?.text,
    );
  });

  await scenario("round trip", async () => {
    await openNotebook(page, servers.notebook.url, "fixture.ipynb");
    const download = async () => {
      const [file] = await Promise.all([
        page.waitForEvent("download"),
        menu(page, "File", "Download"),
      ]);
      return JSON.parse(readFileSync(await file.path(), "utf8"));
    };
    const first = await download();
    const second = await download();
    const ids = (nb) => nb.cells.map((c) => c.id).join(",");
    check(
      "a downloaded notebook is nbformat 4.5",
      first.nbformat === 4 && first.nbformat_minor === 5,
      `${first.nbformat}.${first.nbformat_minor}`,
    );
    check(
      "…with stable cell ids",
      ids(first) === ids(second) && first.cells.every((c) => typeof c.id === "string"),
      ids(first),
    );
  });

  await scenario("upload", async () => {
    await page.goto(`${servers.notebook.url}/tree/index.html`);
    await page.waitForSelector(".jp-DirListing", { timeout: 60_000 });
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.click('.jp-ToolbarButtonComponent[title*="Upload"], button:has-text("Upload")'),
    ]);
    await chooser.setFiles(join(HERE, "fixtures", "malformed.ipynb"));
    const dialog = page.locator(".jp-Dialog");
    await dialog.waitFor({ timeout: 20_000 }).catch(() => undefined);
    const text = (await dialog.textContent().catch(() => "")) ?? "";
    check(
      "a malformed .ipynb upload is refused with the reason",
      /not a valid notebook/.test(text),
      text.slice(0, 200),
    );
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
    const listed = await page.locator(".jp-DirListing-itemText").allTextContents();
    check("…and is not stored", !listed.some((n) => n.includes("malformed")), listed.join(", "));
  });

  const seen = await violations(page, record);
  check(
    "zero CSP violations, under no 'unsafe-eval' and no inline script",
    seen.length === 0,
    seen.slice(0, 5).join(" | "),
  );
  check(
    "the policy really is that strict",
    !/'unsafe-eval'/.test(servers.csp) && !/script-src[^;]*unsafe-inline/.test(servers.csp),
    servers.csp,
  );
  const allowed = new Set([servers.notebook.url, servers.runtime.url, servers.data.url]);
  const strays = [...record.origins].filter(
    (o) => !allowed.has(o) && !/^(blob|data):|^null$/.test(o),
  );
  check("no request leaves the operator-hosted origins", strays.length === 0, strays.join(", "));
  check(
    "no uncaught page errors",
    record.errors.length === 0,
    record.errors.slice(0, 3).join(" | "),
  );
} finally {
  await context.close().catch(() => undefined);
  await browser.close().catch(() => undefined);
  await servers.close();
}

process.exit(report("notebook: the Freva Python kernel in the Notebook interface", checks));
