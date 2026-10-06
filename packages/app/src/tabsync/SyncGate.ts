import { SEPARATE_PROFILE_MESSAGE } from "@once/core"
import type { SyncStartOrigin } from "../AppSettings"
import type { SyncConsentPort } from "../types"
import { SyncDestinationBinding } from "./SyncDestinationBinding"

export const CONSENT_REQUIRED_MESSAGE =
  "Sync is paused until you allow sending data to your sync server (Settings › Sync)"
export const CONSENT_UNSUPPORTED_MESSAGE =
  "Sync needs a newer browser that can ask for data sharing consent; update it to sync"
export const CONFIRM_DESTINATION_MESSAGE =
  "This sync URL may come from another installation of the browser. Press Save in Settings › Sync to confirm this database"

/**
 * The checks every connection passes before any request leaves the device:
 * the profile's database binding, then the user's consent to send data where
 * the browser asks for it. Returns why a connection may not start, or null.
 */
export class SyncGate {
  constructor(
    private readonly binding: SyncDestinationBinding,
    private readonly consent: SyncConsentPort | undefined,
    private readonly hasLocalData: () => Promise<boolean>
  ) {}

  async check(url: string, origin: SyncStartOrigin): Promise<string | null> {
    if (this.consent && !await this.consent.granted()) {
      return await this.consent.supported?.() === false ? CONSENT_UNSUPPORTED_MESSAGE : CONSENT_REQUIRED_MESSAGE
    }
    const previouslyConfigured = origin !== "user" && await this.hasLocalData()
    const decision = await this.binding.authorize(url, { userChosen: origin === "user", previouslyConfigured })
    switch (decision.kind) {
      case "different": return SEPARATE_PROFILE_MESSAGE
      case "unknown-provenance": return CONFIRM_DESTINATION_MESSAGE
      default:
        // Consent may have been withdrawn while the binding was checked.
        if (this.consent && !await this.consent.granted()) return CONSENT_REQUIRED_MESSAGE
        return null
    }
  }
}
