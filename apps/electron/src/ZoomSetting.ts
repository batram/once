import { ElectronBridge } from "@once/platform-electron/bridge"

/**
 * The Appearance settings' zoom rows: somewhere to set the zoom back for a
 * reader who changed it by accident and does not know the shortcut.
 *
 * Keys and Ctrl+wheel zoom the shell in main, without telling anyone. A zoom
 * change resizes the shell's viewport, though, so on every resize the select
 * asks main for the real factor, and passes a changed one back to be stored.
 */
export function bindZoomSetting(bridge: ElectronBridge): void {
  const section = document.querySelector<HTMLElement>("#electron_zoom_settings")
  const select = document.querySelector<HTMLSelectElement>("#electron_interface_zoom")
  const resetPages = document.querySelector<HTMLButtonElement>("#electron_reset_page_zoom")
  if (!section || !select || !resetPages) return
  section.hidden = false
  let known: number | null = null

  const show = (factor: number) => {
    const match = [...select.options].find(
      (option) => !option.dataset.custom && Math.abs(Number(option.value) - factor) < 0.01
    )
    select.querySelector("option[data-custom]")?.remove()
    if (match) {
      select.value = match.value
      return
    }
    // A step the list leaves out, such as 25% or 500% from the keys.
    const custom = new Option(`${Math.round(factor * 100)}%`, String(factor))
    custom.dataset.custom = "true"
    const after = [...select.options].find((option) => Number(option.value) > factor)
    select.add(custom, after ?? null)
    select.value = custom.value
  }

  const sync = async () => {
    const factor = await bridge.zoom.getInterface()
    // Chromium keeps a zoom level rather than the factor, so 0.67 can come
    // back as 0.6699…; that is no change.
    if (known !== null && Math.abs(factor - known) < 0.001) return
    const first = known === null
    known = factor
    show(factor)
    // Main already starts the shell at the stored zoom; only a change since
    // then needs storing.
    if (!first) await bridge.zoom.setInterface(factor)
  }

  let pending = 0
  window.addEventListener("resize", () => {
    cancelAnimationFrame(pending)
    pending = requestAnimationFrame(() => {
      void sync().catch((error) => console.error("Could not read the interface zoom", error))
    })
  })
  void sync().catch((error) => console.error("Could not read the interface zoom", error))

  select.addEventListener("change", () => {
    const factor = Number(select.value)
    known = factor
    void bridge.zoom.setInterface(factor).catch((error) => {
      console.error("Could not set the interface zoom", error)
      known = null
      void sync()
    })
  })
  resetPages.addEventListener("click", () => {
    void bridge.zoom.resetPages().catch((error) => console.error("Could not reset page zoom", error))
  })
}
