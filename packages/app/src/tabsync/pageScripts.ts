/**
 * Functions that run inside a page, not here. Each is self-contained (no
 * imports, no outer variables) and synchronous, because platforms ship them
 * differently: as source text (Electron, mobile) or as a function with
 * JSON arguments (an extension's scripting API, which runs no strings).
 * Their results must be plain JSON.
 */

/** Where the page's main video or audio is: the playing one, else the most advanced, else the longest. */
export function captureMediaInPage(): { currentTime: number; duration: number; paused: boolean; rate: number } | null {
  const media = Array.from(document.querySelectorAll<HTMLMediaElement>("video, audio"))
    .filter((element) => Number.isFinite(element.duration) && element.duration > 0)
  if (!media.length) return null
  const playing = media.find((element) => !element.paused && !element.ended)
  const chosen = playing ?? media.reduce((best, element) =>
    element.currentTime > best.currentTime || (element.currentTime === best.currentTime && element.duration > best.duration) ? element : best)
  if (!playing && chosen.currentTime < 1) return null
  return { currentTime: chosen.currentTime, duration: chosen.duration, paused: chosen.paused, rate: chosen.playbackRate || 1 }
}

/**
 * Seeks the page's main media to `seconds` once it appears, for up to
 * fifteen seconds; players often build their element after the page loads.
 * It never starts playback: browsers block that, and the reader decides.
 */
export function restoreMediaInPage(seconds: number, rate: number): void {
  const started = Date.now()
  const timer = setInterval(() => {
    const element = Array.from(document.querySelectorAll<HTMLMediaElement>("video, audio"))
      .find((candidate) => Number.isFinite(candidate.duration) && candidate.duration > 0)
    if (element) {
      clearInterval(timer)
      if (Math.abs(element.currentTime - seconds) > 2) element.currentTime = Math.min(seconds, Math.max(0, element.duration - 1))
      if (rate > 0 && rate !== 1) element.playbackRate = rate
    } else if (Date.now() - started > 15000) clearInterval(timer)
  }, 300)
}

/**
 * How far an article was read: the first block whose bottom is below the top
 * of the view, by its index and the start of its text, and the fraction of
 * the page scrolled. Blocks are the article's paragraphs, headings, list
 * items, quotes, code and figures, in document order.
 */
export function captureReaderPositionInPage(): { fraction: number; anchor: { index: number; text: string } | null } {
  const scroller = document.scrollingElement ?? document.documentElement
  const room = Math.max(1, scroller.scrollHeight - innerHeight)
  const fraction = Math.min(1, Math.max(0, scroller.scrollTop / room))
  const blocks = Array.from(document.querySelectorAll<HTMLElement>("article :is(p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, figure)"))
  const index = blocks.findIndex((block) => block.getBoundingClientRect().bottom > 1)
  const text = index >= 0 ? (blocks[index].textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 64) : ""
  return { fraction, anchor: index >= 0 ? { index, text } : null }
}

/**
 * Scrolls to a saved reading position: to the block with the saved text (its
 * index first, then a search for the text), else to the saved fraction.
 */
export function restoreReaderPositionInPage(fraction: number, anchorIndex: number, anchorText: string): boolean {
  const blocks = Array.from(document.querySelectorAll<HTMLElement>("article :is(p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, figure)"))
  if (!blocks.length) return false
  const textOf = (block: HTMLElement) => (block.textContent ?? "").replace(/\s+/g, " ").trim()
  let target: HTMLElement | undefined
  if (anchorText) {
    target = blocks[anchorIndex] && textOf(blocks[anchorIndex]).startsWith(anchorText)
      ? blocks[anchorIndex]
      : blocks.find((block) => textOf(block).startsWith(anchorText))
  }
  const scroller = document.scrollingElement ?? document.documentElement
  if (target) scroller.scrollTop += target.getBoundingClientRect().top
  else scroller.scrollTop = fraction * Math.max(0, scroller.scrollHeight - innerHeight)
  return true
}
