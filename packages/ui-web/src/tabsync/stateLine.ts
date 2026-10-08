import type { TabStateSummary } from "@once/core"

/** One part of a detail line: plain text, or a tab's state with its media glyph. */
export type LinePart = string | TabStateSummary | null | undefined | false

/**
 * Fills `element` with `parts` joined by " · ". A playing or paused tab's
 * state is led by our own play or pause glyph rather than ▶ or ⏸, which
 * Android paints as colour emoji whatever the text asks for; the word stays
 * there for screen readers. Unchanged lines are left alone.
 */
export function fillLine(element: HTMLElement | null, parts: LinePart[]): void {
  if (!element) return
  const shown = parts.filter((part): part is string | TabStateSummary => Boolean(part))
  const key = JSON.stringify(shown)
  if (element.dataset.line === key) return
  element.dataset.line = key
  element.replaceChildren(...shown.flatMap((part, index) => [...(index ? [document.createTextNode(" · ")] : []), lineNode(part)]))
}

function lineNode(part: string | TabStateSummary): Node {
  if (typeof part === "string") return document.createTextNode(part)
  if (!part.media) return document.createTextNode(part.text)
  const media = document.createElement("span")
  media.className = "tab_state_media"
  const glyph = document.createElement("span")
  glyph.className = `icon icon--media-${part.media === "paused" ? "pause" : "play"} tab_state_media_icon`
  glyph.setAttribute("aria-hidden", "true")
  const word = document.createElement("span")
  word.className = "visually_hidden"
  word.textContent = part.media === "paused" ? "Paused " : "Playing "
  media.append(glyph, word, part.text)
  return media
}
