/**
 * Runs `work` while holding a named lock shared by every window, panel and
 * worker of this origin, so their startups cannot interleave. Without the Web
 * Locks API (old WebKit, Node tests) it serializes within this context only.
 */
export function withLock<T>(name: string, work: () => Promise<T>): Promise<T> {
  const locks = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks
  if (locks?.request) return locks.request(name, () => work()) as Promise<T>
  const previous = localQueues.get(name) ?? Promise.resolve()
  const run = previous.then(work, work)
  localQueues.set(name, run.catch(() => undefined))
  return run
}

/**
 * Holds `name` for as long as this context lives, starting `onAcquired` once
 * it is granted and calling the returned release to give it up. Contexts
 * without Web Locks always get it, since there is nobody to share it with.
 */
export function holdLock(name: string, onAcquired: () => void): () => void {
  const locks = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks
  let release: () => void = () => undefined
  let released = false
  if (!locks?.request) {
    queueMicrotask(() => { if (!released) onAcquired() })
    return () => { released = true }
  }
  const held = new Promise<void>((resolve) => { release = resolve })
  void locks.request(name, () => {
    if (released) return undefined
    onAcquired()
    return held
  })
  return () => {
    released = true
    release()
  }
}

interface LockManagerLike {
  request(name: string, callback: () => Promise<unknown> | unknown): Promise<unknown>
}

const localQueues = new Map<string, Promise<unknown>>()
