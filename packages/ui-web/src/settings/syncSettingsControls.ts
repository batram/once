import { requireClosestElement, requireElement } from "../dom"

export function bindSyncSettingsControls(
  reset: () => Promise<void>,
  save: () => void
): void {
  const input = requireElement<HTMLInputElement>("#couch_input")
  const container = input.parentElement
  if (!container) {
    throw new Error(
      "Settings are unavailable because the sync URL container is missing"
    )
  }
  const highlights = requireElement<HTMLElement>(
    ".couch-highlights",
    container
  )
  const toggle = requireElement<HTMLButtonElement>("#couch_toggle", container)
  // Scoped to the block rather than walked up from the input: the field around
  // the input is presentation, and presentation must not decide what this can
  // still find.
  const block = requireClosestElement<HTMLElement>(input, ".settings_block")

  const render = () => {
    const value = input.value
    if (!value) {
      highlights.textContent = ""
      return
    }
    toggle.textContent = container.classList.contains("masked") ? "👁️" : "🙈"
    try {
      const url = new URL(value)
      if (!url.password || !container.classList.contains("masked")) {
        highlights.textContent = value
        return
      }
      const authEnd = value.lastIndexOf("@")
      const passStart = value.lastIndexOf(":", authEnd)
      if (passStart === -1 || passStart >= authEnd) {
        highlights.textContent = value
        return
      }
      highlights.textContent =
        value.substring(0, passStart + 1) +
        "•".repeat(url.password.length) +
        value.substring(authEnd)
    } catch {
      highlights.textContent = value
    }
  }
  const toggleMask = () => {
    container.classList.toggle("masked")
    render()
  }
  highlights.classList.add("settings_highlights--interactive")
  highlights.addEventListener("click", toggleMask)
  toggle.addEventListener("click", (event) => {
    event.preventDefault()
    toggleMask()
  })
  input.addEventListener("input", render)
  void reset().then(render)
  requireElement<HTMLButtonElement>('button[data-action="save"]', block)
    .addEventListener("click", save)
  requireElement<HTMLButtonElement>('button[data-action="cancel"]', block)
    .addEventListener("click", () => void reset().then(render))
}
