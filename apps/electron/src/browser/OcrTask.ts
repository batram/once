/** Bound an operation whose underlying Electron API does not accept an AbortSignal. */
export function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("Recognition cancelled"))
    if (signal.aborted) { operation.catch(() => undefined); abort(); return }
    signal.addEventListener("abort", abort, { once: true })
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
  })
}
