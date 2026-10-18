/** Zero is an unknown source publication time, never a device-clock estimate. */
export function storyTimestamp(value: string | number | Date): number {
  if (value instanceof Date) return value.getTime()
  if (typeof value === "number") return value
  // ISO source dates without a zone must not depend on the device's timezone.
  return Date.parse(/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?$/.test(value) ? `${value}Z` : value)
}

const observed = new WeakMap<object, number>()

/** A session-local display fallback. It never enters a replicated record. */
export function storyDisplayTime(story: { timestamp: string | number | Date }): number {
  const timestamp = storyTimestamp(story.timestamp)
  if (timestamp) return timestamp
  let time = observed.get(story)
  if (time === undefined) { time = Date.now(); observed.set(story, time) }
  return time
}
