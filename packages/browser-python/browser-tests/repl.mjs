/**
 * The interactive console: the behaviours that make a REPL a REPL rather than an `exec` loop.
 *
 * Every check here needs a real browser and a real interpreter. "Is this line incomplete", "did
 * the value survive to the next command", "was the borrowed proxy still alive on the hundredth
 * push" are properties of CPython, of Pyodide's console and of PyProxy lifetimes, and a mock of
 * any of them would be a mock of the thing under test.
 */
import { fixturePage, inBrowser, report, requireDist, serve } from "./harness.mjs";

requireDist();

const result = await inBrowser(async (page) => {
  const server = await serve(fixturePage({ profile: "minimal" }));
  const checks = [];
  try {
    await page.goto(server.url);
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });

    const ready = await page.evaluate(() => window.__py.start());
    // The reported capability must BE the capability. A `no-jspi` failure reason that nothing
    // ever produces is an intention, not a check, so `ready` carries the answer and the page is
    // asked the same question independently.
    const engineHasJspi = await page.evaluate(() => typeof WebAssembly.Suspending === "function");
    checks.push({
      name: "the reported JSPI capability is the browser's actual one",
      pass: ready.jspi === engineHasJspi,
      detail: JSON.stringify({ reported: ready.jspi, engine: engineHasJspi }),
    });
    checks.push({
      name: "the interpreter starts and reports what it actually is",
      pass:
        typeof ready.pythonVersion === "string" &&
        /^\d+\.\d+\.\d+$/.test(ready.pythonVersion) &&
        typeof ready.pyodideVersion === "string" &&
        typeof ready.startupMs === "number",
      detail: `Python ${ready.pythonVersion}, Pyodide ${ready.pyodideVersion}, ${ready.startupMs}ms`,
    });
    checks.push({
      name: "…and the state machine agrees",
      pass: (await page.evaluate(() => window.__py.state())) === "ready",
    });

    // 1. The smallest possible proof that Python ran.
    const one = await page.evaluate(async () => {
      window.__py.drain();
      const r = await window.__py.push("1 + 1");
      return { r, events: window.__py.drain() };
    });
    checks.push({
      name: "1 + 1 evaluates to 2 and is echoed as a result",
      pass:
        one.r.executed === true &&
        one.r.syntax === "complete" &&
        one.r.result === "2" &&
        one.events.some((e) => e.type === "result" && e.text === "2"),
      detail: JSON.stringify(one.r),
    });

    // 2. Persistence. This is what separates a console from a series of scripts.
    const persist = await page.evaluate(async () => {
      await window.__py.push("value = 40");
      return window.__py.push("value + 2");
    });
    checks.push({
      name: "variables persist between commands",
      pass: persist.result === "42",
      detail: JSON.stringify(persist),
    });

    // 3. Multi-line, and the `...` state that a UI renders as a continuation prompt.
    const multi = await page.evaluate(async () => {
      const a = await window.__py.push("def double(value):");
      const b = await window.__py.push("    return value * 2");
      const c = await window.__py.push("");
      const d = await window.__py.push("double(21)");
      return { a, b, c, d };
    });
    checks.push({
      name: "a def is INCOMPLETE until the blank line, then executes",
      pass:
        multi.a.syntax === "incomplete" &&
        multi.a.executed === false &&
        multi.b.syntax === "incomplete" &&
        multi.c.executed === true &&
        multi.d.result === "42",
      detail: `${multi.a.syntax} / ${multi.b.syntax} / ${multi.c.syntax} -> ${multi.d.result}`,
    });

    // 4. Top-level await. Legal at a Pyodide prompt and illegal in `exec`, which is one of the
    //    reasons this is built on PyodideConsole.
    const awaited = await page.evaluate(async () => {
      await window.__py.push("import asyncio");
      return window.__py.push("await asyncio.sleep(0) or 'awaited'");
    });
    checks.push({
      name: "top-level await works",
      pass: awaited.result === "'awaited'",
      detail: JSON.stringify(awaited),
    });

    // 5. stdout ordering relative to the result, within one execution.
    const ordering = await page.evaluate(async () => {
      window.__py.drain();
      await window.__py.push("import sys");
      window.__py.drain();
      const r = await window.__py.push("print('first'); print('second'); 'third'");
      return { r, events: window.__py.drain() };
    });
    const kinds = ordering.events.map((e) => `${e.type}:${e.text.trim()}`);
    checks.push({
      name: "stdout arrives before the result, in order, tagged with the execution",
      pass:
        kinds.join("|").includes("stdout:first") &&
        kinds.indexOf("stdout:first\nsecond") < kinds.length &&
        kinds[kinds.length - 1] === "result:'third'" &&
        ordering.events.every((e) => e.executionId === ordering.r.executionId),
      detail: JSON.stringify(kinds),
    });

    // 6. A syntax error is reported as one, and does NOT wedge the console. `x = = 1` and not
    //    `def (`: the latter is BOTH invalid and unfinishable, and CPython reports it as
    //    incomplete input, so a one-line error that cannot be continued separates the two paths.
    const syntax = await page.evaluate(async () => {
      const bad = await window.__py.push("x = = 1");
      const good = await window.__py.push("1 + 1");
      return { bad, good };
    });
    checks.push({
      name: "a syntax error is reported and the console keeps working",
      pass:
        syntax.bad.syntax === "syntax-error" &&
        syntax.bad.executed === false &&
        typeof syntax.bad.error === "string" &&
        syntax.bad.error.includes("SyntaxError") &&
        syntax.good.result === "2",
      detail: `${syntax.bad.syntax}: ${(syntax.bad.error ?? "").split("\n").pop()}`,
    });

    // 7. A runtime error is a traceback, as text, and the session survives it.
    const raised = await page.evaluate(async () => {
      const boom = await window.__py.push("1 / 0");
      const after = await window.__py.push("value + 1");
      return { boom, after };
    });
    checks.push({
      name: "a traceback is text, and state survives an exception",
      pass:
        typeof raised.boom.error === "string" &&
        raised.boom.error.includes("ZeroDivisionError") &&
        raised.after.result === "41",
      detail: (raised.boom.error ?? "").split("\n").pop(),
    });

    // 8. Completion.
    const completion = await page.evaluate(async () => {
      await window.__py.push("import json");
      const dumps = await window.__py.complete("json.dum");
      const own = await window.__py.complete("val");
      return { dumps, own };
    });
    checks.push({
      name: "completion sees both the stdlib and the session's own names",
      pass:
        completion.dumps.matches.some((m) => m.startsWith("json.dumps")) &&
        completion.own.matches.includes("value") &&
        completion.dumps.start === 0,
      detail: `${JSON.stringify(completion.dumps.matches.slice(0, 3))} / ${JSON.stringify(completion.own.matches.slice(0, 3))}`,
    });

    // 8b. THE UNICODE BOUNDARY, against a real interpreter. Only the real completer shows what
    //     three units in play costs; a mocked engine returns whatever `start` the test author
    //     chose and agrees with any convention. Five emoji put the caret five units to the right
    //     of the same position in characters, so slicing at the character count asks rlcompleter
    //     about an empty token, which answers with every global there is.
    const unicode = await page.evaluate(async () => {
      const source = '"\u{1F600}\u{1F600}\u{1F600}\u{1F600}\u{1F600}"; print';
      const atEnd = await window.__py.complete(source, source.length);
      const omitted = await window.__py.complete(source);
      const bmp = await window.__py.complete('"aaaaa"; print');
      // A caret in the MIDDLE, with the astral characters behind it and text still ahead.
      const middleSource = "\u{1F600}\u{1F600} json.dum + trailing";
      const middleCursor = middleSource.indexOf(" + trailing");
      const middle = await window.__py.complete(middleSource, middleCursor);
      const applied =
        source.slice(0, atEnd.start) + (atEnd.matches[0] ?? "") + source.slice(source.length);
      return {
        utf16: source.length,
        characters: [...source].length,
        atEnd,
        omitted,
        bmp,
        middle,
        middleSource,
        middleCursor,
        applied,
        loneSurrogates: [...applied].filter((c) => {
          const p = c.codePointAt(0);
          return p >= 0xd800 && p <= 0xdfff;
        }).length,
        emoji: [...applied].filter((c) => c === "\u{1F600}").length,
      };
    });
    checks.push({
      name: "completion at the caret sees `print`, not every global in the namespace",
      pass:
        unicode.utf16 === 19 &&
        unicode.characters === 14 &&
        unicode.atEnd.matches.length > 0 &&
        unicode.atEnd.matches.every((m) => m.startsWith("print")) &&
        !unicode.atEnd.matches.includes("False") &&
        !unicode.atEnd.matches.includes("None"),
      detail: JSON.stringify({
        utf16: unicode.utf16,
        characters: unicode.characters,
        matches: unicode.atEnd.matches.slice(0, 4),
        count: unicode.atEnd.matches.length,
      }),
    });
    checks.push({
      name: "…and `start` is a UTF-16 offset, so slicing at it recovers the token",
      pass:
        unicode.atEnd.start === 14 &&
        unicode.applied.startsWith('"\u{1F600}\u{1F600}\u{1F600}\u{1F600}\u{1F600}"; print'),
      detail: JSON.stringify({ start: unicode.atEnd.start, applied: unicode.applied }),
    });
    checks.push({
      name: "…and applying it splits no surrogate pair: five emoji in, five emoji out",
      pass: unicode.loneSurrogates === 0 && unicode.emoji === 5,
      detail: JSON.stringify({ lone: unicode.loneSurrogates, emoji: unicode.emoji }),
    });
    checks.push({
      name: "an omitted cursor defaults to source.length in the same unit",
      pass:
        unicode.omitted.start === unicode.atEnd.start &&
        JSON.stringify(unicode.omitted.matches) === JSON.stringify(unicode.atEnd.matches),
      detail: JSON.stringify({ start: unicode.omitted.start }),
    });
    checks.push({
      name: "the BMP-only control behaves identically, where both units agree",
      pass:
        unicode.bmp.start === 9 &&
        unicode.bmp.matches.length > 0 &&
        unicode.bmp.matches.every((m) => m.startsWith("print")),
      detail: JSON.stringify({
        start: unicode.bmp.start,
        matches: unicode.bmp.matches.slice(0, 3),
      }),
    });
    checks.push({
      name: "a cursor in the middle completes the token it is in, not one before it",
      pass:
        unicode.middle.start === 5 &&
        unicode.middle.matches.some((m) => m.startsWith("json.dumps")) &&
        unicode.middleSource.slice(unicode.middle.start, unicode.middleCursor) === "json.dum",
      detail: JSON.stringify({
        start: unicode.middle.start,
        matches: unicode.middle.matches.slice(0, 3),
      }),
    });

    // 9. clearBuffer abandons a half-typed statement - and is honest that it is only that.
    const cleared = await page.evaluate(async () => {
      const opened = await window.__py.push("if True:");
      await window.__py.clearBuffer();
      const after = await window.__py.push("'clean'");
      return { opened, after };
    });
    checks.push({
      name: "clearBuffer abandons a half-typed statement",
      pass: cleared.opened.syntax === "incomplete" && cleared.after.result === "'clean'",
      detail: JSON.stringify(cleared.after),
    });

    // 10. THE regression test. A borrowed proxy whose parent was destroyed does not fail on the
    //     first command - it fails on the second, or the fortieth, once something is collected.
    //     Sixty round trips through push/await/destroy is what makes that visible; a single
    //     `1 + 1` would pass against a broken implementation.
    const churn = await page.evaluate(async () => {
      const results = [];
      for (let i = 0; i < 60; i += 1) {
        const r = await window.__py.push(`${i} * 2`);
        results.push(r.result);
        if (r.error) return { failedAt: i, error: r.error };
      }
      // Interleave the other proxy-taking paths, which have their own destroy() sites.
      for (let i = 0; i < 20; i += 1) {
        await window.__py.complete("val");
        await window.__py.run("pass");
        await window.__py.clearBuffer();
      }
      const last = await window.__py.push("1 + 1");
      return { results, last };
    });
    checks.push({
      name: "60 pushes + 20 complete/run/clear cycles: no destroyed-proxy failure",
      pass:
        churn.failedAt === undefined &&
        churn.results?.length === 60 &&
        churn.results[59] === "118" &&
        churn.last?.result === "2",
      detail:
        churn.error ??
        `last of 60 = ${churn.results?.[59]}, still alive afterwards = ${churn.last?.result}`,
    });

    // 11. run() executes a snippet without disturbing a half-typed console line.
    const snippet = await page.evaluate(async () => {
      const opened = await window.__py.push("for i in range(3):");
      const ran = await window.__py.run("snippet_ran = True\n");
      const finished = await window.__py.push("    pass");
      const blank = await window.__py.push("");
      const check = await window.__py.push("snippet_ran");
      return { opened, ran, finished, blank, check };
    });
    checks.push({
      name: "run() does not eat the console's continuation buffer",
      pass:
        snippet.opened.syntax === "incomplete" &&
        !snippet.ran.error &&
        snippet.finished.syntax === "incomplete" &&
        snippet.blank.executed === true &&
        snippet.check.result === "True",
      detail: JSON.stringify({
        opened: snippet.opened.syntax,
        finished: snippet.finished.syntax,
        check: snippet.check.result,
      }),
    });

    // 12. Restart really replaces the interpreter.
    const restarted = await page.evaluate(async () => {
      await window.__py.push("survivor = 'before'");
      const before = await window.__py.push("survivor");
      const info = await window.__py.restart();
      const after = await window.__py.push("survivor");
      const usable = await window.__py.push("2 + 2");
      return { before, info, after, usable, state: window.__py.state() };
    });
    checks.push({
      name: "restart() produces a genuinely fresh interpreter",
      pass:
        restarted.before.result === "'before'" &&
        typeof restarted.info.pythonVersion === "string" &&
        restarted.after.error?.includes("NameError") === true &&
        restarted.usable.result === "4" &&
        restarted.state === "ready",
      detail: (restarted.after.error ?? "").split("\n").pop(),
    });

    // 13. Matplotlib was not downloaded merely because plotting is supported.
    const noMpl = await page.evaluate(async () => {
      const r = await window.__py.push("'matplotlib' in __import__('sys').modules");
      return r.result;
    });
    checks.push({
      name: "Matplotlib is NOT loaded at startup",
      pass: noMpl === "False",
      detail: `sys.modules check -> ${noMpl}`,
    });
    checks.push({
      name: "…and the runtime never requested its wheel",
      pass: !server.requests.some((p) => p.includes("matplotlib")),
      detail: `${server.requests.length} runtime requests, none matching matplotlib`,
    });

    // ------ stdout separators survive run()
    const separators = await page.evaluate(async () => {
      window.__py.drain();
      const r = await window.__py.run('print("first")\nprint("second")\n');
      return {
        r,
        events: window.__py.events.filter((e) => e.type === "stdout").map((e) => e.text),
        text: window.__py.text("stdout"),
      };
    });
    checks.push({
      // `first\nsecond\n`, not `firstsecond`. Python writes the text and the newline as separate
      // calls, so anything that joins fragments without preserving them - a batching layer, a
      // transport that trims, a console that coalesces - produces a transcript that cannot be
      // read and cannot be pasted back.
      name: "run() preserves the newlines between separate print() calls",
      pass: !separators.r.error && separators.text === "first\nsecond\n",
      detail: JSON.stringify({ text: separators.text, events: separators.events }),
    });

    const streamOrder = await page.evaluate(async () => {
      window.__py.drain();
      const r = await window.__py.run(
        ["import sys", 'print("out-1")', 'sys.stderr.write("err-1\\n")', 'print("out-2")', ""].join(
          "\n",
        ),
      );
      return {
        r,
        // `print()` writes the text and its newline separately, so the fragments are filtered to
        // the ones that carry content: what is under test is their ORDER across the two streams.
        order: window.__py.events
          .filter((e) => (e.type === "stdout" || e.type === "stderr") && e.text.trim() !== "")
          .map((e) => `${e.type}:${e.text.trim()}`),
        stdout: window.__py.text("stdout"),
        stderr: window.__py.text("stderr"),
      };
    });
    checks.push({
      name: "…and interleaved stdout and stderr keep the order Python produced them in",
      pass:
        !streamOrder.r.error &&
        streamOrder.order.join("|") === "stdout:out-1|stderr:err-1|stdout:out-2" &&
        streamOrder.stdout === "out-1\nout-2\n" &&
        streamOrder.stderr === "err-1\n",
      detail: JSON.stringify(streamOrder),
    });

    const partial = await page.evaluate(async () => {
      window.__py.drain();
      const r = await window.__py.run(
        ["import sys", 'sys.stdout.write("no")', 'sys.stdout.write("newline")', ""].join("\n"),
      );
      return { r, text: window.__py.text("stdout") };
    });
    checks.push({
      name: "…and a write with no newline is not given one",
      pass: !partial.r.error && partial.text === "nonewline",
      detail: JSON.stringify(partial.text),
    });

    // 14. dispose() is terminal and rejects rather than hanging.

    // ------ output while Python is awaiting
    //
    // THE interactive-prompt case, in real Python. A batch flushed only on size, on another
    // message and on a clock comparison made during a write leaves a print sitting in the worker
    // for the length of the await that follows it. Device authentication prints a URL and a code
    // and then polls, so the code the user has to type would be invisible until it gave up.
    const whileAwaiting = await page.evaluate(async () => {
      window.__py.drain();
      const running = window.__py.run(
        [
          "import asyncio",
          "print('VERIFY-CODE WXYZ-1234')",
          "await asyncio.sleep(3)",
          "print('POLL-FINISHED')",
          "",
        ].join("\n"),
      );
      // Polled rather than slept on, and stopped well inside the 3 s await - far longer than the
      // 50 ms flush interval - so a slower engine's startup of the snippet is not mistaken for a
      // batch that was never flushed. A batch that waited for the coroutine to end still fails.
      const deadline = Date.now() + 2000;
      while (!window.__py.text("stdout").includes("VERIFY-CODE") && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const midway = window.__py.text("stdout");
      await running;
      return { midway, final: window.__py.text("stdout") };
    });
    checks.push({
      name: "a print before an await is visible while the await is still running",
      pass:
        whileAwaiting.midway.includes("VERIFY-CODE WXYZ-1234") &&
        !whileAwaiting.midway.includes("POLL-FINISHED"),
      detail: JSON.stringify(whileAwaiting),
    });
    checks.push({
      name: "…and the rest arrives when the coroutine finishes",
      pass: whileAwaiting.final.includes("POLL-FINISHED"),
      detail: JSON.stringify(whileAwaiting.final.trim().split("\n")),
    });

    // ------ completion sees what came before it
    //
    // `complete()` must not overtake a `push()` waiting in the submission queue: completions
    // would be computed against a namespace without the name the user just typed, and
    // autocomplete would say your own variable does not exist.
    const orderedCompletion = await page.evaluate(async () => {
      const pushed = window.__py.push("completion_probe_value = 1");
      const completed = window.__py.complete("completion_probe_val");
      const [p, c] = await Promise.all([pushed, completed]);
      return { pushed: p.syntax, matches: c.matches ?? [] };
    });
    checks.push({
      name: "a completion requested after a push sees the name that push created",
      pass: orderedCompletion.matches.includes("completion_probe_value"),
      detail: JSON.stringify(orderedCompletion),
    });

    // …and it is a read: a half-written statement survives one untouched.
    const midStatement = await page.evaluate(async () => {
      const opened = await window.__py.push("def completion_probe(value):");
      const completion = await window.__py.complete("ret");
      const body = await window.__py.push("    return value * 3");
      const closed = await window.__py.push("");
      const called = await window.__py.push("completion_probe(14)");
      return {
        opened: opened.syntax,
        completed: (completion.matches ?? []).length >= 0,
        body: body.syntax,
        closed: closed.syntax,
        result: called.result,
      };
    });
    checks.push({
      name: "…and completing mid-statement does not disturb the interactive buffer",
      pass:
        midStatement.opened === "incomplete" &&
        midStatement.body === "incomplete" &&
        midStatement.closed === "complete" &&
        midStatement.result === "42",
      detail: JSON.stringify(midStatement),
    });

    // ------ ordered, session-bound submissions
    //
    // If `push()` is serialised through a chain and `run()` is not, the second overtakes the
    // first by one microtask hop and the interpreter receives them backwards. The symptom is
    // `NameError: name 'x' is not defined` from two lines that would work in any other Python.
    const ordered = await page.evaluate(async () => {
      window.__py.drain();
      const pushed = window.__py.push("ordering_check = 1");
      const ran = window.__py.run("print('ordering:', ordering_check)");
      const [p, r] = await Promise.allSettled([pushed, ran]);
      return {
        push: p.status,
        run: r.status === "fulfilled" ? (r.value.error ?? null) : String(r.reason?.message),
        stdout: window.__py.text("stdout"),
      };
    });
    checks.push({
      name: "a run() submitted after a push() sees what the push defined",
      pass:
        ordered.push === "fulfilled" &&
        ordered.run === null &&
        ordered.stdout.includes("ordering: 1"),
      detail: JSON.stringify(ordered),
    });

    // `run()` is a different channel from the interactive buffer, and must stay one. A console
    // showing a `...` prompt has an unfinished statement in Python's line buffer; a block run
    // while that prompt is up must not be appended to it, or the console executes a body it never
    // showed and the block vanishes from where its author put it.
    const separate = await page.evaluate(async () => {
      window.__py.drain();
      const opened = await window.__py.push("def half(v):");
      const block = await window.__py.run("side = 'ran separately'");
      const body = await window.__py.push("    return v / 2");
      const closed = await window.__py.push("");
      const called = await window.__py.push("half(84)");
      return {
        opened: opened.syntax,
        blockError: block.error ?? null,
        body: body.syntax,
        closed: closed.syntax,
        result: called.result,
        side: (await window.__py.run("print(side)"), window.__py.text("stdout")),
      };
    });
    checks.push({
      name: "a run() block does not join an unfinished push() statement",
      pass:
        separate.opened === "incomplete" &&
        separate.blockError === null &&
        separate.body === "incomplete" &&
        separate.result === "42.0" &&
        separate.side.includes("ran separately"),
      detail: JSON.stringify(separate),
    });

    const disposed = await page.evaluate(async () => {
      window.__py.dispose();
      try {
        await window.__py.push("1");
        return { threw: false, state: window.__py.state() };
      } catch (e) {
        return { threw: true, code: e.code, state: window.__py.state() };
      }
    });
    checks.push({
      name: "dispose() is terminal and rejects further work",
      pass:
        disposed.threw === true && disposed.code === "disposed" && disposed.state === "disposed",
      detail: JSON.stringify(disposed),
    });

    return checks;
  } finally {
    await server.close();
  }
});

process.exit(report("interactive console", result));
