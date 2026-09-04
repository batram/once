import { ElectronBridge } from "@once/platform-electron/bridge"

/**
 * The "Screen reader support" switch. Chromium already answers tab-strip
 * tools with a basic tree on demand; this opts into the full tree for every
 * page, which main applies immediately and remembers for the next start.
 */
export function bindAccessibilitySetting(bridge: ElectronBridge): void {
  const section = document.querySelector<HTMLElement>("#electron_accessibility_settings")
  const checkbox = document.querySelector<HTMLInputElement>("#electron_accessibility_checkbox")
  if (!section || !checkbox) return
  section.hidden = false
  checkbox.disabled = true
  void bridge.settings.getAccessibility().then((enabled) => {
    checkbox.checked = enabled
    checkbox.disabled = false
  }).catch(() => {
    checkbox.disabled = false
  })
  checkbox.addEventListener("change", () => {
    const wanted = checkbox.checked
    void bridge.settings.setAccessibility(wanted).catch(() => {
      checkbox.checked = !wanted
    })
  })
}
