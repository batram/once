import { mountBrowserHistory } from "@once/ui-web/history/BrowserHistoryView"
import type { HistoryPageBridge } from "./historyPreload"

declare global { interface Window { onceHistory?: HistoryPageBridge } }
const bridge = window.onceHistory
const root = document.getElementById("browser-history")
if (bridge && root) {
  const theme = (color: string) => {
    const hex = color.replace("#", "").slice(0, 6)
    const rgb = [0, 2, 4].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16))
    document.body.dataset.theme = rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114 < 128 ? "dark" : "light"
  }
  void bridge.theme().then(theme)
  bridge.onTheme(theme)
  const view = mountBrowserHistory(root, bridge, url => { void bridge.open(url) })
  bridge.onChanged(() => view.refresh())
  window.addEventListener("focus", () => view.refresh())
}
