/**
 * The file panel: what a visitor does with a file their Python just wrote.
 *
 * node browser-tests/console-files.mjs
 *
 * Against the mock engine, because what is under test is the component: which rows it draws, which
 * buttons it disables, how much of a file a preview reads, and whether Delete can happen by
 * accident. Every string here is a filename chosen by the visitor's own Python, so the panel is
 * built entirely with `createElement` and `textContent`.
 */
import { consolePage } from "./console-fixture.mjs";
import { bundleConsole, inBrowser, report, requireDist, serve } from "./harness.mjs";

requireDist();
bundleConsole();

const engine = process.env.BROWSER_ENGINE ?? "chromium";

/**
 * Stand in for both halves of the download story, without touching the component.
 * `showSaveFilePicker` is replaced by a fake handing back a writable that collects chunks; the
 * anchor fallback is intercepted too. `window.__picker.mode`: "stream" accepts, "cancel" rejects
 * the way a dismissed picker does, "fail" fails on the first write, "absent" removes the API so the
 * component takes the Blob path.
 */
const INSTRUMENT_DOWNLOADS = `
  window.__downloads = [];
  const realClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download) {
      window.__downloads.push({ download: this.download, href: this.href, rel: this.rel });
      return;
    }
    return realClick.call(this);
  };

  // Anything the component drops on the floor. A click handler that lets an exception escape shows
  // the visitor nothing at all, which is the failure these modes exist to catch.
  window.__uncaught = [];
  window.addEventListener("error", (event) => window.__uncaught.push(String(event.message)));
  window.addEventListener("unhandledrejection", (event) =>
    window.__uncaught.push(String(event.reason && event.reason.message)),
  );

  const realPicker = window.showSaveFilePicker;
  window.__picker = { mode: "stream", calls: [], written: [], closed: 0, aborted: 0, activation: [] };
  const fakePicker = (options) => {
    // Recorded at the moment of the call: the picker needs transient user activation, and a
    // component that awaited anything before calling it would show false here.
    window.__picker.activation.push(navigator.userActivation ? navigator.userActivation.isActive : null);
    window.__picker.calls.push(options);
    if (window.__picker.mode === "cancel") {
      const error = new Error("The user aborted a request.");
      error.name = "AbortError";
      return Promise.reject(error);
    }
    // SYNCHRONOUS throws, which is how this API actually fails in the two cases that matter: a
    // SecurityError when the activation has been spent or the frame may not show a picker, and a
    // TypeError where the method exists but refuses the call.
    if (window.__picker.mode === "throw-security") {
      const error = new Error("Must be handling a user gesture to show a file picker.");
      error.name = "SecurityError";
      throw error;
    }
    if (window.__picker.mode === "throw-type") {
      throw new TypeError("showSaveFilePicker is not available in this context");
    }
    return Promise.resolve({
      createWritable: async () => {
        if (window.__picker.mode === "no-writable") {
          const error = new Error("permission to write was denied");
          error.name = "NotAllowedError";
          throw error;
        }
        return ({
        write: async (chunk) => {
          if (window.__picker.mode === "fail") throw new Error("the disk went away");
          window.__picker.written.push(chunk.byteLength ?? chunk.length);
        },
        close: async () => { window.__picker.closed += 1; },
        abort: async () => { window.__picker.aborted += 1; },
      });
      },
    });
  };
  window.__setPicker = (mode) => {
    window.__picker.mode = mode;
    if (mode === "absent") delete window.showSaveFilePicker;
    else window.showSaveFilePicker = fakePicker;
  };
  window.__restorePicker = () => { window.showSaveFilePicker = realPicker; };
  window.__setPicker("stream");
`;

const result = await inBrowser(
  async (page) => {
    const server = await serve(consolePage());
    const checks = [];
    const ok = (name, pass, detail) => checks.push({ name, pass, detail: String(detail ?? "") });
    try {
      await page.goto(server.url);
      await page.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });
      await page.evaluate(INSTRUMENT_DOWNLOADS);
      await page.evaluate(() => window.__c.element.start());

      // nothing written, nothing shown
      ok(
        "the panel is not there until Python writes something",
        await page.evaluate(() => window.__c.q(".bp-files")?.hidden === true),
        "hidden",
      );

      // a file appears
      await page.evaluate(() => {
        window.__mock.addFile("surface_wind.nc", {
          mime: "application/x-netcdf",
          bytes: Array.from({ length: 2048 }, (_, i) => i % 256),
        });
      });
      const firstRow = await page.evaluate(() => {
        const row = window.__c.q(".bp-file");
        return {
          hidden: window.__c.q(".bp-files").hidden,
          name: row?.querySelector(".bp-file-name")?.textContent,
          meta: row?.querySelector(".bp-file-meta")?.textContent,
          note: window.__c.q(".bp-files-note")?.textContent,
          buttons: [...(row?.querySelectorAll("button") ?? [])].map((b) => ({
            label: b.textContent,
            disabled: b.disabled,
          })),
        };
      });
      ok(
        "a written file appears, named and sized, with three actions",
        firstRow.hidden === false &&
          firstRow.name === "surface_wind.nc" &&
          firstRow.meta === "2.0 KB" &&
          firstRow.buttons.map((b) => b.label).join(",") === "Preview,Download,Delete" &&
          firstRow.buttons.every((b) => !b.disabled),
        JSON.stringify(firstRow),
      );
      ok(
        "…and the panel counts them without nagging about a limit that is far away",
        firstRow.note === "1 file",
        firstRow.note,
      );

      // a text preview
      await page.evaluate(() => {
        const text = "time,tas\n0,280.0\n1,281.5\n";
        window.__mock.addFile("timeseries.csv", {
          mime: "text/csv",
          bytes: [...new TextEncoder().encode(text)],
        });
      });
      await page.evaluate(() => {
        const row = window.__c
          .qa(".bp-file")
          .find((r) => r.querySelector(".bp-file-name").textContent === "timeseries.csv");
        row.querySelector("button").click();
      });
      await page.waitForFunction(() => window.__c.q(".bp-file-preview-text") !== null, null, {
        timeout: 5000,
      });
      const preview = await page.evaluate(() => ({
        text: window.__c.q(".bp-file-preview-text")?.textContent,
        reads: window.__mock.reads,
        label: window.__c
          .qa(".bp-file")
          .find((r) => r.querySelector(".bp-file-name").textContent === "timeseries.csv")
          ?.querySelector("button")?.textContent,
      }));
      ok(
        "Preview shows a CSV as text, and asks for a capped slice rather than the whole file",
        preview.text?.startsWith("time,tas") &&
          preview.reads.at(-1)?.name === "timeseries.csv" &&
          preview.reads.at(-1)?.options.maxBytes === 65536,
        JSON.stringify({ text: preview.text?.slice(0, 20), read: preview.reads.at(-1) }),
      );
      ok("…and the button becomes Hide while it is open", preview.label === "Hide", preview.label);

      // one preview at a time, and images render
      await page.evaluate(() => {
        // A 1x1 PNG.
        const png =
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        window.__mock.addFile("plot.png", {
          mime: "image/png",
          bytes: [...atob(png)].map((c) => c.charCodeAt(0)),
        });
      });
      await page.evaluate(() => {
        const row = window.__c
          .qa(".bp-file")
          .find((r) => r.querySelector(".bp-file-name").textContent === "plot.png");
        row.querySelector("button").click();
      });
      await page.waitForFunction(() => window.__c.q(".bp-file-preview-media") !== null, null, {
        timeout: 5000,
      });
      const image = await page.evaluate(() => ({
        tag: window.__c.q(".bp-file-preview-media")?.tagName,
        src: window.__c.q(".bp-file-preview-media")?.getAttribute("src")?.slice(0, 5),
        alt: window.__c.q(".bp-file-preview-media")?.getAttribute("alt"),
        openPreviews: window.__c.qa(".bp-file-preview").length,
        wholeFile: window.__mock.reads.at(-1)?.options.maxBytes,
      }));
      ok(
        "an image previews inline from a blob URL, with the filename as its alt text",
        image.tag === "IMG" && image.src === "blob:" && image.alt === "plot.png",
        JSON.stringify(image),
      );
      ok(
        "…only one preview is open at a time, and an image is read whole rather than sliced",
        image.openPreviews === 1 && image.wholeFile === undefined,
        JSON.stringify({ open: image.openPreviews, maxBytes: image.wholeFile }),
      );

      // a type nothing can preview
      await page.evaluate(() => {
        window.__mock.addFile("opaque.bin", {
          mime: "application/octet-stream",
          bytes: [1, 2, 3, 4],
        });
        const row = window.__c
          .qa(".bp-file")
          .find((r) => r.querySelector(".bp-file-name").textContent === "opaque.bin");
        row.querySelector("button").click();
      });
      const opaque = await page.evaluate(() => window.__c.q(".bp-file-preview")?.textContent);
      ok(
        "an unpreviewable type says so, and points at Download",
        typeof opaque === "string" &&
          opaque.includes("application/octet-stream") &&
          opaque.includes("Download"),
        opaque,
      );

      // download: the streaming path
      const clickDownload = (name) =>
        page.evaluate((target) => {
          const row = window.__c
            .qa(".bp-file")
            .find((r) => r.querySelector(".bp-file-name").textContent === target);
          const button = [...row.querySelectorAll("button")].find(
            (b) => b.textContent === "Download",
          );
          button.click();
        }, name);

      await page.evaluate(() => {
        window.__picker.written.length = 0;
        window.__mock.streamDelayMs = 0;
      });
      await clickDownload("surface_wind.nc");
      await page.waitForFunction(() => window.__picker.closed > 0, null, { timeout: 10000 });
      const streamed = await page.evaluate(() => ({
        picked: window.__picker.calls.at(-1),
        chunks: window.__picker.written.length,
        bytes: window.__picker.written.reduce((a, b) => a + b, 0),
        closed: window.__picker.closed,
        aborted: window.__picker.aborted,
        anchors: window.__downloads.length,
        activation: window.__picker.activation.at(-1),
      }));
      ok(
        "Download streams into a file the user picked, in chunks, and closes it",
        streamed.picked?.suggestedName === "surface_wind.nc" &&
          streamed.chunks > 1 &&
          streamed.bytes === 2048 &&
          streamed.closed === 1 &&
          streamed.aborted === 0 &&
          streamed.anchors === 0,
        JSON.stringify(streamed),
      );
      ok(
        "…and the picker is opened while the click's user activation is still live",
        streamed.activation === true,
        `navigator.userActivation.isActive at the picker call: ${String(streamed.activation)}`,
      );

      // cancelling, from the row
      await page.evaluate(() => {
        window.__picker.written.length = 0;
        window.__picker.closed = 0;
        window.__picker.aborted = 0;
        // Slow enough that the transfer is genuinely in flight when Cancel is clicked.
        window.__mock.streamDelayMs = 60;
      });
      await clickDownload("surface_wind.nc");
      await page.waitForFunction(
        () =>
          window.__c
            .qa(".bp-file")
            .some((r) => [...r.querySelectorAll("button")].some((b) => b.textContent === "Cancel")),
        null,
        { timeout: 10000 },
      );
      const midTransfer = await page.evaluate(() => {
        const row = window.__c
          .qa(".bp-file")
          .find((r) => r.querySelector(".bp-file-name").textContent === "surface_wind.nc");
        return {
          meta: row.querySelector(".bp-file-meta").textContent,
          deleteDisabled: [...row.querySelectorAll("button")].at(-1).disabled,
          buttons: [...row.querySelectorAll("button")].map((b) => b.textContent),
        };
      });
      ok(
        "a transfer in flight shows progress, offers Cancel, and refuses Delete",
        midTransfer.buttons.includes("Cancel") &&
          midTransfer.deleteDisabled === true &&
          /downloading/.test(midTransfer.meta),
        JSON.stringify(midTransfer),
      );

      await page.evaluate(() => {
        const row = window.__c
          .qa(".bp-file")
          .find((r) => r.querySelector(".bp-file-name").textContent === "surface_wind.nc");
        [...row.querySelectorAll("button")].find((b) => b.textContent === "Cancel").click();
      });
      await page.waitForFunction(() => window.__picker.aborted > 0, null, { timeout: 10000 });
      const cancelled = await page.evaluate(() => ({
        aborted: window.__picker.aborted,
        closed: window.__picker.closed,
        wrote: window.__picker.written.reduce((a, b) => a + b, 0),
        buttons: window.__c
          .qa(".bp-file")
          .find((r) => r.querySelector(".bp-file-name").textContent === "surface_wind.nc")
          ?.querySelectorAll("button").length,
      }));
      ok(
        "Cancel aborts the destination rather than closing it - a partial file is never finished",
        cancelled.aborted === 1 && cancelled.closed === 0 && cancelled.wrote < 2048,
        JSON.stringify(cancelled),
      );

      // a picker the user dismisses is silent
      await page.evaluate(() => {
        window.__mock.streamDelayMs = 0;
        window.__setPicker("cancel");
      });
      const beforeDismiss = await page.evaluate(() => window.__c.q(".bp-status")?.textContent);
      await clickDownload("surface_wind.nc");
      await page.waitForTimeout(200);
      ok(
        "dismissing the file picker is not an error and says nothing",
        (await page.evaluate(() => window.__c.q(".bp-status")?.textContent)) === beforeDismiss,
        await page.evaluate(() => window.__c.q(".bp-status")?.textContent),
      );

      // a destination that fails part way through
      await page.evaluate(() => window.__setPicker("fail"));
      await clickDownload("surface_wind.nc");
      await page.waitForFunction(
        () => /disk went away/.test(window.__c.q(".bp-status")?.textContent ?? ""),
        null,
        { timeout: 10000 },
      );
      ok(
        "a destination that fails mid-write reports the reason and leaves nothing running",
        await page.evaluate(() =>
          window.__c
            .qa(".bp-file")
            .every(
              (r) => ![...r.querySelectorAll("button")].some((b) => b.textContent === "Cancel"),
            ),
        ),
        await page.evaluate(() => window.__c.q(".bp-status")?.textContent),
      );

      // a picker that throws where the click handler can see it
      for (const [mode, expected] of [
        ["throw-security", /user gesture/],
        ["throw-type", /not available in this context/],
        ["no-writable", /permission to write was denied/],
      ]) {
        await page.evaluate((m) => {
          window.__uncaught.length = 0;
          window.__setPicker(m);
        }, mode);
        await clickDownload("surface_wind.nc");
        await page.waitForTimeout(300);
        const state = await page.evaluate(() => ({
          status: window.__c.q(".bp-status")?.textContent ?? "",
          uncaught: window.__uncaught,
          running: window.__c
            .qa(".bp-file")
            .some((r) => [...r.querySelectorAll("button")].some((b) => b.textContent === "Cancel")),
        }));
        ok(
          `a picker failing with ${mode} is reported to the visitor, not dropped`,
          expected.test(state.status) && state.uncaught.length === 0 && !state.running,
          JSON.stringify(state),
        );
      }
      await page.evaluate(() => window.__setPicker("stream"));

      // the finishing phase: Cancel stops being offered. Once the destination starts committing,
      // every byte is written and the engine ignores cancellation, so a live Cancel button would
      // lie about what pressing it does. The row says "Finishing…" instead.
      await page.evaluate(() => {
        window.__setPicker("stream");
        window.__mock.streamDelayMs = 0;
        window.__mock.closeDelayMs = 400;
      });
      await clickDownload("surface_wind.nc");
      await page.waitForFunction(
        () =>
          (window.__c
            .qa(".bp-file")
            .find((r) => r.querySelector(".bp-file-name").textContent === "surface_wind.nc")
            ?.querySelector(".bp-file-meta")?.textContent ?? "") === "finishing…",
        null,
        { timeout: 10000 },
      );
      const finishing = await page.evaluate(() => {
        const row = window.__c
          .qa(".bp-file")
          .find((r) => r.querySelector(".bp-file-name").textContent === "surface_wind.nc");
        const buttons = [...row.querySelectorAll("button")].map((b) => ({
          label: b.textContent,
          disabled: b.disabled,
        }));
        return { meta: row.querySelector(".bp-file-meta").textContent, buttons };
      });
      ok(
        "while the destination is committing the row says so and Cancel is not offered",
        finishing.meta === "finishing…" &&
          finishing.buttons.some((b) => b.label === "Finishing…" && b.disabled) &&
          !finishing.buttons.some((b) => b.label === "Cancel"),
        JSON.stringify(finishing),
      );
      await page.waitForTimeout(600);
      await page.evaluate(() => {
        window.__mock.closeDelayMs = 0;
      });

      // a transfer that fails before the first byte still cleans up. The engine owns the
      // destination from the moment it is handed over, so the picked handle is left ABORTED,
      // exactly once, and never closed: a closed handle is a finished file.
      await page.evaluate(() => {
        window.__setPicker("stream");
        window.__picker.closed = 0;
        window.__picker.aborted = 0;
        window.__mock.addFile("vanishes.bin", { mime: "application/octet-stream", bytes: [1, 2] });
      });
      await page.evaluate(() => {
        // Gone from the engine, still on screen: exactly the race a user can hit by deleting from
        // one console while another has the row rendered.
        window.__mock.files.delete("vanishes.bin");
      });
      await clickDownload("vanishes.bin");
      await page.waitForTimeout(300);
      const orphaned = await page.evaluate(() => ({
        aborted: window.__picker.aborted,
        closed: window.__picker.closed,
        status: window.__c.q(".bp-status")?.textContent ?? "",
        uncaught: window.__uncaught,
      }));
      ok(
        "a download that fails before any bytes aborts the picked file exactly once",
        orphaned.aborted === 1 && orphaned.closed === 0 && orphaned.uncaught.length === 0,
        JSON.stringify(orphaned),
      );

      // no picker: a Blob below the cap, a refusal above it
      await page.evaluate(() => window.__setPicker("absent"));
      await clickDownload("surface_wind.nc");
      await page.waitForFunction(() => window.__downloads.length > 0, null, { timeout: 10000 });
      const fallback = await page.evaluate(() => window.__downloads.at(-1));
      ok(
        "with no file picker, a small artifact still downloads through a blob URL",
        fallback.download === "surface_wind.nc" && fallback.href.startsWith("blob:"),
        JSON.stringify(fallback),
      );

      await page.evaluate(() => {
        window.__mock.addFile("enormous.nc", {
          mime: "application/x-netcdf",
          bytes: [1, 2, 3],
        });
        // Only the REPORTED size matters for the refusal: the component must decide before it
        // reads anything, which is the entire point of refusing.
        window.__mock.files.get("enormous.nc").info.size = 64 * 1024 * 1024;
        window.__mock.emitArtifacts({ updated: ["enormous.nc"] });
      });
      const anchorsBefore = await page.evaluate(() => window.__downloads.length);
      await clickDownload("enormous.nc");
      await page.waitForTimeout(200);
      const refused = await page.evaluate(() => ({
        status: window.__c.q(".bp-status")?.textContent ?? "",
        anchors: window.__downloads.length,
      }));
      ok(
        "…but a large one is refused rather than built as a huge Blob",
        // The status line truncates long detail, so this asserts on what a visitor can actually
        // read there: the size, and that the reason is the missing picker.
        refused.anchors === anchorsBefore &&
          /no file picker to stream it into/.test(refused.status) &&
          /64 MB/.test(refused.status),
        refused.status,
      );
      await page.evaluate(() => {
        window.__setPicker("stream");
        window.__mock.files.delete("enormous.nc");
        window.__mock.emitArtifacts({ removed: ["enormous.nc"] });
      });

      // delete is two-step
      const armed = await page.evaluate(() => {
        const row = window.__c
          .qa(".bp-file")
          .find((r) => r.querySelector(".bp-file-name").textContent === "opaque.bin");
        row.querySelectorAll("button")[2].click();
        const after = window.__c
          .qa(".bp-file")
          .find((r) => r.querySelector(".bp-file-name").textContent === "opaque.bin");
        return {
          label: after.querySelectorAll("button")[2].textContent,
          deleted: window.__mock.deleted.length,
        };
      });
      ok(
        "one click on Delete arms it and deletes nothing",
        armed.label === "Confirm delete" && armed.deleted === 0,
        JSON.stringify(armed),
      );
      const confirmed = await page.evaluate(async () => {
        const row = window.__c
          .qa(".bp-file")
          .find((r) => r.querySelector(".bp-file-name").textContent === "opaque.bin");
        row.querySelectorAll("button")[2].click();
        await new Promise((r) => setTimeout(r, 20));
        return {
          deleted: window.__mock.deleted,
          names: window.__c.qa(".bp-file-name").map((n) => n.textContent),
        };
      });
      ok(
        "…and the second click deletes it, and the row goes",
        confirmed.deleted.join(",") === "opaque.bin" && !confirmed.names.includes("opaque.bin"),
        JSON.stringify(confirmed),
      );

      // a failed artifact is offered honestly
      await page.evaluate(() => {
        window.__mock.addFile("truncated.nc", {
          mime: "application/x-netcdf",
          bytes: [1, 2, 3],
          state: "failed",
          failure: "the browser's storage quota was exhausted after 3 bytes.",
        });
      });
      const failed = await page.evaluate(() => {
        const row = window.__c
          .qa(".bp-file")
          .find((r) => r.querySelector(".bp-file-name").textContent === "truncated.nc");
        return {
          state: row?.dataset.state,
          meta: row?.querySelector(".bp-file-meta")?.textContent,
          disabled: [...row.querySelectorAll("button")].map((b) => b.disabled),
        };
      });
      ok(
        "a failed artifact says why, cannot be previewed or downloaded, and can be deleted",
        failed.state === "failed" &&
          failed.meta?.startsWith("incomplete - ") &&
          failed.disabled.join(",") === "true,true,false",
        JSON.stringify(failed),
      );

      // a file Python is still writing
      await page.evaluate(() => {
        window.__mock.addFile("growing.nc", {
          mime: "application/x-netcdf",
          bytes: [1, 2, 3],
          state: "open",
        });
      });
      const open = await page.evaluate(() => {
        const row = window.__c
          .qa(".bp-file")
          .find((r) => r.querySelector(".bp-file-name").textContent === "growing.nc");
        return {
          meta: row?.querySelector(".bp-file-meta")?.textContent,
          disabled: [...row.querySelectorAll("button")].map((b) => b.disabled),
        };
      });
      ok(
        "a file still open in Python is labelled as such, and every action on it is refused",
        open.meta?.includes("still being written") && open.disabled.join(",") === "true,true,true",
        JSON.stringify(open),
      );

      // a filename is text, not markup
      await page.evaluate(() => {
        window.__mock.addFile("<img src=x onerror=alert(1)>.txt", { mime: "text/plain" });
      });
      const injected = await page.evaluate(() => ({
        text: window.__c
          .qa(".bp-file-name")
          .map((n) => n.textContent)
          .find((t) => t.includes("onerror")),
        images: window.__c.qa(".bp-files img").length,
      }));
      ok(
        "a filename that looks like markup is rendered as text",
        injected.text === "<img src=x onerror=alert(1)>.txt" && injected.images === 0,
        JSON.stringify(injected),
      );

      // the limit, when it is close
      await page.evaluate(() => {
        window.__mock.addFile("fill.txt", { mime: "text/plain" });
      });
      ok(
        "the file count starts naming the limit only once the workspace is nearly full",
        (await page.evaluate(() => window.__c.q(".bp-files-note").textContent)).includes(
          "of 8 - this browser workspace is nearly full",
        ),
        await page.evaluate(() => window.__c.q(".bp-files-note").textContent),
      );

      // hide-files, and no workspace
      await page.evaluate(() => window.__c.element.setAttribute("hide-files", ""));
      ok(
        "hide-files hides the panel without touching the engine",
        await page.evaluate(() => window.__c.q(".bp-files").hidden === true),
        "hidden",
      );
      await page.evaluate(() => window.__c.element.removeAttribute("hide-files"));

      const unsupported = await page.evaluate(() => {
        window.__mock.files.clear();
        window.__mock.workspace = {
          available: false,
          reason: "no-sync-access-handles",
          detail: "This browser has no synchronous file access handles.",
          path: "/workspace",
          maxFiles: 8,
          sessionId: "mock",
        };
        window.__mock.emitArtifacts({});
        return {
          hidden: window.__c.q(".bp-files").hidden,
          note: window.__c.q(".bp-files-note").textContent,
          rows: window.__c.qa(".bp-file").length,
        };
      });
      ok(
        "a browser with no workspace gets the explanation instead of an empty list",
        unsupported.hidden === false &&
          unsupported.rows === 0 &&
          unsupported.note.includes("no synchronous file access handles"),
        JSON.stringify(unsupported),
      );

      return checks;
    } catch (error) {
      // Keep what was proved before the throw: "0/0 checks" hides every answer already obtained.
      ok("the suite ran to the end", false, String(error?.message ?? error).split("\n")[0]);
      return checks;
    } finally {
      await server.close();
    }
  },
  { browserName: engine },
);

process.exit(report(`the console's file panel (${engine})`, result));
