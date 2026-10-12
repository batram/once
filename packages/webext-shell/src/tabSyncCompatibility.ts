import { PouchSyncCompatibility, couchHttpTabDocs } from "@once/persistence"
import type { SecretStorePort } from "@once/app"

/** Background tab publication bypasses Pouch replication, so every HTTP operation checks too. */
export function tabSyncCompatibility(url: string, secrets: SecretStorePort, allowed: () => Promise<boolean>): () => Promise<void> {
  const metadata = couchHttpTabDocs(url, fetch.bind(globalThis), allowed)
  const gate = new PouchSyncCompatibility({
    get: async id => {
      if (!id.startsWith("_local/")) throw { status: 404 }
      const saved = await secrets.get(`once:background-sync:${id}`)
      if (!saved) throw { status: 404 }
      return JSON.parse(saved) as Record<string, unknown>
    },
    put: async doc => { await secrets.set(`once:background-sync:${doc._id}`, JSON.stringify(doc)); return {} }
  })
  const remote = {
    get: async (id: string, options?: Record<string, unknown>) => {
      const doc = await metadata.get(id, options)
      if (!doc) throw { status: 404 }
      return doc
    },
    put: (doc: Record<string, unknown>) => metadata.put(doc)
  }
  let initialized = false
  return async () => { await gate.check(remote, url, 1, () => true, !initialized); initialized = true }
}
