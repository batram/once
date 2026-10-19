// Electron's side of the runtime's host contract: the shell hooks with the
// tab-creation hook that carries a `WebContents`, the page profile a tab
// needs to show an extension URL, and the platform the handlers report.

import { app, WebContents } from "electron"
import { ExtensionPlatformOs, ExtensionShellHooks, RuntimePlatform } from "@once/webext-runtime"

export type { TabSnapshot } from "@once/webext-runtime"

export interface ElectronShellHooks extends ExtensionShellHooks {
  /** Called with every tab's webContents as soon as the tab exists. */
  onTabCreated(listener: (contents: WebContents) => void): () => void
}

/** How a tab must be created to show a given URL; null for ordinary pages. */
export interface PageProfile {
  session: Electron.Session
  preload: string
}

export function platformOs(platform: NodeJS.Platform): ExtensionPlatformOs {
  if (platform === "win32") return "win"
  if (platform === "darwin") return "mac"
  return "linux"
}

export function electronPlatform(): RuntimePlatform {
  return {
    locale: () => app.getLocale(),
    os: platformOs(process.platform),
    arch: process.arch === "x64" ? "x86-64" : process.arch === "ia32" ? "x86-32" : process.arch
  }
}
