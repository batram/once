import { ElectronBridge } from "@once/platform-electron/bridge"
import { getKeyboardDispatcher } from "@once/ui-web"

// What each menu command runs: the same keyboard commands the shortcuts do,
// so the menu, the keys and their settings never disagree.
const COMMANDS: Record<string, string> = {
  "new-tab": "browser.new-tab",
  history: "browser.history",
  "new-window": "browser.new-window",
  "close-tab": "browser.close-tab",
  fullscreen: "window.toggle-fullscreen"
}

/** The burger at the end of the address bar, which main draws as a popup. */
export function bindBrowserMenuButton(bridge: ElectronBridge): void {
  const button = document.querySelector<HTMLButtonElement>("#browser_menu")
  if (!button) return
  button.addEventListener("click", () => {
    const keyboard = getKeyboardDispatcher()
    const shortcuts: Record<string, string> = {}
    for (const [command, id] of Object.entries(COMMANDS)) {
      const chord = keyboard.chordsForCommand(id)[0]
      if (chord) shortcuts[command] = chord
    }
    const rect = button.getBoundingClientRect()
    button.setAttribute("aria-expanded", "true")
    void bridge.window.showBrowserMenu(
      { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      shortcuts
    ).then((command) => {
      const id = command ? COMMANDS[command] : undefined
      if (id) keyboard.run(id)
    }).catch((error) => console.error("Could not open the browser menu", error))
      .finally(() => button.setAttribute("aria-expanded", "false"))
  })
}
