import browser from "webextension-polyfill"

// Only target URLs cross this bridge; page content is not read. Report ahead
// of contextmenu because Chrome has no menus.onShown/refresh equivalent.
let previous = ""
const report = (event: Event): void => {
  const link = event.composedPath().find(node => node instanceof HTMLAnchorElement) as HTMLAnchorElement | undefined
  const href = link?.href || location.href
  if (href === previous && event.type !== "contextmenu") return
  previous = href
  void browser.runtime.sendMessage({ onceCommand: "page-actions-target", href }).catch(() => undefined)
}
for (const type of ["pointerover", "focusin", "contextmenu"]) document.addEventListener(type, report, true)
