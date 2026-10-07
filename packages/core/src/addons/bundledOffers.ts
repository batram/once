// Version order for add-ons shipped with Once, and the record of which of
// them a synced add-ons doc has taken in (its `bundled` field).

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z.-]+))?(?:\+[\da-zA-Z.-]+)?$/

/**
 * Whether `next` is a newer semantic version than `previous`. Unknown formats
 * are never newer, so they require an explicit import instead of a guess.
 */
export function newerAddonVersion(next: string, previous: string): boolean {
  const left = SEMVER.exec(next), right = SEMVER.exec(previous)
  if (!left || !right) return false
  for (let i = 1; i <= 3; i++) {
    if (Number(left[i]) !== Number(right[i])) return Number(left[i]) > Number(right[i])
  }
  if (!left[4] || !right[4]) return !left[4] && !!right[4]
  const a = left[4].split("."), b = right[4].split(".")
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue
    if (a[i] === undefined || b[i] === undefined) return b[i] === undefined
    const an = /^\d+$/.test(a[i]), bn = /^\d+$/.test(b[i])
    if (an && bn) return Number(a[i]) > Number(b[i])
    return an !== bn ? !an : a[i] > b[i]
  }
  return false
}

/**
 * The offers of several concurrent copies of one doc, combined: every id any
 * copy took in, at the newest version any copy recorded. Two versions neither
 * of which is newer (unknown formats) settle on the larger string, so every
 * device that combines the same copies reaches the same record.
 */
export function mergeBundledOffers(offers: (Record<string, string> | undefined)[]): Record<string, string> | undefined {
  const merged: Record<string, string> = {}
  for (const offer of offers) {
    for (const [id, version] of Object.entries(offer ?? {})) {
      const current = merged[id]
      if (current === undefined || newerAddonVersion(version, current) ||
          (!newerAddonVersion(current, version) && version > current)) merged[id] = version
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined
}
