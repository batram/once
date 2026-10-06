import type { SyncConsentPort } from "@once/app"

/**
 * The data categories sync sends to the user's server, as Firefox's built-in
 * consent names them. All three are needed: replication is unfiltered, so the
 * database can carry any of them regardless of this device's own toggles.
 */
export const SYNC_DATA_COLLECTION = ["browsingActivity", "websiteContent", "websiteActivity"] as const

type DataCollectionPermissions = { data_collection?: string[] }
interface PermissionsApi {
  getAll(): Promise<DataCollectionPermissions>
  request(permissions: DataCollectionPermissions): Promise<boolean>
  onAdded: { addListener(listener: () => void): void; removeListener(listener: () => void): void }
  onRemoved: { addListener(listener: () => void): void; removeListener(listener: () => void): void }
}

/**
 * Firefox's consent to send data to the sync server. On a Firefox without
 * the data collection permissions API it is never granted: sync stays off,
 * since there is no way to ask, and the settings say to update Firefox.
 */
export function createFirefoxSyncConsent(browserApi: typeof browser = browser): SyncConsentPort {
  const permissions = browserApi.permissions as unknown as PermissionsApi
  const granted = async () => {
    try {
      const current = (await permissions.getAll()).data_collection
      return Array.isArray(current) && SYNC_DATA_COLLECTION.every((category) => current.includes(category))
    } catch {
      return false
    }
  }
  return {
    granted,
    async supported() {
      try {
        return Array.isArray((await permissions.getAll()).data_collection)
      } catch {
        return false
      }
    },
    // No await before the request: Firefox shows the prompt only while the click is being handled.
    request: () => permissions.request({ data_collection: [...SYNC_DATA_COLLECTION] }).catch(() => false),
    onChanged(handler) {
      const listener = () => handler()
      permissions.onAdded.addListener(listener)
      permissions.onRemoved.addListener(listener)
      return () => {
        permissions.onAdded.removeListener(listener)
        permissions.onRemoved.removeListener(listener)
      }
    }
  }
}
