import { ElectronBridge, ElectronTabState, ElectronToolbarTool } from "@once/platform-electron/bridge"
import { AddonPage, PAGE_ADDON_ACTIONS_CHANGED, isAddonPage, pageAddonActions, runPageAddonAction } from "@once/ui-web"
import { TOOLBAR_PINS_CHANGED, bindUnpinMenu, isToolPinned, shellIconData, unpinTool } from "../ExtensionToolbar"
import { sourceUrlFromReaderUrl } from "./reader-url"

const toolId = (actionId: string) => `addon:${actionId}`

/**
 * Add-on actions for the page in the active tab, beside the reader button:
 * those an add-on declared for the `button` surface. A tray continues its
 * conversation in a new tab, so it works for any page, listed story or not.
 * The `menu` ones go to main, which offers them in every page's context
 * menu and reports the choice. Each button is pinnable from the extensions
 * menu like an extension's; an unpinned one only hides.
 */
export class PageAddonActions {
  private page: AddonPage | null = null

  constructor(private readonly bridge: ElectronBridge, private readonly host: HTMLElement) {
    document.addEventListener(PAGE_ADDON_ACTIONS_CHANGED, () => this.render())
    document.addEventListener(TOOLBAR_PINS_CHANGED, () => this.render())
    bridge.addons.pageActions.onRun((id, page) => {
      if (typeof id === "string" && typeof page?.href === "string") runPageAddonAction(id, { href: page.href, title: String(page.title ?? "") }, "continue")
    })
    this.render()
  }

  /** The active tab, or none; only a web page gets live buttons. */
  setTab(tab: ElectronTabState | undefined): void {
    const href = tab && (sourceUrlFromReaderUrl(tab.url) ?? tab.url)
    this.page = href && isAddonPage(href) ? { href, title: tab?.title } : null
    this.updateAvailability()
  }

  /** The button actions as the extensions menu lists them, pinned or not. */
  tools(): Promise<ElectronToolbarTool[]> {
    const available = this.available()
    return Promise.all(pageAddonActions("button").map(async action => ({
      id: toolId(action.id), name: action.label, icon: await shellIconData(action.icon ?? "link"), enabled: available.has(action.id)
    })))
  }

  /** Runs the action behind a tool id the menu chose. */
  run(id: string): void {
    const action = pageAddonActions("button").find(action => toolId(action.id) === id)
    if (action && this.page) runPageAddonAction(action.id, this.page, "continue")
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
      button.hidden = !isToolPinned(toolId(action.id))
      const icon = document.createElement("span")
      icon.className = `icon icon--chrome icon--${action.icon ?? "link"}`
      icon.setAttribute("aria-hidden", "true")
      button.append(icon)
      button.addEventListener("click", () => { if (this.page) runPageAddonAction(action.id, this.page, "continue") })
      bindUnpinMenu(this.bridge, button, action.label, () => unpinTool(toolId(action.id)))
      return button
    }))
    this.updateAvailability()
  }

  private available(): Set<string> {
    return new Set(this.page ? pageAddonActions("button", this.page).map(action => action.id) : [])
  }

  private updateAvailability(): void {
    const available = this.available()
    for (const button of this.host.querySelectorAll<HTMLButtonElement>("button")) {
      button.disabled = !available.has(button.dataset.pageAddonAction ?? "")
    }
  }
}
