/**
 * A sentence on one settings page may name another section; the word, marked
 * `data-open-settings-section`, opens it. With `data-open-settings-row` it
 * also brings that row into view, focuses its control and lights the row for
 * a moment, so the reader lands on the setting the sentence meant.
 */
export function bindSettingsSectionLinks(panel: HTMLElement, open: (key: string) => void): void {
  panel.addEventListener("click", (event) => {
    const link = (event.target as Element | null)?.closest<HTMLElement>("[data-open-settings-section]")
    const key = link?.dataset.openSettingsSection
    if (!link || !key) return
    open(key)
    const row = link.dataset.openSettingsRow
    // Opening a section queues its default focus for the next frame; the row comes after that.
    if (row) requestAnimationFrame(() => requestAnimationFrame(() => spotlightSettingsRow(row)))
  })
}

const SPOTLIGHT = "settings_row_spotlight"

export function spotlightSettingsRow(id: string): void {
  const control = document.getElementById(id)
  const row = control?.closest<HTMLElement>(".settings_row") ?? control
  if (!control || !row) return
  row.scrollIntoView({ block: "center" })
  if (control instanceof HTMLElement) control.focus({ preventScroll: true })
  row.classList.remove(SPOTLIGHT)
  // A second jump restarts the glow: the class is re-applied after the style resets.
  void row.offsetWidth
  row.classList.add(SPOTLIGHT)
  row.addEventListener("animationend", () => row.classList.remove(SPOTLIGHT), { once: true })
}
