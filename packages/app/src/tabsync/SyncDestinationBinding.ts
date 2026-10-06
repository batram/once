import { classifySyncDestination, SyncDestinationDecision } from "@once/core"
import type { SecretStorePort } from "../types"
import { withLock } from "./locks"

const BINDING_KEY = "once:sync-destination"
const VAULT_DESTINATION_KEY = "once:addon-vault-destination"

/**
 * Where a sync URL may come from. "device" URLs are typed on this device and
 * kept only here, so the URL saved before an upgrade is the database this
 * profile's data came from. "browser" URLs arrive through the browser's own
 * settings sync from other installations and prove nothing about the past.
 */
export type SyncUrlProvenance = "device" | "browser"

/**
 * Pins a profile to the database it first connected to. Replication is
 * unfiltered, so connecting the same local database to a second remote would
 * copy everything from the first — other devices' tabs and screenshots
 * included — into the second. Every transport start passes `authorize` first.
 */
export class SyncDestinationBinding {
  constructor(
    private readonly secrets: SecretStorePort | undefined,
    private readonly provenance: SyncUrlProvenance
  ) {}

  /** The bound destination, migrating the add-on vault's older binding first. */
  async bound(): Promise<string> {
    if (!this.secrets) return ""
    const saved = await this.secrets.get(BINDING_KEY)
    if (saved) return saved
    return this.secrets.get(VAULT_DESTINATION_KEY)
  }

  /**
   * Whether `url` may be used now. A first connection persists the binding
   * before returning, so no request can reach a database the profile is not
   * bound to. `userChosen` is true when the user entered or confirmed `url`
   * in this context; `previouslyConfigured` when it is the URL saved before
   * this profile had a binding.
   */
  authorize(url: string, options: { userChosen: boolean; previouslyConfigured: boolean }): Promise<SyncDestinationDecision> {
    return withLock("once-sync-destination", async () => {
      const bound = await this.bound()
      // A saved URL from before bindings existed is trustworthy only when it
      // cannot have been replaced from elsewhere since.
      const needsProvenance = !bound && options.previouslyConfigured && !options.userChosen && this.provenance === "browser"
      let decision: SyncDestinationDecision
      try {
        decision = classifySyncDestination(url, bound, needsProvenance)
      } catch {
        return { kind: "disabled" } as const
      }
      // Without device-local storage there is nothing to bind with; such a
      // client keeps the unbound behavior rather than refusing to sync.
      if (this.secrets && (decision.kind === "initial" ||
          (decision.kind === "same" && !(await this.secrets.get(BINDING_KEY))))) {
        await this.secrets.set(BINDING_KEY, decision.destination)
      }
      return decision
    })
  }
}
