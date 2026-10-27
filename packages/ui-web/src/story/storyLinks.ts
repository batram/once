import { URLRedirect } from "@once/core"
import { getOnceClient } from "../client"

/**
 * Link handling shared by every anchor on a story row.
 *
 * Rows live inside a swipeable, long-pressable list, so an anchor cannot be
 * left to the browser's default navigation: the click has to be claimed before
 * it reaches the row, and the middle-click path has to be claimed across
 * mousedown, mouseup, and auxclick or the browser opens its own tab as well.
 *
 * The middle-click action runs on auxclick, never on mouseup: the browser only
 * fires auxclick when the press and the release land on the same element. A
 * mouse whose wheel registers a middle press while scrolling releases it on
 * whatever title has scrolled under the pointer, and a mouseup handler opened
 * that story.
 */
export function bindLinkBehavior(
  el: HTMLAnchorElement,
  options: {
    onClick: () => void
    onMiddleClick?: () => void
  }
): void {
  el.addEventListener("click", (e: MouseEvent) => {
    if (e.button === 0) {
      e.preventDefault()
      e.stopPropagation()
      options.onClick()
    }
  })

  if (options.onMiddleClick) {
    const onMiddleClick = options.onMiddleClick
    el.addEventListener("mousedown", (e: MouseEvent) => {
      if (e.button === 1) {
        e.preventDefault()
        e.stopPropagation()
      }
    })

    el.addEventListener("mouseup", (e: MouseEvent) => {
      if (e.button === 1) {
        e.preventDefault()
        e.stopPropagation()
      }
    })

    el.addEventListener("auxclick", (e: MouseEvent) => {
      if (e.button === 1) {
        e.preventDefault()
        e.stopPropagation()
        onMiddleClick()
      }
    })
  }
}

/** Opening a story URL marks it read, whether or not it is the redirect. */
export function openStoryUrl(
  href: string,
  target: string,
  useRedirect = true
): void {
  const url = useRedirect ? URLRedirect.redirect_url(href) : href
  getOnceClient().persistStoryChange(href, "read_state", "read")
  getOnceClient().openUrl(url, target)
}

export function open_story(href: string, target: string): void {
  openStoryUrl(href, target, true)
}
