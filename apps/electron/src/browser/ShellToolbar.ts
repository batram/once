import { ElectronBridge } from "@once/platform-electron/bridge"
import { TOOLBAR_PINS_CHANGED, bindExtensionToolbar, bindUnpinMenu, isToolPinned, shellIconData, unpinTool } from "../ExtensionToolbar"
import { PageAddonActions } from "./PageAddonActions"

/**
 * Wires the extensions menu to the shell's own pinnable buttons. The reader
 * toggle is pinnable like a button an add-on contributes; unpinned, it only
 * hides, and the menu still runs it.
 */
export function bindShellToolbar(
  bridge: ElectronBridge,
  container: HTMLElement,
  readerButton: HTMLButtonElement,
  pageAddonActions: PageAddonActions,
  openSettings: () => void
): void {
  const applyReaderPin = () => { readerButton.hidden = !isToolPinned("reader") }
  applyReaderPin()
  document.addEventListener(TOOLBAR_PINS_CHANGED, applyReaderPin)
  bindUnpinMenu(bridge, readerButton, "Reader mode", () => unpinTool("reader"))
  bindExtensionToolbar(bridge, container, {
    openSettings,
    tools: async () => [
      { id: "reader", name: "Reader mode", icon: await shellIconData("article"), enabled: !readerButton.disabled },
      ...await pageAddonActions.tools()
    ],
    runTool: (id) => {
      if (id === "reader") readerButton.click()
      else pageAddonActions.run(id)
    }
  })
}
