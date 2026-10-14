import { ElectronBridge } from "@once/platform-electron/bridge"

/**
 * PROTOTYPE: the "Indra OCR (test)" switch. Main applies it to the next
 * recognition and remembers it; the row only shows when the prototype's files
 * are present (apps/electron/indra-proto, assembled locally).
 */
export function bindIndraOcrSetting(bridge: ElectronBridge): void {
  const section = document.querySelector<HTMLElement>("#electron_indra_ocr_settings")
  const checkbox = document.querySelector<HTMLInputElement>("#electron_indra_ocr_checkbox")
  if (!section || !checkbox) return
  checkbox.disabled = true
  void bridge.settings.getIndraOcr().then(({ enabled, installed }) => {
    if (!installed) return
    section.hidden = false
    checkbox.checked = enabled
    checkbox.disabled = false
  }).catch(() => undefined)
  checkbox.addEventListener("change", () => {
    const wanted = checkbox.checked
    void bridge.settings.setIndraOcr(wanted).catch(() => {
      checkbox.checked = !wanted
    })
  })
}
