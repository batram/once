import { AddonCondition, pageMatchesCondition, readAddonCondition } from "@once/core"

export interface PageActionMenuItem {
  id: string
  label: string
  when?: AddonCondition
  /** The reader shows this add-on's page conversations in the Once panel. */
  place?: "panel"
}

export function readPageActionMenuItems(value: unknown): PageActionMenuItem[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    if (typeof item?.id !== "string" || typeof item.label !== "string") return []
    try {
      const when = readAddonCondition(item.when)
      return [{ id: item.id, label: item.label, ...(when ? { when } : {}), ...(item.place === "panel" ? { place: "panel" as const } : {}) }]
    } catch { return [] }
  })
}

/** Native URL filters also work before a content script has reported its target. */
export function pageActionMenuPatterns(when?: AddonCondition): string[] {
  if (!pageMatchesCondition({ ...when, domain: undefined, notDomain: undefined, scheme: undefined }, "https://example.test/")) return []
  const schemes = ["http", "https"].filter(scheme => !when?.scheme || when.scheme.some(value => value.toLowerCase() === scheme))
  const domains = (when?.domain ?? ["*"]).map(domain => domain.toLowerCase())
    .filter(domain => domain === "*" || /^(\*\.)?[a-z0-9.-]+$/.test(domain))
  return schemes.flatMap(scheme => domains.map(domain => `${scheme}://${domain}/*`))
}
