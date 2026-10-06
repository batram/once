import { isTabSyncChangeId, TAB_SYNC_SETTINGS_ID } from "@once/core"
import type { AppSettings, SyncStartOrigin } from "../AppSettings"
import { errorDetails } from "../DiagnosticLog"
import type { DatabaseChange, DiagnosticError, OnceClient, OncePlatformPorts, SyncStatus } from "../types"
import { DeviceIdentity } from "./DeviceIdentity"
import { SyncDestinationBinding } from "./SyncDestinationBinding"
import { SyncGate } from "./SyncGate"
import { TabDocRepository } from "./TabDocRepository"
import { TabSyncService } from "./TabSyncService"
import { restorePlan } from "./TabStates"

type SyncClientMethods = Pick<OnceClient,
  "getSyncConsent" | "requestSyncConsent" | "getTabSync" | "setTabSyncOptions" | "setTabSyncShared" |
  "renameDevice" | "forgetDevice" | "resetDeviceIdentity" | "openRemoteTab" | "getTabThumbnail" |
  "sendTab" | "sendLocalTab" | "openSentTab" | "dismissSentTab">

export interface SyncControlsHost {
  status(): SyncStatus
  setStatus(status: SyncStatus): void
  tabSyncChanged(): void
  reportDiagnostic(error: DiagnosticError): void
  renameVaultDevice(name: string): Promise<void>
}

/**
 * The runtime's sync concerns beyond replication itself: the gate every
 * connection passes, and tab sync with its routing and client methods.
 */
export class SyncControls {
  private readonly gate: SyncGate
  private readonly tabSync?: TabSyncService
  private blocked = false

  constructor(private readonly platform: OncePlatformPorts, private readonly host: SyncControlsHost) {
    this.gate = new SyncGate(
      new SyncDestinationBinding(platform.secretStore, platform.syncUrlProvenance ?? "device"),
      platform.syncConsent,
      async () => await platform.syncService?.hasLocalData?.() ?? false
    )
    this.tabSync = this.createTabSync()
  }

  authorize(url: string, origin: SyncStartOrigin): Promise<string | null> {
    return this.gate.check(url, origin)
  }

  /** Shows why sync is not running; tab sync stops publishing while it does not. */
  reportBlocked(message: string | null): void {
    this.blocked = message !== null
    this.tabSync?.syncStateChanged()
    if (message !== null) this.host.setStatus({ state: "error", message })
  }

  /** Replication reported a new status. */
  statusChanged(status: SyncStatus): void {
    const wasActive = this.active(this.host.status())
    this.host.setStatus(status)
    if (wasActive !== this.active(status)) this.tabSync?.syncStateChanged()
  }

  /** Routes a local or pulled document change; true when it was a tab sync document. */
  routeChange(change: DatabaseChange): boolean {
    if (isTabSyncChangeId(change.id)) {
      this.tabSync?.handleChange(change)
      return true
    }
    if (change.id === TAB_SYNC_SETTINGS_ID) this.tabSync?.handleChange(change)
    return false
  }

  /** After the first connection attempt: watch what may start, stop or redirect sync. */
  start(settings: AppSettings): void {
    this.platform.syncService?.onRemoteTabChange?.((change) => this.tabSync?.handleChange(change))
    this.platform.secretStore?.onChanged?.(() => this.tabSync?.optionsChangedElsewhere())
    // A URL replaced from elsewhere, or consent granted or withdrawn, goes
    // through the same gate as a startup: never straight to the transport.
    this.platform.syncSettingsStore.onSyncUrlChanged?.(() => void settings.restartSync("external"))
    this.platform.syncConsent?.onChanged(() => void settings.restartSync("external"))
    void this.tabSync?.start().catch((error) => this.host.reportDiagnostic({
      severity: "error", operation: "tabsync.start", message: "Tab sync could not start", details: errorDetails(error)
    }))
  }

  clientMethods(): SyncClientMethods {
    const consent = this.platform.syncConsent
    const methods: SyncClientMethods = {
      getSyncConsent: async () => consent ? await consent.granted() ? "granted" : "required" : "not-needed",
      // Called straight from a click: the browser only shows its prompt for a user gesture.
      requestSyncConsent: () => consent?.request() ?? Promise.resolve(true),
      getTabSync: async () => this.tabSync ? this.tabSync.view() : null,
      setTabSyncOptions: (change) => this.require().setOptions(change),
      setTabSyncShared: (change) => this.require().setShared(change),
      renameDevice: async (name) => {
        await this.require().rename(name)
        await this.host.renameVaultDevice(name)
      },
      forgetDevice: (deviceId) => this.require().forget(deviceId),
      getTabThumbnail: async (id) => this.tabSync ? this.tabSync.thumbnail(id) : null,
      sendTab: (deviceId, tab) => this.require().send(deviceId, tab),
      sendLocalTab: (deviceId, tabId) => this.require().sendLocal(deviceId, tabId),
      openSentTab: async (id, background) => {
        const sent = await this.require().takeSent(id)
        if (sent) methods.openRemoteTab(sent.url, sent.mode, background, sent.state)
      },
      dismissSentTab: async (id) => { await this.require().takeSent(id) },
      openRemoteTab: (url, mode, background, state) => {
        if (!/^https?:\/\//i.test(url)) return
        // Where it was left: a start time in the URL, or a script for the opened page.
        const plan = restorePlan(url, mode, state)
        if (this.platform.tabOpener) {
          this.platform.tabOpener.open(plan.url, { background, mode, restore: plan.restore, readerPosition: plan.readerPosition })
        } else this.platform.activeTab?.openUrl(plan.url, background ? "middle" : "_self")
      },
      resetDeviceIdentity: () => this.require().resetIdentity()
    }
    return methods
  }

  private createTabSync(): TabSyncService | undefined {
    const { tabDocs, device, secretStore } = this.platform
    if (!tabDocs || !device || !secretStore) return undefined
    return new TabSyncService({
      identity: new DeviceIdentity(secretStore, device.platform, device.defaultName),
      repository: new TabDocRepository(tabDocs),
      listStore: this.platform.listStore,
      source: this.platform.tabSource,
      sharesElsewhere: device.sharesElsewhere,
      appVersion: device.appVersion,
      timing: device.tabSyncTiming,
      syncActive: () => this.active(this.host.status()),
      changed: () => this.host.tabSyncChanged(),
      reportError: (operation, error) => this.host.reportDiagnostic({
        severity: "error", operation, message: "Tab sync failed", details: errorDetails(error)
      })
    })
  }

  private require(): TabSyncService {
    if (!this.tabSync) throw new Error("Tab sync is not available on this client")
    return this.tabSync
  }

  /** Configured, allowed, and not given up on: tab sync publishes only then. */
  private active(status: SyncStatus): boolean {
    return !this.blocked && status.state !== "disabled"
  }
}
