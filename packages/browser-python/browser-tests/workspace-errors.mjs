// The workspace's FAILURE paths, with the failures injected.
//
//     node browser-tests/workspace-errors.mjs
//
// A browser will not exhaust its storage quota on request, and a test that waits for it to happen
// naturally never runs. So this suite wraps every OPFS sync access handle before the production
// `Workspace` acquires one and makes the handle misbehave: a short write, a
// `QuotaExceededError`, a flush that fails after every write succeeded.
//
// The promise being asserted is one. A file whose write went wrong is NEVER handed over as a
// finished artifact - not renamed, not downloaded, not listed as ready - and the reason reaches
// Python as the right errno rather than as "an OSError happened". The exact numbers are checked,
// because they were wrong once: `new FS.ErrnoError(28)` under a `// ENOSPC` comment, and 28 is
// EINVAL.
import { inBrowser, report, requireDist, serve } from "./harness.mjs";

requireDist();

const PROBES_DIR = new URL("./probes", import.meta.url).pathname;

const result = await inBrowser(async (page) => {
  const server = await serve("<!doctype html><meta charset=utf-8><title>workspace errors</title>", {
    roots: { "/probes/": PROBES_DIR },
  });
  const checks = [];
  const ok = (name, pass, detail) => checks.push({ name, pass, detail: String(detail ?? "") });
  try {
    await page.goto(server.url);
    const out = await page.evaluate(async () => {
      const worker = new Worker("/probes/workspace-worker.js", { type: "module" });
      const r = await new Promise((resolve) => {
        worker.onmessage = (e) => resolve(e.data);
        worker.onerror = (e) => resolve({ ok: false, error: String(e.message ?? e) });
        worker.postMessage({
          indexURL: new URL("/runtime/", location.href).href,
          distURL: new URL("/dist/worker/opfs-workspace.js", location.href).href,
        });
        setTimeout(() => resolve({ ok: false, error: "timeout" }), 300000);
      });
      worker.terminate();
      return r;
    });

    if (!out.ok && !Object.keys(out.results ?? {}).length) {
      ok("the workspace probe ran at all", false, out.error);
      return checks;
    }
    const r = out.results;
    if (process.env.WS_DEBUG) console.log(JSON.stringify(r, null, 2));

    // the errno table itself
    ok(
      "errno values come from the runtime, and are Emscripten's rather than Linux's",
      r.errnoTable?.ENOSPC === 51 && r.errnoTable?.EMFILE === 33 && r.errnoTable?.EINVAL === 28,
      JSON.stringify(r.errnoTable),
    );

    // pool exhaustion
    const pool = r.poolExhaustion ?? {};
    ok(
      "running out of file slots raises EMFILE (33), not ENOSPC and not EINVAL",
      pool.third?.ok === false && pool.third?.errno === 33 && pool.third?.type === "OSError",
      JSON.stringify(pool.third),
    );
    ok(
      "…and the terse errno is explained as a browser limit, naming the number of files",
      pool.explains === true && pool.mentionsZarr === true,
      pool.annotation,
    );
    ok(
      "…and deleting a file returns its slot, so the same write then succeeds",
      pool.first?.ok === true && pool.afterDelete?.ok === true,
      JSON.stringify({ first: pool.first, afterDelete: pool.afterDelete }),
    );

    const retained = r.retainedNotCreated ?? {};
    ok(
      "the bound is on RETAINED files: 300 files written and removed through one slot",
      retained.many?.ok === true && retained.listed === 0,
      JSON.stringify(retained),
    );

    // the short write
    const short = r.shortWrite ?? {};
    ok(
      "a short write raises ENOSPC (51) - OPFS reports an exhausted quota by writing fewer bytes",
      short.bad?.ok === false && short.bad?.errno === 51,
      JSON.stringify(short.bad),
    );
    ok(
      "…and the partial file is quarantined as `failed`, never listed as ready",
      short.failed?.state === "failed" && typeof short.failed?.failure === "string",
      JSON.stringify(short.failed),
    );
    ok(
      "…and downloading it is refused, with the reason and what to do about it",
      typeof short.refusal === "string" &&
        short.refusal.includes("incomplete") &&
        short.refusal.includes("Delete"),
      short.refusal,
    );
    ok(
      "…while the file written before it is still complete and still downloadable",
      short.ok?.ok === true && short.goodBytes === 8,
      JSON.stringify({ good: short.ok, bytes: short.goodBytes }),
    );
    ok(
      "…and deleting the failed file returns its slot",
      Array.isArray(short.stillListed) && !short.stillListed.includes("partial.bin"),
      JSON.stringify(short.stillListed),
    );

    // DOMExceptions
    const dom = r.domExceptions ?? {};
    ok(
      "QuotaExceededError becomes ENOSPC (51)",
      dom.quota?.errno === 51,
      JSON.stringify(dom.quota),
    );
    ok("NotAllowedError becomes EACCES (2)", dom.denied?.errno === 2, JSON.stringify(dom.denied));
    ok(
      "NoModificationAllowedError - another tab holds the lock - becomes EBUSY (10)",
      dom.locked?.errno === 10,
      JSON.stringify(dom.locked),
    );
    ok(
      "an unrecognised DOMException becomes EIO (29) rather than escaping as a JS crash",
      dom.unknown?.errno === 29 && dom.unknown?.type === "OSError",
      JSON.stringify(dom.unknown),
    );
    ok(
      "a failed flush fails the artifact, even though every write returned its full length",
      dom.flush?.ok === false && dom.flush?.errno === 51,
      JSON.stringify(dom.flush),
    );
    ok(
      "a failed truncate fails the artifact: it is neither its old length nor its new one",
      dom.truncate?.ok === false,
      JSON.stringify(dom.truncate),
    );
    ok(
      "every file touched by an injected failure is marked failed, and none is ready",
      Array.isArray(dom.states) &&
        dom.states.length > 0 &&
        dom.states.every((s) => s.state === "failed"),
      JSON.stringify(dom.states),
    );

    // os.replace and the slot leak
    const replace = r.replaceReleasesSlot ?? {};
    ok(
      "os.replace() onto an existing file releases the destination's slot",
      replace.replaced?.ok === true && replace.reuse?.ok === true,
      JSON.stringify({
        replaced: replace.replaced,
        reuse: replace.reuse,
        freeWhenFull: replace.freeWhenFull,
        freeAfterReplace: replace.freeAfterReplace,
      }),
    );
    ok(
      "…and the destination holds the source's bytes afterwards",
      replace.content?.ok === true &&
        Array.isArray(replace.listing) &&
        replace.listing.includes("dst.bin") &&
        !replace.listing.includes("src.bin"),
      JSON.stringify({ content: replace.content, listing: replace.listing }),
    );

    const mismatch = r.renameMismatches ?? {};
    ok(
      "renaming a file onto a directory is EISDIR (31)",
      mismatch.fileOntoDir?.errno === 31,
      JSON.stringify(mismatch.fileOntoDir),
    );
    ok(
      "renaming a directory onto a file is ENOTDIR (54)",
      mismatch.dirOntoFile?.errno === 54,
      JSON.stringify(mismatch.dirOntoFile),
    );
    ok(
      "renaming onto a non-empty directory is ENOTEMPTY (55)",
      mismatch.dirOntoNonEmptyDir?.errno === 55,
      JSON.stringify(mismatch.dirOntoNonEmptyDir),
    );

    // descriptor lifetime
    const orphan = r.unlinkWhileOpen ?? {};
    ok(
      "a file unlinked while open keeps working, POSIX-style, and frees its slot at close",
      orphan.orphan?.ok === true && orphan.afterClose === 1 && orphan.reuse?.ok === true,
      JSON.stringify(orphan),
    );

    const staging = r.stagingWhileOpen ?? {};
    ok(
      "a file Python still has open is `open`, not `ready`",
      staging.whileOpen?.state === "open",
      JSON.stringify(staging.whileOpen),
    );
    ok(
      "…downloading it is refused, and says to close it first",
      typeof staging.refusal === "string" && staging.refusal.includes("still open"),
      staging.refusal,
    );
    ok(
      "…deleting it is refused too, rather than pulling storage out from under Python",
      typeof staging.deleteRefusal === "string" && staging.deleteRefusal.includes("still open"),
      staging.deleteRefusal,
    );
    ok(
      "…and closing it makes it ready and downloadable, with its bytes",
      staging.afterClose?.state === "ready" && staging.bytes === 4,
      JSON.stringify({ after: staging.afterClose, bytes: staging.bytes }),
    );

    // a slot that cannot be cleaned is retired
    const retired = r.brokenSlotRetires ?? {};
    ok(
      "a slot whose cleanup truncate fails is withdrawn instead of handed out again",
      retired.first?.ok === false && retired.maxAfter < retired.maxBefore,
      JSON.stringify({ first: retired.first, before: retired.maxBefore, after: retired.maxAfter }),
    );
    ok(
      "…and the lost capacity is reported rather than silently absorbed",
      typeof retired.degraded === "string" &&
        /withdrawn after storage errors/.test(retired.degraded),
      retired.degraded,
    );
    ok(
      "…while a healthy slot still works, so one bad slot does not end the workspace",
      retired.afterFault?.ok === true && retired.listing?.includes("four.bin"),
      JSON.stringify({ afterFault: retired.afterFault, listing: retired.listing }),
    );

    const partial = r.partialPoolStartup ?? {};
    ok(
      "a pool startup that fails part way closes every handle it had already acquired",
      partial.status === "open-failed" && partial.opened > 0 && partial.closed === partial.opened,
      JSON.stringify(partial),
    );

    // a failed creation leaves nothing
    const phantom = r.exhaustionLeavesNoNode ?? {};
    ok(
      "exhausting the file limit raises EMFILE and does not kill the interpreter",
      phantom.errno === 33 && phantom.still_alive === true,
      JSON.stringify({
        errno: phantom.errno,
        alive: phantom.still_alive,
        crashed: phantom.crashed,
      }),
    );
    ok(
      "…and leaves NO node behind: exists(), listdir() and the artifact list all agree",
      phantom.phantom_exists === false &&
        Array.isArray(phantom.listing_after) &&
        phantom.listing_after.join() === "a" &&
        Array.isArray(phantom.listed) &&
        phantom.listed.join() === "b",
      JSON.stringify({
        exists: phantom.phantom_exists,
        listing: phantom.listing_after,
        artifacts: phantom.listed,
      }),
    );
    ok(
      "…and the name can be used once a slot is free",
      phantom.recovered === true && phantom.free === 0,
      JSON.stringify({ recovered: phantom.recovered, free: phantom.free }),
    );

    // duplicated descriptors
    const dup = r.duplicatedDescriptors ?? {};
    ok(
      "a file stays `open` while a dup() of it is still around",
      dup.setup?.ok === true && dup.afterOriginalClose?.state === "open",
      JSON.stringify({ setup: dup.setup, info: dup.afterOriginalClose }),
    );
    ok(
      "…so no download lease may begin while a writable duplicate exists",
      typeof dup.leaseRefusal === "string" && /still open in Python/.test(dup.leaseRefusal),
      dup.leaseRefusal,
    );
    ok(
      "…writes through the duplicate land, and closing it makes the artifact ready",
      dup.throughDuplicate?.ok === true &&
        dup.afterDuplicateClose?.state === "ready" &&
        dup.contents?.ok === true,
      JSON.stringify({
        wrote: dup.throughDuplicate,
        info: dup.afterDuplicateClose,
        contents: dup.contents,
      }),
    );
    ok(
      "os.dup2 onto a chosen descriptor is counted the same way",
      dup.dup2?.ok === true,
      JSON.stringify(dup.dup2),
    );
    ok(
      "unlinking a file that still has a duplicate keeps it writable, POSIX-style",
      dup.unlinkWhileDuplicated?.ok === true,
      JSON.stringify(dup.unlinkWhileDuplicated),
    );
    ok(
      "…and its slot comes back at the last close, leaving only the two retained files",
      dup.free === 2 && dup.listing?.sort().join() === "result.bin,two.bin",
      JSON.stringify({ free: dup.free, listing: dup.listing }),
    );

    // replace / unlink / recreate
    const replaced = r.replaceUnlinkRecreate ?? {};
    ok(
      "os.replace() moves the bytes and leaves one entry",
      replaced.after_replace?.join() === "b" && replaced.content_after_replace === "A",
      JSON.stringify(replaced),
    );
    ok(
      "…unlinking it removes both the directory entry AND the lookup identity",
      replaced.listing?.length === 0 && replaced.phantom === false,
      JSON.stringify({ listing: replaced.listing, phantom: replaced.phantom }),
    );
    ok(
      "…and the same name can be created again afterwards",
      replaced.recreated === "C" && replaced.listed?.join() === "b",
      JSON.stringify({ recreated: replaced.recreated, artifacts: replaced.listed }),
    );

    // A truncate that returns without doing anything. The project's own feasibility probe
    // recorded a real browser returning normally from `truncate(4 GiB + 4)` and leaving the size
    // unchanged, and "did not throw" is not "succeeded". Each of these asks whether bytes from a
    // previous file can ever be visible in a new one, or a size reported that the file never had.
    const silentCreate = r.silentTruncateOnCreate ?? {};
    ok(
      "a slot whose truncate silently did nothing never becomes a new file",
      silentCreate.second?.ok !== true ||
        (silentCreate.listed?.size === 1 &&
          Array.isArray(silentCreate.read) &&
          silentCreate.read.length === 1 &&
          silentCreate.read[0] === 0x42),
      JSON.stringify(silentCreate),
    );
    ok(
      "…and the slot that could not be emptied leaves the rotation and is reported",
      silentCreate.free === 2 && /withdrawn/.test(silentCreate.degraded ?? ""),
      JSON.stringify({ free: silentCreate.free, degraded: silentCreate.degraded }),
    );

    const silentSetattr = r.silentTruncateOnSetattr ?? {};
    ok(
      "fh.truncate() that did not happen is an error, not a smaller reported size",
      silentSetattr.truncated?.ok !== true &&
        (silentSetattr.reported === null || silentSetattr.reported === silentSetattr.actual),
      JSON.stringify(silentSetattr),
    );

    const partialSetattr = r.partialTruncateOnSetattr ?? {};
    ok(
      "…and one that reached the wrong size is refused rather than recorded",
      partialSetattr.truncated?.ok !== true && partialSetattr.reported !== 8,
      JSON.stringify(partialSetattr),
    );

    const startup = r.silentTruncateAtStartup ?? {};
    ok(
      "a pool whose slots cannot be cleared refuses to start rather than serving stale bytes",
      /refused/.test(startup.outcome ?? ""),
      JSON.stringify(startup),
    );

    // replacing a DIRECTORY, and the names that break objects
    const dirs = r.replaceEmptyDirectory ?? {};
    ok(
      "os.replace() between empty directories leaves one entry",
      dirs.after_replace?.join() === "b" && dirs.crashed === undefined,
      JSON.stringify(dirs),
    );
    ok(
      "…and rmdir() then removes it completely, with no phantom left in the lookup table",
      dirs.listing?.length === 0 && dirs.phantom === false,
      JSON.stringify({ listing: dirs.listing, phantom: dirs.phantom }),
    );
    ok(
      "…so the same directory name can be created again",
      dirs.recreated === true,
      JSON.stringify({ recreated: dirs.recreated }),
    );

    const types = r.replaceTypeErrors ?? {};
    ok(
      // Emscripten's numbers, which are not Linux's: ENOTDIR is 54 and EISDIR is 31 here.
      "a directory cannot replace a file (ENOTDIR), and a file cannot replace a directory (EISDIR)",
      types.dir_over_file === 54 && types.file_over_dir === 31,
      JSON.stringify(types),
    );
    ok(
      "…and a non-empty directory is never silently discarded (ENOTEMPTY)",
      types.over_nonempty === 55 &&
        JSON.stringify(types.still_there) === JSON.stringify(["dir", "file", "full", "spare"]),
      JSON.stringify(types),
    );

    const protoNames = r.prototypeNames ?? {};
    ok(
      "files called `constructor`, `__proto__`, `toString` and friends are created and read back",
      protoNames.crashed === undefined &&
        protoNames.all_created === true &&
        protoNames.all_read_back === true,
      JSON.stringify({
        crashed: protoNames.crashed,
        created: protoNames.all_created,
        read: protoNames.all_read_back,
      }),
    );
    ok(
      "…they are all listed, and a name nobody created is still absent",
      protoNames.listing?.length === 5 && protoNames.absent === false,
      JSON.stringify({ listing: protoNames.listing, absent: protoNames.absent }),
    );
    ok(
      "…and replace and unlink work on them like any other name",
      protoNames.after_replace === "constructor" && protoNames.gone === false,
      JSON.stringify({ replaced: protoNames.after_replace, gone: protoNames.gone }),
    );

    const over = r.replaceOverOpenDestination ?? {};
    ok(
      "replacing a destination that is still open keeps the old descriptor's bytes",
      over.old_bytes === "OLD" && over.new_bytes === "NEW",
      JSON.stringify(over),
    );

    // short reads
    const short2 = r.shortReads ?? {};
    ok(
      "a short read is retried until the byte count is exact, in Python",
      short2.setup?.ok === true && short2.pythonRead?.ok === true,
      JSON.stringify({ setup: short2.setup, read: short2.pythonRead }),
    );
    ok(
      "…and in a transfer, which reads the whole chunk rather than what it was given",
      short2.streamed?.length === 10240 && short2.streamed?.first === 0,
      JSON.stringify(short2.streamed),
    );
    ok(
      "a read that returns nothing before the end of the file is an error, not a short answer",
      typeof short2.refused === "string" && /no data at byte/.test(short2.refused),
      short2.refused,
    );

    const descriptors = r.multipleDescriptors ?? {};
    ok(
      "two descriptors on one file see each other's bytes",
      descriptors.both?.ok === true && descriptors.info?.state === "ready",
      JSON.stringify(descriptors),
    );

    return checks;
  } finally {
    await server.close();
  }
});

process.exit(report("workspace failure paths", result));
