export interface StartupStorageReporter {
  timedOut(label: string): void
  failed(label: string, error: unknown): void
}

export async function waitForStartupStorage(
  label: string,
  operation: () => Promise<void>,
  reporter: StartupStorageReporter,
  timeoutMs = 8_000
): Promise<void> {
  const pending = operation()
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timedOut = Symbol("startup-timeout")
  try {
    const result = await Promise.race([
      pending.then(() => undefined),
      new Promise<typeof timedOut>((resolve) => {
        timeout = setTimeout(() => resolve(timedOut), timeoutMs)
      })
    ])
    if (result !== timedOut) return
    reporter.timedOut(label)
    void pending.catch((error) => reporter.failed(label, error))
  } catch (error) {
    reporter.failed(label, error)
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}
