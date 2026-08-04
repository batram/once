export type PaneFocus = "stories" | "browser"

/**
 * Which pane the keyboard is currently driving.
 *
 * Published on the body so CSS can light up the story cursor or the active
 * browser tab, rather than leaving the user to guess which of the two a
 * keypress will reach. It tracks the app's own focus, not the OS window's: a
 * background window still remembers where the keys would land.
 */
export function setPaneFocus(pane: PaneFocus): void {
  document.body.dataset.paneFocus = pane
}

/**
 * Recomputes the pane from wherever DOM focus currently sits. Used when the
 * shell regains native focus, which says the keys are back in the shell but
 * not which half of it.
 */
export function refreshPaneFocus(): void {
  const active = document.activeElement
  const inBrowser = typeof active?.closest === "function" &&
    Boolean(active.closest("#right_panel"))
  setPaneFocus(inBrowser ? "browser" : "stories")
}

export function initPaneFocus(): void {
  if (!document.body.dataset.paneFocus) setPaneFocus("stories")
  // Covers everything focusable in the shell: story rows, the search field,
  // the address bar and the tab strip. Focus moving into a WebContentsView is
  // invisible here, so the Electron shell sets the state for that itself.
  document.addEventListener("focusin", (event) => {
    const target = event.target as Element | null
    if (typeof target?.closest !== "function") return
    if (target.closest("#right_panel")) setPaneFocus("browser")
    else if (target.closest("#left_panel")) setPaneFocus("stories")
  })
}
