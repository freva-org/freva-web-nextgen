/**
 * Prism's core, in a module of its own, imported before any grammar.
 *
 * The grammars (`prism-clike.js`, `prism-python.js`) extend a global `Prism`, and the core is
 * CommonJS. A bundler that wraps CommonJS lazily (esbuild) runs the core when the importing module
 * runs, after that module's other imports, so `import Prism from core; import "grammar"` side by
 * side evaluates the grammar first and throws `Prism is not defined`. Importing this module first
 * evaluates the core first, in every bundler.
 */
import Prism from "prismjs/components/prism-core.js";

export default Prism;
