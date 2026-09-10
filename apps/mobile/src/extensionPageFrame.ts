import type { ExtensionPageState, InAppBrowserSurface } from "@once/platform-mobile"

export interface ExtensionPageFrame {
  /** Closes the visible extension page; false when none is open. */
  close(): Promise<boolean>
}

/**
 * Frames the native extension page below the active panel's header. The shell
 * owns the strip with the page title, its status and the close and reload
 * controls, and hands the rectangle underneath to the native host, so the URL
 * bar stays on the reading tab and the title bar on settings.
 */
export function bindExtensionPageFrame(surface: InAppBrowserSurface, onOpenChanged: (open: boolean) => void): ExtensionPageFrame {
  const frame = document.createElement("div")
  frame.id = "extension_page_frame"
  frame.hidden = true
  const bar = document.createElement("div")
  bar.className = "extension_page_bar"
  const title = document.createElement("span")
  title.className = "extension_page_title"
  const status = document.createElement("span")
  status.className = "extension_page_status"
  status.setAttribute("role", "status")
  status.setAttribute("aria-live", "polite")
  const reload = document.createElement("button")
  reload.type = "button"
  reload.className = "button button--icon extension_page_reload"
  reload.setAttribute("aria-label", "Reload")
  reload.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v5h-5"/></svg>'
  reload.onclick = () => void surface.extensionPage({ action: "reload" })
  const close = document.createElement("button")
  close.type = "button"
  close.className = "button extension_page_close"
  close.textContent = "Close"
  close.onclick = () => void surface.extensionPage({ action: "close" })
  bar.append(title, status, reload, close)
  frame.append(bar)
  document.body.append(frame)

  let open = false
  let scheduled = false
  const schedule = (): void => {
    if (scheduled || !open) return
    scheduled = true
    requestAnimationFrame(layout)
  }
  // Observing an element twice is a no-op, so every layout may re-register the
  // panel and header it measured; both change height with their content.
  const resizes = new ResizeObserver(schedule)
  function layout(): void {
    scheduled = false
    if (!open) return
    const panel = document.querySelector("#left_panel")?.getAttribute("active_panel") ?? "stories"
    const host = document.querySelector<HTMLElement>(`.panel[data-panel="${panel}"]`)
    if (!host) return
    // Each panel keeps its own header: the address form on reading, the title
    // bar on settings, and the search bar on the story list.
    const header = panel === "reading" ? host.querySelector("#reading_url_form") : host.querySelector(".bar")
    resizes.observe(host)
    if (header) resizes.observe(header)
    const hostRect = host.getBoundingClientRect()
    const top = header?.getBoundingClientRect().bottom ?? hostRect.top
    frame.style.top = `${top}px`
    frame.style.left = `${hostRect.left}px`
    frame.style.width = `${hostRect.width}px`
    frame.style.height = `${Math.max(0, hostRect.bottom - top)}px`
    const barRect = bar.getBoundingClientRect()
    void surface.extensionPage({ action: "bounds", bounds: {
      x: hostRect.left, y: barRect.bottom, width: hostRect.width, height: Math.max(0, hostRect.bottom - barRect.bottom)
    } })
  }

  const render = (state: ExtensionPageState): void => {
    if (open !== state.open) onOpenChanged(state.open)
    open = state.open
    frame.hidden = !state.open
    document.body.classList.toggle("extension_page_open", state.open)
    title.textContent = state.title
    status.textContent = state.status
    status.hidden = state.status === ""
    close.setAttribute("aria-label", state.title ? `Close ${state.title}` : "Close")
    frame.classList.toggle("extension_page_frame--popup", state.popup)
    if (state.open) layout()
  }
  void surface.addListener("extensionPageChanged", render)

  const leftPanel = document.querySelector("#left_panel")
  if (leftPanel) new MutationObserver(schedule).observe(leftPanel, { attributes: true, attributeFilter: ["active_panel"] })
  resizes.observe(document.documentElement)
  window.visualViewport?.addEventListener("resize", schedule)

  return {
    async close() {
      if (!open) return false
      await surface.extensionPage({ action: "close" })
      return true
    }
  }
}
