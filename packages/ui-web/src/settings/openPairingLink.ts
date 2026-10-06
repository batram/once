import { openSyncSettings } from "../tabsync/tabsPanel"
import { SettingsPanel } from "./SettingsPanel"

/** A pairing link that reached the app from outside (a scanned code opening it): asks, then connects. */
export function openPairingLink(link: string): void {
  openSyncSettings()
  SettingsPanel.instance?.connectPairingLink(link)
}
