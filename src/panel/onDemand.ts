/** A module loaded on first use, by a dynamic import, so it stays out of the bundle the panel starts with. */
export interface OnDemand<T> {
  /** The module, once a load has finished; undefined before. */
  loaded(): T | undefined;
  /** Starts the load the first time it is called; every call gives the same promise. */
  load(): Promise<T>;
}

/** The longest wait for the page to fall idle before `whenIdle` resolves anyway. */
const IDLE_TIMEOUT_MS = 300;

/**
 * Resolves when the page is next idle, so a library first needed while a file opens is
 * compiled after the file's first lines are drawn, not before.
 */
export function whenIdle(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(() => resolve(), { timeout: IDLE_TIMEOUT_MS });
    else setTimeout(resolve, 0);
  });
}

/** In-flight on-demand loads and deferred redraws, so browser specs can wait deterministically. */
const pending = new Set<Promise<unknown>>();

/** Registers an async load/redraw promise until it settles. */
export function trackPending<T>(promise: Promise<T>): Promise<T> {
  pending.add(promise);
  const done = () => {
    pending.delete(promise);
  };
  promise.then(done, done);
  return promise;
}

/** Resolves once every tracked on-demand load and deferred redraw currently under way has settled. */
export async function whenAllLoaded(): Promise<void> {
  while (pending.size > 0) {
    await Promise.allSettled([...pending]);
  }
}

export function onDemand<T>(load: () => Promise<T>): OnDemand<T> {
  let module: T | undefined;
  let loading: Promise<T> | undefined;
  return {
    loaded: () => module,
    load: () => (loading ??= trackPending(load().then((m) => (module = m)))),
  };
}
