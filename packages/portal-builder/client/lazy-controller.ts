// A session controller that is built on first use (its code is a lazily loaded chunk) and can be
// disposed at any time, including while it is still being built. Disposal is terminal: a build
// that finishes afterwards constructs nothing - so no interpreter starts with a slot that was
// already given back - and anything already constructed is closed.

export interface LazyController<T> {
  /** The controller, built once; rejects after `dispose()`. */
  get(): Promise<T>;
  /** The controller if it has been built (and not disposed). */
  current(): T | null;
  readonly disposed: boolean;
  dispose(): void;
}

export class DisposedError extends Error {
  constructor() {
    super("The session was closed.");
    this.name = "DisposedError";
  }
}

export function lazyController<T>(options: {
  /** Loads what construction needs; nothing is constructed here. */
  load: () => Promise<unknown>;
  /** Constructs the controller; called only while not disposed. */
  construct: (loaded: unknown) => T;
  /** Closes a constructed controller (it releases its own slot). */
  close: (controller: T) => void;
  /** Releases what was reserved for a controller never constructed. */
  release: () => void;
}): LazyController<T> {
  let controller: T | null = null;
  let building: Promise<T> | null = null;
  let disposed = false;
  return {
    get() {
      if (disposed) return Promise.reject(new DisposedError());
      building ??= options.load().then((loaded) => {
        if (disposed) throw new DisposedError();
        controller = options.construct(loaded);
        return controller;
      });
      return building;
    },
    current: () => (disposed ? null : controller),
    get disposed() {
      return disposed;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (controller) options.close(controller);
      else options.release();
    },
  };
}
