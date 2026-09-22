# Consuming the engine

Two examples, and neither is a UI.

**Plain HTML and JavaScript** - [`../demo/`](../demo/). The demo _is_ the plain-JS example: it
imports the built package with a bare `<script type="module">`, no bundler and no transpiler. A
second copy here would only be a second thing to keep in step.

**Astro** - [`PythonConsole.astro`](./PythonConsole.astro), the framework this repository already
uses. The only part worth copying is the singleton: one engine per page, shared by every island,
because starting an interpreter per component downloads the runtime per component.

React, Vue, Svelte and Vite need nothing special. Create the engine in whatever runs once per page
(a module-level constant, a context provider, a store), subscribe with `onOutput` / `onStatus` in
your mount effect, and unsubscribe in the teardown - the subscribe functions return the
unsubscriber. Do **not** create an engine inside a component that can mount twice.

```ts
// React, in a provider that renders once.
const python = useMemo(() => createBrowserPython({ profile: "xarray-zarr" }), []);
useEffect(() => python.onOutput(setLatestEvent), [python]);
useEffect(() => () => python.dispose(), [python]);
```

Bundlers resolve the worker through `new URL("./worker/browser-python.worker.js", import.meta.url)`,
which Vite, webpack 5, Rollup, esbuild and Parcel all understand. If yours does not - or a CSP
forbids the resulting URL - pass `workerURL` or `workerFactory`; see the README.
