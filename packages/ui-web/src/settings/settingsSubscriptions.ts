import { bindSyncCompatibilityControls } from "./syncCompatibilityControls"
import { bindSyncSettingReviewControls } from "./syncSettingReviewControls"
import { OnceClient, SourceError } from "@once/app"
import { requireElement } from "../dom"

export interface SettingsSubscriptionActions {
  filters(): void
  redirects(): void
  sources(): void
  theme(): void
  animation(): void
  cache(): void
  sync(): void
  swipe(): void
  extensions(): void
  addons(): void
  ai?(): void
  /** Stored-content settings restore themselves; see SettingsPersistence. */
  content?(): void
  sourceErrors(errors: SourceError[]): void
  summaries(): void
}

export function bindSettingsSubscriptions(
  client: OnceClient,
  actions: SettingsSubscriptionActions
): void {
  client.subscribe("settingsChanged", ({ section }) => {
    const action = actions[section]
    if (typeof action === "function") action()
  })
  client.subscribe("sourceErrorsChanged", ({ errors }) => {
    actions.sourceErrors(errors)
  })
  const compatibility = bindSyncCompatibilityControls(client)
  const settingReview = bindSyncSettingReviewControls(client)
  const setSyncStatus = (status: ReturnType<OnceClient["getSyncStatus"]>) => {
    const element = requireElement<HTMLElement>("#couch_status")
    compatibility(status)
    settingReview(status)
    element.dataset.state = status.state
    element.textContent = status.message
    actions.summaries()
  }
  client.subscribe("syncStatusChanged", setSyncStatus)
  setSyncStatus(client.getSyncStatus())
}
