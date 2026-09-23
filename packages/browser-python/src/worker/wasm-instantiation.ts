import type { PyodideApi } from "./pyodide-runtime.js";

export const MAX_SYNC_WASM_BYTES = 8 * 1024 * 1024;

export function useSyncInstantiationWhileLoading(
  runtime: PyodideApi,
  wasm: typeof WebAssembly = WebAssembly,
): void {
  let loading = 0;
  const original = wasm.instantiate;
  wasm.instantiate = function (
    source: BufferSource | WebAssembly.Module,
    imports?: WebAssembly.Imports,
    ...rest: unknown[]
  ) {
    const bytes =
      source instanceof ArrayBuffer || ArrayBuffer.isView(source) ? source.byteLength : Infinity;
    if (loading === 0 || bytes > MAX_SYNC_WASM_BYTES || rest.length > 0)
      return Reflect.apply(original, wasm, [source, imports, ...rest]);
    try {
      const module = new wasm.Module(source as BufferSource);
      return Promise.resolve({ module, instance: new wasm.Instance(module, imports) });
    } catch (error) {
      return Promise.reject(error);
    }
  } as typeof WebAssembly.instantiate;

  const whileLoading = <A extends unknown[], R>(
    load: (...args: A) => Promise<R>,
  ): ((...args: A) => Promise<R>) => {
    return async (...args: A) => {
      loading += 1;
      try {
        return await load.apply(runtime, args);
      } finally {
        loading -= 1;
      }
    };
  };
  runtime.loadPackage = whileLoading(runtime.loadPackage);
  // `loadPackagesFromImports` holds its own reference to Pyodide's loader, and it is what
  // `run()`, `push()` and the console reach for an automatic import, so it is wrapped too.
  runtime.loadPackagesFromImports = whileLoading(runtime.loadPackagesFromImports);
}
