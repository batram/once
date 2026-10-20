// Serialized into the Android uBlock background by adapt-gecko-ublock.js.
// Use one consistent managed-settings snapshot for the startup sequence. The
// original API already uses a persisted snapshot and refreshes it for the next
// restart; calling it for every subset repeats that read/refresh/write cycle.
function batchStartupAdminStorage(storage) {
  const original = storage.get
  let pending
  storage.get = async function(key) {
    pending ??= Promise.resolve().then(() => original.call(storage, null))
    const bin = structuredClone(await pending)
    if (bin === undefined || bin === null || key === undefined || key === null) return bin
    if (typeof key === "string") return bin[key]
    const out = {}
    if (Array.isArray(key)) {
      for (const name of key) if (bin[name] !== undefined) out[name] = bin[name]
    } else {
      for (const [name, fallback] of Object.entries(key)) out[name] = bin[name] !== undefined ? bin[name] : fallback
    }
    return out
  }
  return () => { storage.get = original }
}

module.exports = { batchStartupAdminStorage }

// Prefetch only the three static snapshots. Version changes can invalidate
// redirect resources separately, so those stay on their ordinary load path.
function prefetchStartupSelfie(io, isInvalid) {
  const pending = new Map()
  let generation = 0
  return {
    get generation() { return generation },
    prepare() {
      if (isInvalid()) return
      for (const key of ["selfie/staticMain", "selfie/staticExtFilteringEngine", "selfie/staticNetFilteringEngine"]) {
        if (pending.has(key)) continue
        // Convert a speculative rejection to a normal cache miss immediately,
        // even if invalidation means no consumer will ever await this read.
        pending.set(key, { generation, value: io.fromCache(key).catch(() => undefined) })
      }
    },
    async read(key) {
      const entry = pending.get(key)
      if (!entry) return io.fromCache(key)
      pending.delete(key)
      const value = await entry.value
      if (entry.generation !== generation || isInvalid()) return undefined
      return value
    },
    invalidate() { generation++; pending.clear() }
  }
}

module.exports.prefetchStartupSelfie = prefetchStartupSelfie
