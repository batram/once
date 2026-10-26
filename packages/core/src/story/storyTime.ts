/** Zero is an unknown source publication time, never a device-clock estimate. */
export function storyTimestamp(value: string | number | Date): number {
  if (value instanceof Date) return value.getTime()
  if (typeof value === "number") return value
  // ISO source dates without a zone must not depend on the device's timezone.
  return Date.parse(/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?$/.test(value) ? `${value}Z` : value)
}

/** Publication time, then persisted first observation; never invent an age on load. */
export function storyDisplayTime(story: { timestamp: string | number | Date; ingested_at?: unknown }): number {
  const timestamp = storyTimestamp(story.timestamp)
  if (Number.isFinite(timestamp) && timestamp > 0) return timestamp
  return typeof story.ingested_at === "number" && Number.isFinite(story.ingested_at) && story.ingested_at > 0 ? story.ingested_at : 0
}
