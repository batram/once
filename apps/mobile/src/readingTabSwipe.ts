import { attachRowSwipe, type RowSwipe } from "@once/ui-web"

export type ReadingTabSwipe = RowSwipe

/** Tab rows: swipe left closes the tab, swipe right opens it. */
export function attachReadingTabSwipe(rows: HTMLElement, onIdle: () => void = () => undefined): ReadingTabSwipe {
  return attachRowSwipe(rows, {
    row: ".reading_tab_row",
    ignore: '[data-action="close"]',
    hint: ".reading_tab_swipe_hint",
    left: { direction: "close", action: '[data-action="close"]', idle: "Close tab", ready: "Release to close" },
    right: { direction: "open", action: '[data-action="select"]', idle: "Open tab", ready: "Release to open" },
    onIdle
  })
}
