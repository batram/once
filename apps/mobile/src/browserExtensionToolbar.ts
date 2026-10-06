import type { InAppBrowserSurface, MobileBrowserExtensions } from "@once/platform-mobile"
import type { ReadingPageActions } from "./readingPageActions"
import { showChoiceDialog } from "@once/ui-web"

const SETTINGS_PREFIX = "once:settings:"
const PAGE_ACTION_PREFIX = "once:page-action:"

function openExtensionManager(): void {
  document.querySelector<HTMLButtonElement>("#settings_menu_btn")?.click()
  document.querySelector<HTMLButtonElement>('[data-settings-target="extensions"]')?.click()
}

/** The theme the shell resolved: its explicit choice, else the system's. */
function shellIsDark(): boolean {
  const theme = document.body.dataset.theme
  if (theme === "dark" || theme === "light") return theme === "dark"
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches
}

function setStatus(message: string): void {
  const status = document.querySelector<HTMLElement>("#reading_url_validation")
  if (!status) return
  status.textContent = message
  status.hidden = message === ""
}

/**
 * Browser controls use a native sheet so they remain above the page view. The
 * sheet is also where add-on trays are offered for the page being read.
 */
export function bindMobileExtensionToolbar(
  api: MobileBrowserExtensions | null,
  surface: InAppBrowserSurface,
  pageActions: ReadingPageActions = { list: () => [], run() {} },
  /** The shell's Back/Forward, which the sheet shows and hands back as historyRequested. */
  history?: () => { back: boolean; forward: boolean },
  /** The sheet's Close: closes the tab being read. */
  closeTab: () => void = () => undefined
): void {
  const navigate = document.querySelector<HTMLButtonElement>("#reading_navigate")
  if (!navigate) return
  const button = document.createElement("button")
  button.type = "button"
  button.id = "reading_browser_menu"
  button.className = "button button--icon"
  button.title = "Browser menu"
  button.setAttribute("aria-label", "Browser menu")
  button.setAttribute("aria-haspopup", "dialog")
  button.setAttribute("aria-expanded", "false")
  // A wide burger, not ⋮: the story rows below use the three-dot glyph.
  button.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" aria-hidden="true"><path d="M5 5h14M5 12h14M5 19h14"/></svg>'
  // Last in the address row, after the tabs button.
  const form = navigate.parentElement
  if (form) form.append(button)
  else navigate.after(button)
  form?.classList.add("has-browser-menu")
  button.onclick = async () => {
    button.disabled = true
    button.setAttribute("aria-expanded", "true")
    setStatus("")
    try {
      const result = api ? await api.command({ action: "list" }) : { extensions: [] }
      const items = (result.extensions ?? []).filter(item => item.enabled && (item.hasAction || item.hasOptions))
        .map(item => ({
          id: item.id, label: item.name, enabled: true, iconDataUrl: item.iconDataUrl,
          settingsId: item.hasOptions && item.hasAction ? SETTINGS_PREFIX + item.id : undefined
        }))
      if (api) items.push({ id: "once:manage", label: "Manage extensions", enabled: true, iconDataUrl: undefined, settingsId: undefined })
      // Add-on trays for the open page, listed or not; they open above the page.
      const holding = new Set<string>()
      for (const action of pageActions.list()) {
        if (action.holdsSheet) holding.add(PAGE_ACTION_PREFIX + action.id)
        items.push({ id: PAGE_ACTION_PREFIX + action.id, label: action.label, enabled: true, iconDataUrl: undefined, settingsId: undefined,
          ...(action.placement ? { placement: action.placement } : {}), ...(action.holdsSheet ? { holdsSheet: true } : {}) })
      }
      // Both native surfaces draw the sheet (iOS without the extension rows).
      const selected = api || surface.available
        ? await surface.showMenu({ items, browserControls: true, dark: shellIsDark(), history: history?.() })
        : await showBrowserMenu(items)
      if (selected === "once:manage") {
        openExtensionManager()
      } else if (selected?.startsWith(PAGE_ACTION_PREFIX)) {
        const held = holding.has(selected)
        try { await pageActions.run(selected.slice(PAGE_ACTION_PREFIX.length)) } finally {
          // The sheet stayed up for the row's own menu, which closes it; this
          // only covers a run that showed none.
          if (held) await surface.closeBrowserMenu?.()
        }
      } else if (selected === "once:find") {
        // The sheet's own Find control; readingFindBar.ts owns the bar.
        document.dispatchEvent(new Event("once-find-in-page-request"))
      } else if (selected === "once:close-tab") {
        closeTab()
      } else if (api && selected?.startsWith(SETTINGS_PREFIX)) {
        await api.command({ action: "options", id: selected.slice(SETTINGS_PREFIX.length) })
      } else if (api && selected) {
        const extension = result.extensions?.find(item => item.id === selected)
        // Without an open page the action falls back to the extension's own
        // settings; an extension without any lands in the manager instead.
        const outcome = await api.command({ action: extension?.hasAction ? "action" : "options", id: selected })
        if (outcome.noPage) openExtensionManager()
      }
    } catch (error) {
      setStatus(`Could not open browser menu: ${error instanceof Error ? error.message : String(error)}`)
    } finally { button.disabled = false; button.setAttribute("aria-expanded", "false") }
  }
}

/** Platforms without the native extension sheet still have a browser menu. */
function showBrowserMenu(items: { id: string; label: string }[]): Promise<string | null> {
  return showChoiceDialog({ title: "Browser menu", message: "", cancelLabel: "Close",
    choices: [...items, { id: "once:find", label: "Find in page" }, { id: "once:close-tab", label: "Close tab" }].map(item => ({ value: item.id, label: item.label })) })
}
