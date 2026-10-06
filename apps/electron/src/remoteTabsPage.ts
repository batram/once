// Entry of the tabs page in a browser tab. The window's shell owns the view;
// this page mounts the shared list over the preload bridge and sends the
// reader's choices back, on first load and whenever history returns to it.
import { mountRemoteTabs, RemoteTabsState } from "@once/ui-web/tabsync/RemoteTabsView"
import type { ElectronRemoteTabsPageBridge } from "@once/platform-electron/bridge"

declare global {
  interface Window { onceRemoteTabs?: ElectronRemoteTabsPageBridge }
}

const root = document.getElementById("remote_tabs") ?? document.body
const bridge = window.onceRemoteTabs
if (!bridge) {
  root.textContent = "Open this page from the tabs button next to the new tab button."
} else {
  let latest: RemoteTabsState = { view: null, connected: false }
  let thumbs: Record<string, string> = {}
  const listeners = new Set<() => void>()
  bridge.onState((state) => {
    const { theme, thumbs: images, ...rest } = state as RemoteTabsState & { theme?: string; thumbs?: Record<string, string> }
    thumbs = images ?? {}
    if (theme) document.body.dataset.theme = theme
    else delete document.body.dataset.theme
    latest = rest
    listeners.forEach((listener) => listener())
  })
  mountRemoteTabs(root, {
    load: async () => latest,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    open: (tab, background) => bridge.send({ type: "open", url: tab.url, mode: tab.mode, background }),
    thumbnail: async (id) => thumbs[id] ?? null,
    openSettings: () => bridge.send({ type: "settings" })
  })
  void bridge.connect()
}
