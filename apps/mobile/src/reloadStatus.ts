import type { OnceClient, ProcessingSource } from "@once/app"
import { STORY_RELOAD_STARTED, type StoryReloadTrigger } from "@once/ui-web"

// The reload button and the pull-to-refresh strip stop spinning after this
// many ms; the reload itself runs to completion and the pill reports on it.
// Matches one full turn of `.rotating` (2s, animations.css) and two of the
// pull-to-refresh icon (1s, stories.css) so neither freezes mid-revolution.
export const RELOAD_SPIN_TIMEOUT_MS = 2000
// A button reload that outlives this many ms starts reporting through the
// startup pill. A pull reports from the start: the finger asked for it.
export const RELOAD_REVEAL_DELAY_MS = 3000
// How long the pill confirms a finished reload before it folds away again.
export const RELOAD_DONE_NOTICE_MS = 1500

export type ReloadStatusState = "loading" | "done" | "ready"
export type ShowReloadStatus = (message: string, state: ReloadStatusState) => void

export interface ReloadStatusOptions {
  revealDelay?: number
  doneNotice?: number
  // Where the story list announces a starting reload; the document by default.
  reloadEvents?: EventTarget
}

export function describeProcessing(items: ProcessingSource[]): string {
  const domains = Array.from(new Set(items.map((item) => item.domain)))
  const noun = domains.length === 1 ? "source" : "sources"
  return `Loading ${domains.length} ${noun}: ${domains.join(", ")}`
}

/**
 * Mirrors a reload into the startup status pill. A pull-to-refresh shows the
 * pill at once; a button reload only once it has run for the reveal delay,
 * since a quick one is covered by the spinner. Once shown, the pill names the
 * sources still loading, follows every change until the pass settles,
 * confirms briefly, and hides again.
 */
export function bindReloadStatus(
  client: Pick<OnceClient, "subscribe">,
  show: ShowReloadStatus,
  options: ReloadStatusOptions = {}
): () => void {
  const revealDelay = options.revealDelay ?? RELOAD_REVEAL_DELAY_MS
  const doneNotice = options.doneNotice ?? RELOAD_DONE_NOTICE_MS
  const reloadEvents = options.reloadEvents ?? document
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

  // The reload announces itself before the runtime reports its first source,
  // so a pull shows a generic line until the sources are known.
  const onReloadStarted = (event: Event): void => {
    const trigger = (event as CustomEvent<StoryReloadTrigger>).detail
    if (trigger !== "pull" || shown) return
    clearReveal()
    clearDismiss()
    shown = true
    show("Loading stories…", "loading")
  }
  reloadEvents.addEventListener(STORY_RELOAD_STARTED, onReloadStarted)

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
        }, revealDelay)
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
    reloadEvents.removeEventListener(STORY_RELOAD_STARTED, onReloadStarted)
    unsubscribe()
  }
}
