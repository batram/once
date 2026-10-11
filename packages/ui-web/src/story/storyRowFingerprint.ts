import type { Story } from "@once/core"

// Bookkeeping that changes on every save without changing what a row shows.
// Attachments are left out for their size as well: what the row shows of
// them is the stored_content meta, which is compared.
const UNRENDERED = new Set(["_rev", "_attachments", "sync_updated_at"])

/**
 * What a story row was drawn from, as a string to compare.
 *
 * Every finished source re-announces each story it carried, changed or not,
 * and redrawing a row replaces the element under the user's finger: the
 * touch then lands on a detached node, so a swipe stalls and a tap drops.
 * Comparing against the drawing, not the instance, matters because the
 * working set may hand back the very object the row holds, mutated in place.
 */
export function storyRowFingerprint(story: Story): string {
  return JSON.stringify(story, (key, value: unknown) =>
    UNRENDERED.has(key) ? undefined : value
  )
}
