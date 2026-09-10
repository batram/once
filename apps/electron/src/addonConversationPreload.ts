// Preload of the addon conversation page, a tab in the browser session. It is
// the only bridge that page has: ask for the conversation the page's URL names,
// hear the shell's snapshots, and send the reader's input back. The preload
// stays attached if the tab later navigates elsewhere, so it exposes nothing
// outside the page's own scheme, and main checks every sender again.
import { contextBridge, ipcRenderer } from "electron"
import { ELECTRON_IPC, ElectronConversationPageBridge } from "@once/platform-electron/bridge"

if (location.protocol === "once-addon:" && location.host === "conversation") {
  const bridge: ElectronConversationPageBridge = {
    connect: () => ipcRenderer.invoke(ELECTRON_IPC.addonsConversationConnect),
    onState(handler) {
      const listener = (_event: Electron.IpcRendererEvent, snapshot: unknown, connected: boolean) => handler(snapshot, connected)
      ipcRenderer.on(ELECTRON_IPC.addonsConversationState, listener)
      return () => ipcRenderer.removeListener(ELECTRON_IPC.addonsConversationState, listener)
    },
    send: command => ipcRenderer.send(ELECTRON_IPC.addonsConversationCommand, command)
  }
  contextBridge.exposeInMainWorld("onceConversation", bridge)
}
