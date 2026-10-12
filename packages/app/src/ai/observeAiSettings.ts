import { OncePlatformPorts } from "../types"
import { AI_LOCAL_KEY } from "./AiStore"

/** Only AI data and shared security changes invalidate AI views. Never publish secrets. */
export function observeAiSettings(platform: OncePlatformPorts, changed: () => void): void {
  let previous: string | undefined
  let reads = Promise.resolve()
  const read = () => {
    reads = reads.then(async () => {
      const values = await Promise.all([AI_LOCAL_KEY, "once:addon-vault"].map(key => platform.secretStore?.get(key)))
      const current = JSON.stringify(values)
      if (previous !== undefined && previous !== current) changed()
      previous = current
    }).catch(() => undefined)
  }
  read()
  platform.secretStore?.onChanged?.(read)
  platform.onDatabaseChange?.(change => { if (change.id === "addon_vault") changed() })
}
