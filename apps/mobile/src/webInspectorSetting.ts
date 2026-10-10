import { Capacitor, registerPlugin } from "@capacitor/core"

interface WebInspectorPlugin {
  get(): Promise<{ enabled: boolean }>
  set(options: { enabled: boolean }): Promise<void>
}

const WebInspector = registerPlugin<WebInspectorPlugin>("WebInspector")

/**
 * The switch that lets a trusted computer's Web Inspector attach to the
 * running app, release builds included. The native side keeps it, so it
 * also applies from the next launch on, before any page loads.
 */
export function bindWebInspectorSetting(): void {
  const row = document.querySelector<HTMLElement>("#web_inspector_setting")
  const toggle = document.querySelector<HTMLInputElement>("#web_inspector_enabled")
  if (!row || !toggle || !Capacitor.isNativePlatform()) return
  void WebInspector.get().then(({ enabled }) => {
    toggle.checked = enabled
    row.hidden = false
  }).catch((error) => console.warn("Web Inspector setting unavailable", error))
  toggle.addEventListener("change", () => {
    const enabled = toggle.checked
    void WebInspector.set({ enabled }).catch((error) => {
      toggle.checked = !enabled
      console.error("Could not change the Web Inspector setting", error)
    })
  })
}
