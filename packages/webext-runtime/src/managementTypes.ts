// What the extension manager and the settings hand-off report to a shell.
// Electron's bridge types (`@once/platform-electron/bridge`) describe the
// same shapes; a host passes these through to its UI.

import type { FilterListsDocument, UserscriptsDocument } from "@once/core"

export interface ManagedExtension {
  /** Packaged icon, available even when the extension is disabled. */
  icon: string | null
  id: string
  host: string
  name: string
  version: string
  description: string
  enabled: boolean
  running: boolean
  bundled: boolean
  source: string
  error?: string
  hasOptions: boolean
  hasPopup: boolean
  permissions: string[]
  warnings: string[]
}

export interface ExtensionPreview {
  token: string
  id: string
  /** Packaged icon, so the review card looks like the installed row it becomes. */
  icon: string | null
  name: string
  version: string
  description: string
  source: string
  permissions: string[]
  warnings: string[]
  update: boolean
}

/** The shell's synced documents the bundled extensions take. */
export interface ExtensionSettings {
  filterLists: FilterListsDocument
  userscripts: UserscriptsDocument
}

/** What a hand-off asks the shell to write back into its own documents. */
export interface AdoptedExtensionSettings {
  userscripts?: UserscriptsDocument
}

export interface SettingsStatus {
  state: "applying" | "applied" | "failed"
  error?: string
}
