import { ElectronBridge, ElectronTabState } from "@once/platform-electron/bridge"
import { AddonPage, PAGE_ADDON_ACTIONS_CHANGED, isAddonPage, pageAddonActions, runPageAddonAction } from "@once/ui-web"

/**
 * Add-on actions for the page in the active tab, beside the reader button:
 * those an add-on declared for the `button` surface. A tray continues its
 * conversation in a new tab, so it works for any page, listed story or not.
 * The `menu` ones go to main, which offers them in every page's context
 * menu and reports the choice.
 */
export class PageAddonActions {
  private page: AddonPage | null = null

  constructor(private readonly bridge: ElectronBridge, private readonly host: HTMLElement) {
    document.addEventListener(PAGE_ADDON_ACTIONS_CHANGED, () => this.render())
    bridge.addons.pageActions.onRun((id, page) => {
      if (typeof id === "string" && typeof page?.href === "string") runPageAddonAction(id, { href: page.href, title: String(page.title ?? "") }, "continue")
    })
    this.render()
  }

  /** The active tab, or none; only a web page gets live buttons. */
  setTab(tab: ElectronTabState | undefined): void {
    this.page = tab && isAddonPage(tab.url) ? { href: tab.url, title: tab.title } : null
    for (const button of this.host.querySelectorAll("button")) button.disabled = !this.page
  }

  private render(): void {
    this.bridge.addons.pageActions.set(pageAddonActions("menu"))
      .catch(error => console.error("Could not share add-on page actions with the browser menu", error))
    this.host.replaceChildren(...pageAddonActions("button").map(action => {
      const button = document.createElement("button")
      button.type = "button"
      button.className = "browser-button image-button"
      button.dataset.pageAddonAction = action.id
      button.title = action.label
      button.setAttribute("aria-label", action.label)
      const icon = document.createElement("span")
      icon.className = `icon icon--chrome icon--${action.icon ?? "link"}`
      icon.setAttribute("aria-hidden", "true")
      button.append(icon)
      button.addEventListener("click", () => { if (this.page) runPageAddonAction(action.id, this.page, "continue") })
      return button
    }))
    for (const button of this.host.querySelectorAll("button")) button.disabled = !this.page
  }
}
