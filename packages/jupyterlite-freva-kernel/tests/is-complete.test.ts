// The console's Enter: run a whole statement, else a new line with the right indent. The answers
// are CPython's own (`codeop.compile_command`, 3.13), taken for each input below.
import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { isComplete } from "../src/is-complete.js";

const CPYTHON: Array<[string, "complete" | "incomplete" | "invalid"]> = [
  // [input, CPython 3.13 `codeop.compile_command(input)`: None -> incomplete, code -> complete]
  ["x = 1", "complete"],
  ["", "complete"],
  ["   ", "complete"],
  ["# comment", "complete"],
  ["print(1)", "complete"],
  ["x = (1,\n2", "incomplete"],
  ["x = (1,\n2)", "complete"],
  ["for i in range(3):", "incomplete"],
  ["for i in range(3):\n    print(i)", "incomplete"],
  ["for i in range(3):\n    print(i)\n", "complete"],
  ["for i in range(3):\n    print(i)\n\n", "complete"],
  ["@dec\ndef f():\n    return 1", "incomplete"],
  ["@dec\ndef f():\n    return 1\n", "complete"],
  ["@dec", "incomplete"],
  ["@dec\n", "incomplete"],
  ["def f(\n    a,\n):\n    return a", "incomplete"],
  ["def f(\n    a,\n):\n    return a\n", "complete"],
  ["def f(\n    a,\n):", "incomplete"],
  ["try:\n    x = 1", "incomplete"],
  ["try:\n    x = 1\n", "incomplete"],
  ["try:\n    x = 1\n\n", "incomplete"],
  ["try:\n    x = 1\nexcept Exception:\n    pass", "incomplete"],
  ["try:\n    x = 1\nexcept Exception:\n    pass\n", "complete"],
  ["if x:\n    pass\nelse:", "incomplete"],
  ["if x:\n    pass\nelse:\n", "incomplete"],
  ["if x:\n    pass\nelse:\n    y = 2", "incomplete"],
  ["if x:\n    pass\nelse:\n    y = 2\n", "complete"],
  ["x = 1\n", "complete"],
  ['doc = """\nline', "incomplete"],
  ['doc = """\nline\n"""', "complete"],
  ["x = 1 + \\", "incomplete"],
  ["x = 1 + \\\n2", "complete"],
  ["class A:\n    def f(self):\n        return 1", "incomplete"],
  ["class A:\n    def f(self):\n        return 1\n", "complete"],
  ["if x:\n    if y:\n        pass\n", "complete"],
  ["if x:\n    if y:\n        pass\n    else:\n", "incomplete"],
  ["while True:\n    break\nelse:\n    pass\n", "complete"],
  ["with open(f) as g:\n    g.read()\n", "complete"],
  ["def f(): return 1", "incomplete"],
  ["def f(): return 1\n", "complete"],
  ["if x: pass", "incomplete"],
  ["lambda: 1", "complete"],
  ["d = {1:\n2}", "complete"],
  ["x[1:2]", "complete"],
  ["x = [i for i in y\n if i]", "complete"],
  ["async def f():\n    await g()\n", "complete"],
  ["match x:\n    case 1:\n        pass\n", "complete"],
  ["match x:\n    case 1:", "incomplete"],
  ["print('a:')", "complete"],
  ["x: int = 1", "complete"],
  ["for i in x: print(i)", "incomplete"],
  ["else:", "invalid"],
  ["  x = 1", "invalid"],
  ["def f():\nreturn 1", "invalid"],
  ["try:\n    pass\nfinally:\n    pass\n", "complete"],
  ["if x:\n    pass\nelif y:\n", "incomplete"],
  ["s = 'abc", "invalid"],
  ["x = 1 # trailing :", "complete"],
  ["@dec\n@dec2\nclass A:\n    pass\n", "complete"],
  ["class A:\n    def f(self):\n        pass\n\n    def g(self):\n        pass\n", "complete"],
  ["class A:\n    def f(self):\n        pass\n\n    def g(self):\n        pass", "incomplete"],
  ["if x:\n    # comment only\n    pass\n", "complete"],
  ["if x:  # trailing comment\n", "incomplete"],
  ["if x:  # trailing comment", "incomplete"],
  ["@dec(1, 2)\nasync def f():\n    pass\n", "complete"],
  ["@dec\n\ndef f():\n    pass\n", "complete"],
  ["x = {\n  'a': 1,\n}", "complete"],
  ["def f(x: int) -> int:\n    return x\n", "complete"],
  ["def f(x: int) -> int:", "incomplete"],
  ["with (open(a) as b,\n      open(c) as d):\n    pass\n", "complete"],
  ["try:\n    pass\nexcept A:\n    pass\nelse:\n    pass\nfinally:\n    pass\n", "complete"],
  ["try:\n    pass\nexcept A:\n    pass\nelse:", "incomplete"],
  ["if x:\n    pass\n  y = 1\n", "invalid"],
  ["for i in x:\n    pass\nelse:\n    pass", "incomplete"],
  ["x = 1;", "complete"],
  ["x = 1; y = 2", "complete"],
  ["print('''a\nb''')", "complete"],
  ["s = 'a\\\nb'", "complete"],
  ["if x:\n\n    pass\n", "complete"],
  ["if x:\n    pass\n\n\n", "complete"],
  ["while x:\n    if y:\n        break\n    z = 1\n", "complete"],
  ["match p:\n    case [x, y]:\n        pass\n    case _:\n        pass\n", "complete"],
  ["def f():\n    '''doc: string'''\n    return 1\n", "complete"],
  ["x = lambda: (yield)", "complete"],
  ["with a: pass\n", "complete"],
  ["if x: y = 1\nelse: y = 2\n", "complete"],
  ["if x: y = 1\nelse: y = 2", "incomplete"],
  // f-strings (PEP 701: a field's expression may span lines, its format spec may not) and the
  // one-line try.
  ['x = f"{\n', "incomplete"],
  ['x = f"{1 +\n', "incomplete"],
  ['x = f"{1 +\n2}"\n', "complete"],
  ['x = f"a\n', "invalid"],
  ['x = f\'{d["k"]\n', "incomplete"],
  ['x = f"{x!r:\n', "invalid"],
  ['f"""{\n', "incomplete"],
  ['x = rf"{\n', "incomplete"],
  ['x = f"{{\n', "invalid"],
  ['x = f"{ {\n', "incomplete"],
  ['print(f"{a}", f"{\n', "incomplete"],
  ["f'{x'", "invalid"],
  ["f'{x}'", "complete"],
  ['f"{x:>{w}}"', "complete"],
  ['f"{x:>{w}"', "invalid"],
  ['f"{x:>{w"', "invalid"],
  ['x = f"{"a"}"', "complete"],
  ["x = f\"{'a'}\"", "complete"],
  ['x = f"{x!r}"', "complete"],
  ['x = f"{x != y}"', "complete"],
  ['x = f"}"', "invalid"],
  ['x = f"{{}}"', "complete"],
  ['x = f"{', "incomplete"],
  ['x = f"{x', "incomplete"],
  ['x = f"""a\n{b}\n"""', "complete"],
  ['x = f"""a\n{b\n', "incomplete"],
  ['x = f"{(lambda: 1)()}"', "complete"],
  ['x = f"{a[\n1]}"\n', "complete"],
  ['x = F"{\n', "incomplete"],
  ["x = fr'{\n", "incomplete"],
  ['x = Rf"{a}"', "complete"],
  ['x = b"{"', "complete"],
  ["elif = 1", "invalid"],
  ["x = f\"{f'{y}'}\"", "complete"],
  ["x = f\"{f'{\n", "incomplete"],
  ["try: risky()\n", "incomplete"],
  ["try: risky()", "incomplete"],
  ["try: a()\nexcept E: pass\n", "complete"],
  ["try: a()\nfinally: b()\n", "complete"],
  ["try: a()\nx = 1\n", "invalid"],
  ["if x:\n    try: a()\n", "incomplete"],
  ["if x:\n    try: a()\n    except: pass\n", "complete"],
  ['x = f"{x:{\n', "incomplete"],
  ['x = f"{x:\n}"', "invalid"],
  ['x = f"{x#\n}"', "complete"],
  ['x = f"{x=}"', "complete"],
  ['x = f\'{"""\n\'', "incomplete"],
  // Comments in a field's expression (PEP 701) run to the end of their line, quotes and braces too.
  ['s = f"{1 # comment }\n', "incomplete"],
  ['s = f"{1 # comment }', "incomplete"],
  ['s = f"{1 # comment }\n}"\n', "complete"],
  ['s = f"{1 # comment }\n}"', "complete"],
  ['s = f"{x # a "quote" and {brace\n}"\n', "complete"],
  ['s = f"{x # \'\n}"\n', "complete"],
  ['s = f"{x # }}}\n', "incomplete"],
  ["s = f'{x # {{\n'", "invalid"],
  ['s = f"""{x # comment\n}"""\n', "complete"],
  ['s = f"""{x # comment }"""\n', "incomplete"],
  ['s = f"{x:# }"\n', "complete"],
  ['s = f"{x:#x}"', "complete"],
  ['s = f"{x # c\n:>10}"\n', "complete"],
  ['s = f"{ {1: 2} # c\n}"\n', "complete"],
  ['s = f"{[1, # one\n 2]}"\n', "complete"],
  ['s = f"{a}" # {\n', "complete"],
  ['print(f"{1 # c\n})")\n', "complete"],
];

const DIFFERENT: Array<[string, "complete"]> = [
  // Deliberate differences (see is-complete.ts): what codeop's single mode refuses, run as a cell.
  ["x = 1\ny = 2", "complete"],
  ["for i in range(3):\n    print(i)\n    ", "complete"],
  ["for i in x:\n    y = i\nz = 1", "complete"],
  ["for i in x:\n    y = i\nz = 1\n", "complete"],
  ["import os\nimport sys\n", "complete"],
];

describe("is_complete", () => {
  it("answers as CPython's codeop does", () => {
    const wrong = CPYTHON.filter(([code, want]) => isComplete(code).status !== want);
    expect(wrong).toEqual([]);
  });

  // The table checked against the CPython on this machine, where there is one recent enough
  // (3.13+): every row is what its `codeop` says.
  const python = (() => {
    try {
      const v = execFileSync("python3", ["-c", "import sys;print(sys.version_info[:2]>=(3,13))"]);
      return String(v).trim() === "True";
    } catch {
      return false;
    }
  })();
  it.skipIf(!python)("the table is what this machine's CPython says", () => {
    const script = [
      "import codeop, json, sys, warnings",
      "warnings.simplefilter('ignore')",
      "def ask(c):",
      "    try:",
      "        return 'incomplete' if codeop.compile_command(c, '<input>') is None else 'complete'",
      "    except (SyntaxError, ValueError, OverflowError):",
      "        return 'invalid'",
      "print(json.dumps([ask(c) for c in json.load(sys.stdin)]))",
    ].join("\n");
    const answers = JSON.parse(
      String(
        execFileSync("python3", ["-c", script], {
          input: JSON.stringify(CPYTHON.map(([code]) => code)),
        }),
      ),
    ) as string[];
    const differ = CPYTHON.filter(([, want], i) => answers[i] !== want);
    expect(differ).toEqual([]);
  });

  it("the review's cases: a decorated definition, a header over lines, a try, an empty else", () => {
    expect(isComplete("@dec\ndef f():\n    return 1").status).toBe("incomplete");
    expect(isComplete("def f(\n    a,\n):\n    return a").status).toBe("incomplete");
    expect(isComplete("try:\n    x = 1\n")).toEqual({ status: "incomplete", indent: "" });
    expect(isComplete("if x:\n    pass\nelse:\n")).toEqual({
      status: "incomplete",
      indent: "    ",
    });
  });

  it("the second review's cases: a one-line try, f-string fields over lines", () => {
    expect(isComplete("try: risky()\n")).toEqual({ status: "incomplete", indent: "" });
    expect(isComplete('x = f"{\n').status).toBe("incomplete");
    expect(isComplete('x = f"{1 +\n2}"\n').status).toBe("complete");
    expect(isComplete('x = f"{x!r:\n').status).toBe("invalid");
  });

  it("runs what a cell would: several statements, and a block ended on an empty indented line", () => {
    const wrong = DIFFERENT.filter(([code, want]) => isComplete(code).status !== want);
    expect(wrong).toEqual([]);
  });

  it("gives the next line's indent", () => {
    expect(isComplete("for i in range(3):")).toEqual({ status: "incomplete", indent: "    " });
    expect(isComplete("for i in x:\n    if i:")).toEqual({
      status: "incomplete",
      indent: "        ",
    });
    expect(isComplete("for i in x:\n    print(i)")).toEqual({
      status: "incomplete",
      indent: "    ",
    });
    expect(isComplete("ds = xr.open_zarr(\n    url,")).toEqual({
      status: "incomplete",
      indent: "",
    });
    expect(isComplete("x = 1 + \\")).toEqual({ status: "incomplete", indent: "" });
  });
});
