import { OncePlatformPorts } from "../types"
import { AiStore } from "./AiStore"
import { withLock } from "../tabsync/locks"

/** Removal may happen while the independently enabled AI dataset is locked. */
export function removedConsumers(platform: OncePlatformPorts, store: AiStore, local: () => Set<string>) {
  const key = "once:ai-removed-consumers"
  return (ids: string[] = []) => withLock(key, async () => {
    const saved = await platform.secretStore?.get(key)
    const pending = new Set<string>(saved ? JSON.parse(saved) : [])
    for (const id of ids) pending.add(id)
    if (!pending.size) return
    await platform.secretStore?.set(key, JSON.stringify([...pending]))
    if (await store.vault.participates("ai") && (await store.vault.status()).state !== "ready") return
    await store.update(data => {
      data.settings.overrides = Object.fromEntries(Object.entries(data.settings.overrides).filter(([id]) => !pending.has(id) || local().has(id)))
    })
    await platform.secretStore?.set(key, "")
  })
}
