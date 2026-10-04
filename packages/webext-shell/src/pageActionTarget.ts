import browser from "webextension-polyfill"

// Only target URLs cross this bridge; page content is not read. Report ahead
// of contextmenu because Chrome has no menus.onShown/refresh equivalent.
let previous = ""
const events = ["pointerover", "focusin", "contextmenu"]
const connected = (): boolean => {
  try { return Boolean(browser.runtime.id) } catch { return false }
}
const detach = (): void => {
  for (const type of events) document.removeEventListener(type, report, true)
}
const failed = (error: unknown): void => {
  // A worker with no receiver may come back; an unloaded extension cannot.
  if (!connected() || /extension context invalidated/i.test(String(error))) detach()
}
const report = (event: Event): void => {
  if (!connected()) { detach(); return }
  const link = event.composedPath().find(node => node instanceof HTMLAnchorElement) as HTMLAnchorElement | undefined
  const href = link?.href || location.href
  if (href === previous && event.type !== "contextmenu") return
  previous = href
  try {
    void browser.runtime.sendMessage({ onceCommand: "page-actions-target", href }).catch(failed)
  } catch (error) { failed(error) }
}
for (const type of events) document.addEventListener(type, report, true)
