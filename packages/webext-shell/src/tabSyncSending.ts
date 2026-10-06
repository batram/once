import { restorePlan, type TabSyncService } from "@once/app/tabsync"
import { createWebExtTabOpener } from "@once/platform-webext/backgroundPorts"

const MENU = "once-tabsync-send"
const NOTIFIED_KEY = "once:tabsync:notified"
const NOTICE = "once-tabsync-sent:"

/**
 * Sending and receiving tabs in the browser itself, panel or not: a "Send
 * tab to device" page menu listing the other devices, and a notification
 * for each tab another device sent here, where the user allowed them.
 */
export function installTabSyncSending(
  api: typeof browser,
  target: "chrome" | "firefox",
  service: () => TabSyncService | null
): { changed(): void } {
  const menus = api.menus ?? api.contextMenus
  const opener = createWebExtTabOpener(api)
  let rebuilding: Promise<unknown> = Promise.resolve()
  let lastMenu = ""

  menus?.onClicked.addListener((info, tab) => {
    const id = String(info.menuItemId)
    if (!id.startsWith(`${MENU}:`) || tab?.id === undefined) return
    void service()?.sendLocal(id.slice(MENU.length + 1), String(tab.id))
      .catch((error) => console.error("Could not send the tab", error))
  })
  api.notifications?.onClicked.addListener((noticeId) => {
    if (!noticeId.startsWith(NOTICE)) return
    void api.notifications.clear(noticeId)
    void service()?.takeSent(noticeId.slice(NOTICE.length)).then((sent) => {
      if (!sent) return
      const plan = restorePlan(sent.url, sent.mode, sent.state)
      opener.open(plan.url, { background: false, mode: sent.mode, restore: plan.restore })
    })
  })

  const rebuildMenu = (devices: Array<{ deviceId: string; name: string }>) => {
    const signature = JSON.stringify(devices)
    if (!menus || signature === lastMenu) return
    lastMenu = signature
    rebuilding = rebuilding.then(async () => {
      await menus.remove(MENU).catch(() => undefined)
      if (!devices.length) return
      const contexts = (target === "firefox" ? ["page", "tab"] : ["page"]) as browser.menus.ContextType[]
      const patterns = ["http://*/*", "https://*/*"]
      menus.create({ id: MENU, title: "Send tab to device", contexts, documentUrlPatterns: patterns })
      for (const device of devices) {
        menus.create({ id: `${MENU}:${device.deviceId}`, parentId: MENU, title: device.name, contexts, documentUrlPatterns: patterns })
      }
    }).catch((error) => console.warn("Could not update the send menu", error))
  }

  const notify = async (inbox: Array<{ id: string; fromName: string; title: string; url: string }>) => {
    if (!api.notifications || !await api.permissions.contains({ permissions: ["notifications"] }).catch(() => false)) return
    const stored = (await api.storage.session.get(NOTIFIED_KEY))[NOTIFIED_KEY]
    const notified = new Set(Array.isArray(stored) ? stored as string[] : [])
    for (const sent of inbox) {
      if (notified.has(sent.id)) continue
      notified.add(sent.id)
      await api.notifications.create(`${NOTICE}${sent.id}`, {
        type: "basic", iconUrl: api.runtime.getURL("static/imgs/icons/mipmap-mdpi/ic_launcher.png"),
        title: `Tab from ${sent.fromName}`, message: sent.title || sent.url
      }).catch(() => undefined)
    }
    await api.storage.session.set({ [NOTIFIED_KEY]: [...notified].filter((id) => inbox.some((sent) => sent.id === id)) })
  }

  return {
    changed() {
      void service()?.view().then((view) => {
        rebuildMenu(view.devices.map(({ deviceId, name }) => ({ deviceId, name })))
        return notify(view.inbox)
      }).catch(() => undefined)
    }
  }
}
