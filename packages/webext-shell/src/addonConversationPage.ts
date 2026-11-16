// Entry of the extension's addon conversation page: a tab that continues a
// tray's conversation, named by the page's URL. The panel keeps the
// conversation; this page shows what arrives over its runtime port and sends
// input back, on first load and again when history brings it back. A page
// action from the browser's context menu, chosen while no panel was open,
// arrives here instead as `run`, and this page runs it itself.
import browser from "webextension-polyfill"
import { readConversationKey, readConversationSnapshot } from "@once/core"
import { mountAddonConversation, AddonConversationPort } from "@once/ui-web/addons/conversationPage"
import { hostPageAction } from "@once/ui-web/addons/pageActionHost"
import type { BundledAddonFiles } from "@once/ui-web"
import { createOnceApp } from "@once/app"
import { createWebExtPlatform } from "@once/platform-webext"
import { CONVERSATION_PORT, PAGE_ACTION_GRANT, PAGE_ACTION_RUN } from "./addonConversations"
import type { PageActionGrant } from "./pageActionMenuBackground"

declare const __ONCE_BUNDLED_ADDONS__: BundledAddonFiles[]

function connect(): AddonConversationPort {
  let port: ReturnType<typeof browser.runtime.connect> | null = null
  return {
    subscribe(listener) {
      let stopped = false
      let deadline: ReturnType<typeof setTimeout> | undefined
      let retry: ReturnType<typeof setTimeout> | undefined
      let detach: () => void = () => undefined
      const stop = () => {
        stopped = true
        clearTimeout(deadline)
        clearTimeout(retry)
        detach()
        port?.disconnect()
        port = null
      }
      const attach = () => {
        if (stopped) return
        // A broadcast port can disconnect when any receiving panel closes.
        // Reconnect to the named owner, with a deadline if it has gone away.
        deadline ??= setTimeout(() => { stop(); listener(null, false) }, 5000)
        const current = browser.runtime.connect({ name: CONVERSATION_PORT })
        port = current
        const onMessage = (message: unknown) => {
          const { snapshot, closed } = (message ?? {}) as { snapshot?: unknown; closed?: boolean }
          if (closed) { stop(); listener(null, false); return }
          try {
            const value = snapshot ? readConversationSnapshot(snapshot) : null
            clearTimeout(deadline)
            deadline = undefined
            listener(value, true)
          } catch (error) { console.error("Ignoring an invalid conversation snapshot", error) }
        }
        const onDisconnect = () => {
          detach()
          port = null
          if (!stopped) retry = setTimeout(attach, 100)
        }
        current.onMessage.addListener(onMessage)
        current.onDisconnect.addListener(onDisconnect)
        detach = () => {
          current.onMessage.removeListener(onMessage)
          current.onDisconnect.removeListener(onDisconnect)
        }
      }
      attach()
      return stop
    },
    send: command => port?.postMessage(command)
  }
}

const root = document.getElementById("addon_conversation") ?? document.body
const query = new URLSearchParams(location.search)
const run = query.get(PAGE_ACTION_RUN)
if (run) {
  // Opened from the page context menu while no panel in this window could
  // take the action: this tab runs it over the stored add-ons, without a panel.
  // What it runs, and on which page, comes from the grant that click left with
  // the background. The address alone runs nothing: a link in a feed or on a
  // page can spell it, and would otherwise start an add-on on a page of its
  // choosing without anyone asking for it.
  void (async () => {
    const granted = await browser.runtime.sendMessage({
      onceCommand: "page-action-grant", grant: query.get(PAGE_ACTION_GRANT) ?? ""
    }).catch(() => null) as PageActionGrant | null | undefined
    if (!granted) {
      root.textContent = "This tab was not opened from the page menu, so it runs nothing. Choose the action from a page's context menu."
      return
    }
    const app = createOnceApp(createWebExtPlatform(browser))
    app.watchAddonSettings()
    await hostPageAction(app.client, root, granted.action,
      { href: granted.href, title: granted.title },
      { sandboxUrl: browser.runtime.getURL("static/addon-sandbox.html"), bundledAddons: __ONCE_BUNDLED_ADDONS__ })
  })().catch(error => { root.textContent = "The add-on action could not run."; console.error(error) })
} else if (!readConversationKey(location.href)) {
  root.textContent = "This page does not name a conversation. Open a story's tray in Once and continue from there."
} else {
  mountAddonConversation(root, connect())
}
