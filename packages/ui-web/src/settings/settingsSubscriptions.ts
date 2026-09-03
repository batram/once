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
  const setSyncStatus = (status: ReturnType<OnceClient["getSyncStatus"]>) => {
    const element = requireElement<HTMLElement>("#couch_status")
    element.dataset.state = status.state
    element.textContent = status.message
    actions.summaries()
  }
  client.subscribe("syncStatusChanged", setSyncStatus)
  setSyncStatus(client.getSyncStatus())
}
