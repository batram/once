import type { OnceClient, TabSyncView } from "@once/app"
import type { InAppBrowserSurface } from "@once/platform-mobile"
import { chooseDevice, domMenu, sendTargets, type ShowMenu } from "@once/ui-web"

const SEND_PAGE = "once:send-page"
const SEND_LINK = "once:send-link"

/**
 * Sending to another device from where a phone reader already is: the
 * browser sheet ("Send page to device…"), a link's long-press menu ("Send
 * link to device…") and a tab card's own menu in the tab view. The menus are
 * built synchronously, so the latest view is kept here.
 */
let client: OnceClient | null = null
let latest: TabSyncView | null = null
let menu: ShowMenu = domMenu
let announce: (message: string) => void = () => undefined

export function installTabSyncMenus(app: OnceClient, surface: InAppBrowserSurface, status: (message: string) => void): ShowMenu {
  client = app
  announce = status
  menu = nativeMenu(surface)
  const refresh = () => void app.getTabSync().then((view) => { latest = view }, () => undefined)
  app.subscribe("tabSyncChanged", refresh)
  refresh()
  return menu
}

/** The platform's own menu sheet; the shared DOM menu where there is no native surface. */
function nativeMenu(surface: InAppBrowserSurface): ShowMenu {
  return async (anchor, items, title) => {
    if (!surface.available) return domMenu(anchor, items, title)
    const rect = anchor?.getBoundingClientRect()
    return surface.showMenu({
      title,
      dark: shellIsDark(),
      ...(rect ? { anchor: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } } : {}),
      items: items.map(({ id, label }) => ({ id, label, enabled: id !== "none" }))
    })
  }
}

function canSend(): boolean {
  return Boolean(latest?.options.enabled && sendTargets(latest.devices).length)
}

/** "Send page to device…" in the browser sheet, for a web page being read. */
export function sendPageItems(url: string): { id: string; label: string; placement: "page"; holdsSheet: true }[] {
  // The device picker opens over the sheet; both close once a device is chosen.
  return canSend() && /^https?:\/\//i.test(url) ? [{ id: SEND_PAGE, label: "Send page to device…", placement: "page", holdsSheet: true }] : []
}

/** "Send link to device…" in a link's long-press menu. */
export function sendLinkItems(link: string | undefined): { id: string; label: string }[] {
  return canSend() && link && /^https?:\/\//i.test(link) ? [{ id: SEND_LINK, label: "Send link to device…" }] : []
}

/** Runs a send chosen from the sheet or a link menu, settling once it is done; null when `id` is not one. */
export function runSendItem(id: string, page: { url: string; title?: string; mode?: "web" | "reader"; tabId?: string }): Promise<void> | null {
  if (id !== SEND_PAGE && id !== SEND_LINK) return null
  return sendTo(null, page)
}

/** Asks for a device and sends there: this phone's tab with its position, or just an address. */
export async function sendTo(anchor: HTMLElement | null, page: { url: string; title?: string; mode?: "web" | "reader"; tabId?: string }): Promise<void> {
  const app = client
  const view = latest ?? await app?.getTabSync().catch(() => null)
  if (!app || !view) return
  try {
    const target = await chooseDevice(view.devices, anchor, menu)
    if (!target) return
    if (page.tabId) await app.sendLocalTab(target, page.tabId)
    else await app.sendTab(target, { url: page.url, title: page.title ?? "", mode: page.mode ?? "web" })
    announce(`Sent to ${view.devices.find((device) => device.deviceId === target)?.name ?? "the other device"}`)
  } catch {
    announce("The tab could not be sent")
  }
}

/** A tab card's own menu in the tab view (long press, or right click in the web harness). */
export async function localTabMenu(anchor: HTMLElement, tab: { id: string; url: string; title: string },
  actions: { close(): void; copy(url: string): void }): Promise<void> {
  const web = /^https?:\/\//i.test(tab.url)
  const items = [
    ...(web && canSend() ? [{ id: "send", label: "Send to device…" }] : []),
    ...(web ? [{ id: "copy", label: "Copy link" }] : []),
    { id: "close", label: "Close tab" }
  ]
  const choice = await menu(anchor, items, tab.title || tab.url)
  if (choice === "send") await sendTo(anchor.isConnected ? anchor : null, { url: tab.url, title: tab.title, tabId: tab.id })
  else if (choice === "copy") actions.copy(tab.url)
  else if (choice === "close") actions.close()
}

function shellIsDark(): boolean {
  const theme = document.body.dataset.theme
  if (theme === "dark" || theme === "light") return theme === "dark"
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches
}
