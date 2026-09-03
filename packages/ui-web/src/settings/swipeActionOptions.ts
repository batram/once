import {
  isSwipeActionAvailable,
  listSwipeActions,
  swipeActionLabel,
  SwipeActionId
} from "@once/app"

/**
 * Fills a swipe-stage `<select>` with the current choices: the built-ins plus
 * whatever add-ons registered, which changes while the panel is open. A value
 * naming an add-on missing on this device keeps a disabled option, so the
 * setting stays visible and survives a save. Rebuilds only when the set moved.
 */
export function syncSwipeActionOptions(select: HTMLSelectElement, current: SwipeActionId): void {
  const wanted = listSwipeActions()
  if (!wanted.some((action) => action.id === current)) {
    wanted.push({ id: current, label: swipeActionLabel(current) })
  }
  const existing = [...select.options].map((option) => option.value)
  if (existing.length === wanted.length && existing.every((id, index) => id === wanted[index].id)) return
  select.textContent = ""
  for (const { id, label } of wanted) {
    const option = document.createElement("option")
    option.value = id
    option.textContent = label
    option.disabled = !isSwipeActionAvailable(id)
    select.append(option)
  }
}
