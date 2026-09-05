import { AddonEntry } from "@once/core"

export interface AddonRegistration {
  updateOptions(entry: AddonEntry): void
  dispose(): void
}

export interface AddonCandidate {
  entry: AddonEntry
  code?: string | null
}

/** One registration per identity; storage never participates in runtime identity. */
export class AddonReconciler {
  private readonly active = new Map<string, {
    definition: string
    options: string
    collectors: boolean
    registration: AddonRegistration
  }>()
  private queue: Promise<void> = Promise.resolve()
  private revision = 0

  constructor(
    private readonly create: (candidate: AddonCandidate) => Promise<AddonRegistration>,
    private readonly changed: (collectors: boolean) => void
  ) {}

  apply(candidates: AddonCandidate[]): Promise<void> {
    const revision = ++this.revision
    const work = this.queue.then(async () => {
      if (revision !== this.revision) return
      let changed = false
      let collectors = false
      const desired = new Map(candidates.filter(({ entry }) => entry.enabled).map((c) => [c.entry.manifest.id, c]))
      for (const [id, current] of this.active) {
        const next = desired.get(id)
        if (next && current.definition === JSON.stringify([next.entry.manifest, next.code ?? null])) continue
        current.registration.dispose()
        this.active.delete(id)
        changed = true
        collectors ||= current.collectors
      }
      try {
        for (const [id, candidate] of desired) {
          if (revision !== this.revision) break
          const options = JSON.stringify(candidate.entry.options ?? {})
          const current = this.active.get(id)
          if (current) {
            if (current.options !== options) {
              current.registration.updateOptions(candidate.entry)
              current.options = options
              changed = true
              collectors ||= current.collectors
            }
            continue
          }
          const registration = await this.create(candidate)
          if (revision !== this.revision) { registration.dispose(); break }
          const hasCollectors = candidate.entry.manifest.collectors.length > 0
          this.active.set(id, {
            definition: JSON.stringify([candidate.entry.manifest, candidate.code ?? null]),
            options, collectors: hasCollectors, registration
          })
          changed = true
          collectors ||= hasCollectors
        }
      } finally {
        if (changed) this.changed(collectors)
      }
    })
    this.queue = work.catch(() => undefined)
    return work
  }

  retry(id: string): Promise<void> {
    const work = this.queue.then(() => {
      const current = this.active.get(id)
      current?.registration.dispose()
      this.active.delete(id)
    })
    this.queue = work.catch(() => undefined)
    return work
  }
}
