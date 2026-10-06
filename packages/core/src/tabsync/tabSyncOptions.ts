import { normalizeExcludedDomains } from "./tabFilter"

/**
 * Tab sync choices that belong to one device and never travel: whether it
 * takes part at all, whether it shares its tabs, what it shows, and how long
 * things count as recent.
 */
export interface TabSyncOptions {
  /** The master switch: off, the device neither publishes, receives nor shows anything of tab sync. */
  enabled: boolean
  /** The first-run offer to turn tab sync on was answered, either way. */
  offerAnswered: boolean
  sharing: boolean
  screenshots: boolean
  excludedDomains: string[]
  sendTarget: boolean
  continueBanner: boolean
  activityWindowMinutes: number
  freshnessWindowMinutes: number
  staleDeviceDays: number
}

export const ACTIVITY_WINDOW_CHOICES = [5, 15, 30, 60] as const
export const FRESHNESS_WINDOW_CHOICES = [10, 30, 60, 120] as const
export const STALE_DEVICE_CHOICES = [7, 30, 90, 365] as const
export const SEND_RETENTION_CHOICES = [1, 7, 14, 30, 90] as const

export const DEFAULT_TAB_SYNC_OPTIONS: Readonly<TabSyncOptions> = Object.freeze({
  enabled: false,
  offerAnswered: false,
  sharing: false,
  screenshots: true,
  excludedDomains: [],
  sendTarget: true,
  continueBanner: true,
  activityWindowMinutes: 15,
  freshnessWindowMinutes: 30,
  staleDeviceDays: 30
})

const choice = <T extends number>(value: unknown, choices: readonly T[], fallback: T): T =>
  choices.includes(value as T) ? value as T : fallback
const flag = (value: unknown, fallback: boolean): boolean => typeof value === "boolean" ? value : fallback

export function readTabSyncOptions(value: unknown): TabSyncOptions {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {}
  const defaults = DEFAULT_TAB_SYNC_OPTIONS
  // A device that already shared before the master switch existed stays on.
  const enabled = flag(record.enabled, record.sharing === true)
  return {
    enabled,
    offerAnswered: flag(record.offerAnswered, enabled),
    sharing: flag(record.sharing, defaults.sharing),
    screenshots: flag(record.screenshots, defaults.screenshots),
    excludedDomains: normalizeExcludedDomains(record.excludedDomains),
    sendTarget: flag(record.sendTarget, defaults.sendTarget),
    continueBanner: flag(record.continueBanner, defaults.continueBanner),
    activityWindowMinutes: choice(record.activityWindowMinutes, ACTIVITY_WINDOW_CHOICES, 15),
    freshnessWindowMinutes: choice(record.freshnessWindowMinutes, FRESHNESS_WINDOW_CHOICES, 30),
    staleDeviceDays: choice(record.staleDeviceDays, STALE_DEVICE_CHOICES, 30)
  }
}

/**
 * What the options mean for behaviour: with the master switch off nothing is
 * shared, received or offered, whatever the individual choices remember.
 */
export function effectiveTabSyncOptions(options: TabSyncOptions): TabSyncOptions {
  return options.enabled ? options : { ...options, sharing: false, sendTarget: false, continueBanner: false }
}

/**
 * The tab sync setting every device must agree on, kept in the synced
 * settings record: any device may delete expired sends, so a per-device
 * value would effectively mean the shortest one.
 */
export interface TabSyncSharedSettings { sendRetentionDays: number }

export const TAB_SYNC_SETTINGS_ID = "tabsync"
export const DEFAULT_TAB_SYNC_SHARED_SETTINGS: Readonly<TabSyncSharedSettings> = Object.freeze({ sendRetentionDays: 14 })

export function readTabSyncSharedSettings(value: unknown): TabSyncSharedSettings {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {}
  return { sendRetentionDays: choice(record.sendRetentionDays, SEND_RETENTION_CHOICES, 14) }
}
