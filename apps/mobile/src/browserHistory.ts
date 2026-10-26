import { historyUrl } from "@once/core"
import { mobileBrowserHistory } from "@once/platform-mobile"
import { mountBrowserHistory, PanelNavigation } from "@once/ui-web"
import type { MobileReadingController } from "./readingController"
import { tabTitle } from "./readingTabs"

/** One recorder per tab, including background tabs; metadata changes update the same visit. */
export function bindMobileBrowserHistory(reading: MobileReadingController): () => void {
  const history = mobileBrowserHistory()
  const recorded = new Map<string, { key: string; id: string; title: string }>()
  reading.tabs.subscribe(() => {
    const live = new Set(reading.tabs.tabs.map(tab => tab.id))
    for (const id of recorded.keys()) if (!live.has(id)) recorded.delete(id)
    for (const tab of reading.tabs.tabs) {
      const state = tab.session.snapshot()
      const url = historyUrl(state.currentUrl)
      if (!url || state.loadState !== "ready" || tab.restored) continue
      const key = `${state.navigationId}:${url}`
      const title = tabTitle(tab)
      if (tab.historyRestoredUrl !== undefined) {
        const restored = historyUrl(tab.historyRestoredUrl) === url
        tab.historyRestoredUrl = undefined
        if (restored) { recorded.set(tab.id, { key, id: "", title }); continue }
      }
      const previous = recorded.get(tab.id)
      if (previous?.key === key) {
        if (previous.id && previous.title !== title && title) {
          previous.title = title
          void history.updateTitle(previous.id, title).catch(report)
        }
        continue
      }
      const id = crypto.randomUUID()
      recorded.set(tab.id, { key, id, title })
      void history.record({ id, url, title, visitedAt: Date.now() }).catch(report)
    }
  })
  let panel: HTMLElement | null = null
  let view: ReturnType<typeof mountBrowserHistory> | undefined
  const close = () => { view?.dispose(); view = undefined; panel?.remove(); panel = null; PanelNavigation.closePanel("browser_history") }
  return () => {
    if (!panel) {
      const main = document.querySelector("#left_main")
      if (!main) return
      panel = document.createElement("section")
      panel.id = "browser_history_panel"
      panel.className = "panel"
      panel.dataset.testid = "browser_history-panel"
      main.append(panel)
      view = mountBrowserHistory(panel, history, url => {
        reading.tabs.create()
        reading.openBrowserUrl(url)
      }, { back: close })
      const header = panel.querySelector("header")
      if (header) header.id = "browser_history_panel_bar"
    } else view?.refresh()
    PanelNavigation.open_panel("browser_history")
  }
}
function report(error: unknown): void { console.error("Could not save browsing history", error) }
