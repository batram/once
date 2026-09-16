// Main-process side of the addons.mozilla.org bridge (see amoBridge.ts) and
// the XPI download fallback. Both end in the same place: the extension
// manager previews the package, a native dialog shows what the settings
// review would, and only a confirmation installs.

import { BrowserWindow, IpcMainInvokeEvent, Session, WebContents, dialog, ipcMain, webContents } from "electron"
import { ELECTRON_IPC, ElectronExtensionPreview } from "@once/platform-electron/bridge"
import { BrowserCoordinator } from "../TabManager"
import { ExtensionManager } from "./ExtensionManager"
import { ExtensionRuntime } from "./ExtensionRuntime"
import { amoSourceKind } from "./ExtensionPackage"
import { AMO_ORIGIN, AmoAddonState, AmoInstallOutcome } from "./amoBridge"

interface AmoHandlerOptions {
  coordinator: BrowserCoordinator
  extensions: ExtensionRuntime
  browserSession: Session
}

/** Only AMO's own top frame in a shell-owned tab may use the channel. */
function amoPage(event: IpcMainInvokeEvent, coordinator: BrowserCoordinator): { tab: WebContents; shell: WebContents } {
  const tab = event.sender
  let origin = ""
  try { origin = new URL(tab.getURL()).origin } catch { /* not a URL: refused below */ }
  const shell = coordinator.shellOf(tab)
  if (event.senderFrame !== tab.mainFrame || origin !== AMO_ORIGIN || !shell) {
    throw new Error("Untrusted IPC sender")
  }
  return { tab, shell }
}

function reviewDetail(candidate: ElectronExtensionPreview): string {
  const permissions = candidate.permissions.length
    ? candidate.permissions.map((permission) => `• ${permission}`)
    : ["• No additional permissions"]
  return [
    candidate.description, `Version ${candidate.version} · ${candidate.source}`, "",
    "Requested access:", ...permissions, "", ...candidate.warnings
  ].filter((line, index, lines) => line !== "" || lines[index - 1] !== "").join("\n")
}

/** Preview, review in a dialog on the tab's window, install on confirmation. */
async function installFromSource(manager: ExtensionManager, shell: WebContents, source: string): Promise<AmoInstallOutcome> {
  const candidate = await manager.preview(source)
  const owner = BrowserWindow.fromWebContents(shell)
  const options: Electron.MessageBoxOptions = {
    type: "question",
    title: candidate.update ? "Update extension" : "Install extension",
    message: `${candidate.update ? "Update" : "Add"} ${candidate.name} ${candidate.update ? "in" : "to"} Once?`,
    detail: reviewDetail(candidate),
    buttons: [candidate.update ? "Update" : "Install", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  }
  const { response } = owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options)
  if (response !== 0) return { status: "cancelled" }
  await manager.install(candidate.token)
  return { status: "installed" }
}

async function confirmRemoval(manager: ExtensionManager, shell: WebContents, id: string): Promise<boolean> {
  const installed = (await manager.list()).find((entry) => entry.id === id)
  if (!installed || installed.bundled) throw new Error("This extension cannot be removed")
  const owner = BrowserWindow.fromWebContents(shell)
  const options: Electron.MessageBoxOptions = {
    type: "question", title: "Remove extension", message: `Remove ${installed.name} from Once?`,
    detail: "Its local settings are kept for a later reinstall.",
    buttons: ["Remove", "Cancel"], defaultId: 0, cancelId: 1, noLink: true
  }
  const { response } = owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options)
  if (response !== 0) return false
  await manager.remove(id)
  return true
}

async function addonState(manager: ExtensionManager, id: string): Promise<AmoAddonState | null> {
  const entry = (await manager.list()).find((item) => item.id === id)
  return entry
    ? { id, version: entry.version, isEnabled: entry.enabled, isActive: entry.running, canUninstall: !entry.bundled }
    : null
}

function amoTabs(coordinator: BrowserCoordinator): WebContents[] {
  return webContents.getAllWebContents().filter((contents) =>
    !contents.isDestroyed() && contents.getURL().startsWith(`${AMO_ORIGIN}/`) && coordinator.shellOf(contents) !== undefined
  )
}

export function registerAmoHandlers({ coordinator, extensions, browserSession }: AmoHandlerOptions): void {
  const manager = extensions.manager
  ipcMain.handle(ELECTRON_IPC.amoManage, async (event, command: unknown, value: unknown, enabled: unknown) => {
    const { tab, shell } = amoPage(event, coordinator)
    if (command === "install") {
      try {
        return await installFromSource(manager, shell, tab.getURL())
      } catch (error) {
        return { status: "failed", error: error instanceof Error ? error.message : String(error) }
      }
    }
    if (typeof value !== "string") throw new Error("Invalid add-on request")
    if (command === "addon") return addonState(manager, value)
    if (command === "uninstall") return confirmRemoval(manager, shell, value)
    if (command === "enabled") {
      if (typeof enabled !== "boolean") throw new Error("Invalid add-on request")
      return manager.setEnabled(value, enabled)
    }
    throw new Error("Unknown add-on request")
  })
  extensions.onChanged(() => {
    for (const tab of amoTabs(coordinator)) tab.send(ELECTRON_IPC.amoChanged)
  })
  // An XPI from Mozilla is never saved as a file: it goes through the same
  // review. The listing page it was clicked on is the better source when
  // there is one, since that is what the settings page accepts too.
  browserSession.on("will-download", (event, item, contents) => {
    const url = item.getURL()
    if (amoSourceKind(url) !== "download") return
    event.preventDefault()
    const shell = coordinator.shellOf(contents)
    if (!shell) return
    const page = contents.getURL()
    const source = amoSourceKind(page) === "page" ? page : url
    void installFromSource(manager, shell, source).catch((error) => {
      dialog.showErrorBox("Extension not installed", error instanceof Error ? error.message : String(error))
    })
  })
}
