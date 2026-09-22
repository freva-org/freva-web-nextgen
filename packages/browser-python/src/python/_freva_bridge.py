"""Everything the worker calls into Python for. One module, one name in the user's namespace.

Why a module and not a handful of globals
-----------------------------------------
The worker holds ONE PyProxy - this module - for as long as the interpreter lives, and reaches
every helper through it. That is the whole proxy-ownership strategy, and it is deliberate.

The failure it is designed out of: pulling a callable off ``pyodide.console`` and keeping it after
destroying the module proxy it came from. Pyodide's docs prescribe ``.copy()`` for a borrowed proxy
that must outlive its parent, which works - but it leaves a lifetime rule that a later edit has to
remember. Retaining exactly one long-lived parent and creating no long-lived children removes the
rule instead of documenting it: there is nothing here whose parent can be destroyed early, because
the only parent is the module and it lives as long as the worker does.

Everything returned to JavaScript is a PRIMITIVE or a list/tuple/dict of primitives. No PyProxy ever
crosses the boundary, so the worker has nothing of Python's to destroy on the happy path and cannot
leak one on the unhappy path. The single exception is the ``ConsoleFuture`` from ``push()``, which
the worker must hold briefly and hands straight back to ``run_future`` - see ``console_push``.
"""

from __future__ import annotations

import ast as _ast
import asyncio as _asyncio
import inspect as _inspect
import sys as _sys
import contextlib as _contextlib
import traceback as _traceback

# What lets `run()` accept `await` at the top level, the same as the console does. See `run_source`.
_ALLOW_TOP_LEVEL_AWAIT = _ast.PyCF_ALLOW_TOP_LEVEL_AWAIT

if "/freva" not in _sys.path:
    _sys.path.insert(0, "/freva")

import rich_display as _rich_display  # noqa: E402  (the path has to be set first)

# The live console. Created by `make_console`, replaced never - an interpreter has exactly one
# REPL, and a restart replaces the whole worker rather than this object.
_console = None

# ----------------------------------------------------------------------------- the interrupt
#
# Ctrl+C, and the ONE mechanism behind it: asyncio cancellation of whatever task is running the
# user's code. Not Pyodide's interrupt buffer, and the difference is measured rather than assumed.
#
# `setInterruptBuffer` needs a `SharedArrayBuffer` to be worth anything, which needs cross-origin
# isolation headers this package cannot set on a host's behalf. With a plain `Uint8Array` the worker
# does still receive the message while Python sits at an ``await`` - the event loop is free - but
# writing the interrupt byte WEDGED the interpreter: a ten-second ``asyncio.sleep`` loop neither
# raised nor completed thirty seconds later. Not "failed to interrupt" - hung.
#
# Cancellation is Python's own answer to the same question and needs nothing of the host. Every
# await in the language is a cancellation point, so this covers a network read, a sleep, a device
# -flow poll, a lazy Zarr chunk fetch - anything the console is WAITING on, which is what a visitor
# means when they press Ctrl+C on a console that is not printing anything.
#
# What it does NOT cover, stated here rather than discovered: a synchronous loop with no await in
# it. `while True: pass` never reaches a suspension point, so the cancellation is recorded and
# delivered at a moment that never arrives. `Restart Python` is the honest answer there and the
# console says so if an interrupt goes unanswered.

# The task currently executing the user's code, while one is. Set by `_InterruptibleConsole.runcode`
# for a typed line and by `run_source` for a block; cleared in the `finally` of each.
_running_task = None

# What a cancelled TYPED LINE returns in place of a value, and the traceback that goes with it.
#
# The line this sentinel exists for: `KeyboardInterrupt` must never be RAISED out of an asyncio
# task. CPython's `Task.__step` treats `KeyboardInterrupt` and `SystemExit` specially - it sets them
# on the task and then RE-RAISES into the event loop, which in a browser means the exception leaves
# Pyodide's `WebLoop` through the timer callback that was driving it and lands as an unhandled error
# in the worker. Measured against the real `pyodide.console`: the interrupt worked, and the loop it
# was running on died with it, taking the rest of `asyncio.run` down the way it would take the
# console down here.
#
# So the interrupted execution ENDS NORMALLY, carrying a sentinel, and the text Python would have
# printed is reported beside it. Nothing raises, nothing escapes, and `run_future` turns it back
# into the error a REPL shows.
_INTERRUPTED = object()
_interrupt_report = ""

# Whether the cancellation about to arrive is OURS. A task can be cancelled for reasons that are
# not a visitor's Ctrl+C - a teardown, a host's own supervision - and reporting one of those as
# `KeyboardInterrupt` would be a lie in Python's own words. Only a cancellation this flag was set
# for is translated; any other propagates untouched.
_interrupt_requested = False


# The filenames the visitor's own code is compiled under: the console's, `run_source`'s, and the
# one `CodeRunner` uses for a top-level-await wrapper. A traceback opens at the first of these.
_USER_FILES = frozenset({"<console>", "<snippet>", "<exec>"})


def _user_frames(tb):
    """Advance a traceback to the first frame that is the visitor's.

    A cancellation is raised at the innermost ``await`` inside their code, so their frames are
    already in the traceback - underneath this module's, and underneath `pyodide.console`'s own two
    or three. Printed whole it opens on `console.py`, which is not where anything happened and not
    what CPython shows for a Ctrl+C; the console's `formattraceback` performs the same trim for an
    exception it handles itself, keyed on the same filenames.

    Falls back to the WHOLE traceback if no such frame is found. A cancellation that arrived before
    the visitor's code began has nothing of theirs in it, and showing the real frames is better than
    showing none.
    """
    frames = tb
    while frames is not None and frames.tb_frame.f_code.co_filename not in _USER_FILES:
        frames = frames.tb_next
    return frames if frames is not None else tb


def _format_interrupt(tb):
    """The traceback Python prints for a Ctrl+C, over the visitor's own frames.

    Built here rather than left to `Console.formattraceback` because the exception never reaches
    the console as an exception - it cannot, without killing the event loop - so there is nothing
    for the console to format.
    """
    interrupt = KeyboardInterrupt()
    frames = _user_frames(tb)
    return "".join(_traceback.format_exception(type(interrupt), interrupt, frames))


def interrupt():
    """Ask whatever is running to stop. Returns whether there was anything to ask.

    Called from JavaScript OUTSIDE the worker's request queue, which is the whole point: the queue
    is serialised behind the very execution this is trying to end, so an interrupt that waited its
    turn would arrive after the thing it was meant to interrupt had finished.

    Reentrancy is not a hazard here even though it enters Python while Python is mid-execution:
    there is no `await` in this function, so it runs to completion before the event loop turns
    again, and `Task.cancel()` only records a request - the `CancelledError` is delivered later, by
    the loop, at a suspension point.
    """
    global _interrupt_requested
    if _interrupt_requested:
        # Asked already, and asking twice is worse than not asking. A second `cancel()` lands while
        # the coroutine is unwinding from the first, sets `_must_cancel` again, and the task then
        # finishes CANCELLED rather than with its result - which is the one state `ConsoleFuture`'s
        # own done-callback cannot read, because it opens with `fut.exception()`. The console would
        # hang on the line the visitor pressed Ctrl+C on twice to get rid of.
        return True
    task = _running_task
    if task is None or task.done():
        return False
    _interrupt_requested = True
    task.cancel()
    return True

# ----------------------------------------------------------------------------- JSPI
#
# Whether this worker's WebAssembly can stack switch, as the WORKER detected it (`set_jspi`, called
# once at startup with the same answer `ready.jspi` reports). Never inferred from a browser name.
#
# Without it, everything that does not wait synchronously on the network works unchanged: local
# Python, NumPy, xarray on local data, /workspace, plotting. The one thing that cannot work is a
# SYNCHRONOUS call that waits on an asynchronous browser fetch - `xr.open_zarr("https://...")`,
# a remote `.values` - because that is exactly what stack switching provides. Pyodide refuses it
# with a RuntimeError naming the JavaScript runtime, deep inside zarr's sync layer, which reads like
# the whole browser is broken. So that one error, and only that one, is reported as what it is.
_jspi = True

# What Pyodide raises from `run_sync`/`callPromising` when the runtime cannot stack switch. Matched
# on the message because that is all that distinguishes it: the type is a plain RuntimeError.
_NO_STACK_SWITCHING = "WebAssembly stack switching not supported in this JavaScript runtime"

REMOTE_DATA_NEEDS_JSPI = (
    "RuntimeError: Remote dataset access requires WebAssembly JSPI (stack switching), which this "
    "browser does not provide.\n"
    "Local Python, NumPy/xarray on local data and /workspace files are not affected.\n"
    "Updating the browser fixes this: Safari 27 and later provide JSPI "
    "(https://webkit.org/blog/18325/webkit-features-for-safari-27-0/), as do Chrome and Edge 137 "
    "and Firefox 153 or later.\n"
)


def set_jspi(available):
    """Record whether this worker can stack switch. Called once, by the worker, at startup."""
    global _jspi
    _jspi = bool(available)
    if not _jspi:
        _quiet_run_sync()
    return _jspi


def _quiet_run_sync():
    """Without JSPI, let ``run_sync`` refuse WITHOUT a second, misleading warning.

    Pyodide's ``run_sync`` refuses before it has touched the coroutine it was handed, so the
    coroutine is garbage-collected unawaited and Python adds "RuntimeWarning: coroutine ... was
    never awaited" above the real error - a line about the caller's code, when nothing is wrong
    with it. Closing the coroutine on exactly that refusal removes the noise; the RuntimeError
    raised is the same object, and every other outcome is untouched. Installed once, before any
    user code runs; a module that bound ``run_sync`` earlier keeps the original, which differs only
    by that warning.
    """
    import pyodide.ffi as ffi

    original = ffi.run_sync
    if getattr(original, "_freva_browser_patch", False):
        return

    def run_sync(awaitable):
        try:
            return original(awaitable)
        except RuntimeError as exc:
            if _NO_STACK_SWITCHING in str(exc) and _inspect.iscoroutine(awaitable):
                awaitable.close()
            raise

    run_sync.__doc__ = original.__doc__
    run_sync.__wrapped__ = original
    run_sync._freva_browser_patch = True
    ffi.run_sync = run_sync
    # The event loop's `run_until_complete` - which a synchronous library layer may reach for -
    # imported its own binding; it gets the same wrapper.
    try:
        import pyodide.webloop as webloop

        if getattr(webloop, "run_sync", None) is original:
            webloop.run_sync = run_sync
    except Exception:  # an internal module moved: the warning is cosmetic, never worth failing
        pass


def _mentions_no_stack_switching(exc):
    try:
        return _NO_STACK_SWITCHING in str(exc)
    except Exception:  # an exception whose __str__ raises says nothing about stack switching
        return False


def _needs_jspi(exc):
    """True when ``exc`` failed ONLY because this runtime cannot stack switch.

    Never true where JSPI is present: there the same family of messages ("the Python entrypoint
    was a synchronous function") is a real bug and keeps its full traceback. Otherwise:

    * the exception itself carries Pyodide's refusal, or a member of an exception group does;
    * or it is a LIBRARY's own exception type (zarr, xarray, fsspec wrap what they catch) whose
      cause/context chain carries it. A BUILTIN exception raised from the refusal - typically the
      visitor's own ``raise ValueError(...) from exc`` - is not rewritten: its traceback is theirs.

    Called inside the REPL's exception handlers, so it never raises.
    """
    if _jspi:
        return False
    try:
        if _mentions_no_stack_switching(exc):
            return True
        for member in getattr(exc, "exceptions", None) or ():
            if _needs_jspi(member):
                return True
        if type(exc).__module__ == "builtins":
            return False
        seen = {id(exc)}
        current = exc.__cause__ or exc.__context__
        while current is not None and id(current) not in seen:
            seen.add(id(current))
            if _mentions_no_stack_switching(current):
                return True
            current = current.__cause__ or current.__context__
    except Exception:
        return False
    return False


def _report(exc, formatted):
    """The text a failed execution shows: the fixed sentence for a remote read without JSPI, the
    real traceback for everything else."""
    if exc is not None and _needs_jspi(exc):
        return REMOTE_DATA_NEEDS_JSPI
    return formatted


# How long a repr may be before it is elided. A REPL that prints a 4 GB array's repr in full has
# hung the tab, which is not the array's fault but is still the console's problem.
REPR_LIMIT = 4000


def make_console(stdout_callback, stderr_callback):
    """Build the interactive console over the interpreter's own ``__main__`` namespace.

    The namespace is ``__main__``'s dict rather than a fresh one, so ``pyodide.runPython`` from the
    worker and a line typed at the prompt see the same variables. A console with its own private
    globals would make `run()` and `push()` two different interpreters wearing one name.

    Note the signature: ``stdout_callback`` / ``stderr_callback`` are KEYWORD-only in this Pyodide,
    and there is no ``toPy``-ed options dict. An older three-positional-argument form appears in a
    lot of copied examples and raises ``TypeError`` here.
    """
    global _console
    from pyodide.console import PyodideConsole

    class _InterruptibleConsole(PyodideConsole):
        """``PyodideConsole``, plus a handle on the task that is running the visitor's line.

        `runcode` is overridden rather than `runsource` or `_runcode_with_lock`, and the choice is
        deliberate in both directions. `runsource` is where the task is CREATED - it does
        ``ensure_future(...).add_done_callback(done_cb)`` and hands back a separate, plain
        ``ConsoleFuture`` - so cancelling what it returns would cancel a future nobody is running:
        the real task would carry on, and `done_cb` would then call `set_exception` on a future it
        had already cancelled. `_runcode_with_lock` is private and one Pyodide release from being
        renamed. `runcode` is documented API, it runs INSIDE the task, and `current_task()` there is
        exactly the task to cancel - no snapshot of `all_tasks()`, no guessing.

        The cancellation is also caught here rather than being allowed out, and that is not tidiness.
        ``done_cb`` in `runsource` opens with ``fut.exception()``, which RAISES on a cancelled task:
        the callback would die, the `ConsoleFuture` would never be settled, and the console would
        hang on a line the visitor had just asked to abandon. So the task finishes with an ordinary
        exception - `KeyboardInterrupt`, which is what Python calls this - and every path downstream
        stays the path an exception already takes.
        """

        async def runcode(self, source, code):
            global _running_task
            _running_task = _asyncio.current_task()
            try:
                return await super().runcode(source, code)
            except _asyncio.CancelledError as cancelled:
                if not _interrupt_requested:
                    raise
                # The visitor's own frames, because the cancellation was raised at the await inside
                # their code. Returned rather than raised - see `_INTERRUPTED`.
                global _interrupt_report
                _interrupt_report = _format_interrupt(cancelled.__traceback__)
                return _INTERRUPTED
            finally:
                _running_task = None

    main = _sys.modules["__main__"].__dict__
    _console = _InterruptibleConsole(
        main,
        stdout_callback=stdout_callback,
        stderr_callback=stderr_callback,
    )
    return True


def console_push(line):
    """Feed one line to the console and report only what JavaScript can hold.

    Returns ``(syntax, error_text, future_or_None)``. The future is the ONE Python object that
    crosses to JavaScript, and only when there is something to await; for an incomplete line or a
    syntax error it is ``None``, so the common typing case transfers no proxy at all.
    """
    future = _console.push(line)
    syntax = future.syntax_check
    if syntax == "syntax-error":
        # Read the formatted error and drop the future here: the caller has nothing to await, and
        # a future nobody awaits is a proxy nobody destroys.
        text = future.formatted_error or ""
        return (syntax, text, None)
    if syntax == "incomplete":
        return (syntax, "", None)
    return (syntax, "", future)


async def run_future(future):
    """Await a ``ConsoleFuture`` and reduce it to primitives.

    The awaiting happens in PYTHON rather than in JavaScript, which is the point. The JavaScript
    pattern - await the future proxy, unwrap the value, test whether it is itself a proxy, destroy
    it, destroy the future, destroy the wrapper - has five ownership decisions in it and gets one
    of them wrong under an exception. Here the value never leaves Python: it is repr'd in place and
    what crosses the boundary is a string.
    """
    global _interrupt_requested
    interrupted = False
    try:
        result = await future
    except BaseException as exc:  # noqa: BLE001 - a REPL reports every exception, incl. SystemExit
        formatted = getattr(future, "formatted_error", None) or _traceback.format_exc()
        return (False, "", _report(exc, formatted))
    finally:
        # Cleared HERE, not in `runcode`, and only once the future this request was waiting on has
        # settled. An interrupt races the end of the execution it is aimed at: a Ctrl+C pressed in
        # the instant a line finishes finds no task, changes nothing, and must not leave a flag
        # behind that turns the NEXT line's unrelated cancellation into a `KeyboardInterrupt`.
        interrupted = _interrupt_requested
        _interrupt_requested = False

    if result is _INTERRUPTED:
        # Identity, not the flag: an interrupt that arrived in the instant between the value being
        # computed and the future settling did not interrupt anything, and reporting it would throw
        # away a result the visitor's code had already produced.
        return (False, "", _interrupt_report)
    if interrupted and result is None:
        # Cancelled somewhere this module does not wrap - `loadPackagesFromImports`, a future the
        # console settled early. Nothing ran to completion, so say what happened rather than
        # printing an empty success.
        return (False, "", "KeyboardInterrupt\n")

    if result is None:
        # A statement, or an expression whose value is None. A REPL prints nothing for both, which
        # is why this is not `repr(None)`.
        return (False, "", None)

    try:
        from pyodide.console import repr_shorten

        text = repr_shorten(result, limit=REPR_LIMIT)
    except Exception:  # a __repr__ that raises is the user's bug, not a reason to lose the result
        text = "<unrepresentable %s>" % type(result).__name__
    return (True, text, None)


@_contextlib.contextmanager
def _no_redirection():
    """What `run()` gets before a console exists: the interpreter's own streams, untouched."""
    yield


def _stream_redirection():
    """The console's stdout/stderr for the duration of a snippet, when there is a console.

    `run()` and `push()` are two entry points to ONE interpreter and their output has to look the
    same. The console owns the callbacks the worker forwards; borrowing its redirection is what
    makes `run()` emit the same bytes, in the same order, attributed the same way.
    """
    if _console is None:
        return _no_redirection()
    return _console.redirect_streams()


async def run_source(source):
    """Execute a whole snippet, as if it were a file. Returns ``(has_value, text, error)``.

    Separate from the console on purpose: this must NOT touch the console's line buffer, so a host
    that runs a snippet while the user is halfway through typing a ``for`` loop does not eat their
    continuation.

    ``PyCF_ALLOW_TOP_LEVEL_AWAIT`` is not optional here, and a plain ``compile(..., "exec")`` was
    the first version of this function. It made ``push("await ...")`` work and ``run("await ...")``
    fail with ``SyntaxError: 'await' outside function`` - two entry points to one interpreter
    disagreeing about what Python is, which is exactly the kind of seam a consumer discovers at the
    worst moment. With the flag, an exec-mode code object containing a top-level await EVALUATES to
    a coroutine instead of running to completion, so it has to be awaited rather than discarded;
    ``eval`` is used rather than ``exec`` only because ``exec`` throws that coroutine away.
    """
    global _running_task, _interrupt_requested
    main = _sys.modules["__main__"].__dict__
    try:
        code = compile(source, "<snippet>", "exec", flags=_ALLOW_TOP_LEVEL_AWAIT)
    except SyntaxError:
        return (False, "", _traceback.format_exc())
    # A block is awaited by the ffi's coroutine-to-Promise adapter, which runs it as a task - so
    # `current_task()` is this execution, the same handle `runcode` takes for a typed line. `None`
    # on a runtime that drives the coroutine some other way; an interrupt then finds nothing to
    # cancel and says so, rather than cancelling something else.
    _running_task = _asyncio.current_task()
    try:
        # Through the CONSOLE's streams, exactly as a typed line goes.
        #
        # Without this, `run()` wrote to whatever `sys.stdout` was outside the console's
        # redirection - Pyodide's own global hook, which batches by LINE and hands JavaScript the
        # text with the newline removed. So `print("first")` and `print("second")` arrived as
        # "first" and "second" and the transcript read `firstsecond`: a program's output could not
        # be read and could not be pasted back. The console's `_WriteStream` passes the string
        # through unchanged, so a write with no newline does not acquire one either.
        with _stream_redirection():
            returned = eval(code, main)  # noqa: S307 - running user Python is this package's job
            if returned is not None and _inspect.isawaitable(returned):
                await returned
    except _asyncio.CancelledError as cancelled:
        if not _interrupt_requested:
            # Not a visitor's Ctrl+C. Whoever cancelled this task meant it; passing it on is the
            # only honest thing to do, and translating it would invent an interrupt nobody asked
            # for.
            raise
        return (False, "", _format_interrupt(cancelled.__traceback__))
    except BaseException as exc:  # noqa: BLE001
        return (False, "", _report(exc, _traceback.format_exc()))
    finally:
        _running_task = None
        _interrupt_requested = False
    return (False, "", None)


def clear_buffer():
    """Drop a half-typed multi-line statement.

    This is NOT the interrupt - `interrupt()` is, and it cancels the task an execution is running
    in. This empties the console's line buffer, which is only ever non-empty while the console is
    waiting for more input, and is what Ctrl-C means at an idle prompt.
    """
    if _console is None:
        return True
    _console.buffer = []
    return True


def complete(source):
    """Completions for the end of ``source``: ``(matches, start_offset)``."""
    if _console is None:
        return ([], len(source))
    try:
        matches, start = _console.complete(source)
    except Exception:  # rlcompleter can raise on half-typed source; an empty list is the answer
        return ([], len(source))
    # A list of str and an int: both plain. Deduplicated because rlcompleter repeats names that are
    # reachable by more than one route, and a menu with `sorted` twice in it looks broken.
    seen = []
    for match in matches:
        if match not in seen:
            seen.append(match)
    return (seen, int(start))


def capture_display():
    """Rich output produced by the execution that just finished, as protocol-shaped dicts."""
    try:
        return _rich_display.capture_figures()
    except Exception as exc:  # the bridge failing must never fail the user's execution
        return [
            {
                "mime": "text/plain",
                "encoding": "utf8",
                "data": "browser-python display bridge error: %s" % exc,
            }
        ]


def install_browser_http():
    """Register the Fetch-backed filesystems. Returns a status string for the ready event.

    Two of them: `browser_http` for `http`/`https`, and `browser_s3` for anonymous `s3://` against
    a named HTTPS gateway, which is a URL rewrite in front of the first. One call site, because a
    profile that has fsspec wants both and a profile that has not cannot have either.
    """
    import browser_http
    import browser_s3

    browser_http.install()
    browser_s3.install()
    return "installed"


def install_cartopy_data():
    """Arm on-demand Natural Earth downloads for Cartopy. Returns a status for the ready event.

    Cheap, and it imports nothing: `cartopy_data.install()` only puts a finder on `sys.meta_path`
    that answers for one module name, so a session that never draws a map pays nothing and a session
    that does gets the adaptation at the moment `cartopy.io.shapereader` loads.

    A failure here is reported and swallowed. Prepared data keeps working without this - it is read
    from `CARTOPY_DATA_DIR` by Cartopy itself - so a console that cannot arm the downloads is less
    capable, not broken, and taking the interpreter down over it would be the wrong trade.
    """
    try:
        import cartopy_data

        return cartopy_data.install()
    except Exception as exc:
        return "unavailable: %s: %s" % (type(exc).__name__, exc)


def versions(names):
    """Resolved versions of whatever is actually importable, for the ready event.

    Reported rather than hardcoded: the wheel set a CDN serves for a pinned runtime is not this
    package's to promise, and a UI that prints its own idea of the xarray version will eventually
    print a number that is not there.
    """
    import importlib

    out = {}
    for name in names:
        try:
            module = importlib.import_module(name)
        except Exception:
            continue
        version = getattr(module, "__version__", None)
        if version:
            out[name] = str(version)
    return out


def python_version():
    return "%d.%d.%d" % _sys.version_info[:3]
