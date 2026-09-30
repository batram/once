import type { OnceClient, ProcessingSource } from "@once/app"

// A reload that outlives this many ms drops its spinners (the reload button
// and the pull-to-refresh strip) and reports through the startup pill instead.
export const RELOAD_SPIN_TIMEOUT_MS = 3000
// How long the pill confirms a finished reload before it folds away again.
export const RELOAD_DONE_NOTICE_MS = 1500

export type ReloadStatusState = "loading" | "done" | "ready"
export type ShowReloadStatus = (message: string, state: ReloadStatusState) => void

export interface ReloadStatusOptions {
  spinTimeout?: number
  doneNotice?: number
}

export function describeProcessing(items: ProcessingSource[]): string {
  const domains = Array.from(new Set(items.map((item) => item.domain)))
  const noun = domains.length === 1 ? "source" : "sources"
  return `Loading ${domains.length} ${noun}: ${domains.join(", ")}`
}

/**
 * Mirrors a slow reload into the startup status pill. A quick reload never
 * shows anything: the spinners cover it. Once a pass has run for the spin
 * timeout the pill names the sources still loading, follows every change
 * until the pass settles, confirms briefly, and hides again.
 */
export function bindReloadStatus(
  client: Pick<OnceClient, "subscribe">,
  show: ShowReloadStatus,
  options: ReloadStatusOptions = {}
): () => void {
  const spinTimeout = options.spinTimeout ?? RELOAD_SPIN_TIMEOUT_MS
  const doneNotice = options.doneNotice ?? RELOAD_DONE_NOTICE_MS
  let processing: ProcessingSource[] = []
  let reveal: ReturnType<typeof setTimeout> | null = null
  let dismiss: ReturnType<typeof setTimeout> | null = null
  let shown = false

  const clearReveal = (): void => {
    if (reveal !== null) clearTimeout(reveal)
    reveal = null
  }
  const clearDismiss = (): void => {
    if (dismiss !== null) clearTimeout(dismiss)
    dismiss = null
  }
  const render = (): void => {
    shown = true
    show(describeProcessing(processing), "loading")
  }

  const unsubscribe = client.subscribe("loaderChanged", ({ processing: items }) => {
    const wasProcessing = processing.length > 0
    processing = items
    if (items.length > 0) {
      // A new pass starting inside the done notice takes the pill back over:
      // it is on screen anyway, and "Stories updated" would be a lie.
      const noticePending = dismiss !== null
      clearDismiss()
      if (shown || noticePending) render()
      else if (!wasProcessing && reveal === null) {
        reveal = setTimeout(() => {
          reveal = null
          if (processing.length > 0) render()
        }, spinTimeout)
      }
      return
    }
    clearReveal()
    if (!shown) return
    shown = false
    show("Stories updated", "done")
    dismiss = setTimeout(() => {
      dismiss = null
      show("Ready", "ready")
    }, doneNotice)
  })

  return () => {
    clearReveal()
    clearDismiss()
    unsubscribe()
  }
}
