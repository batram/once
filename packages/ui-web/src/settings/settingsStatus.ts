/**
 * Whether the last change to a settings section reached storage.
 *
 * Most sections save the moment a control changes, which used to happen with
 * no acknowledgement at all — the user had only the control snapping back to
 * tell them a save had failed. One line per block says it instead, and the
 * sections that still save explicitly report through the same line.
 */

export type SettingsSaveState = "saving" | "saved" | "failed"

const MESSAGES: Record<SettingsSaveState, string> = {
  saving: "Saving…",
  saved: "Saved",
  failed: "Could not save"
}

export function reportSettingsStatus(
  control: Element | null | undefined,
  state: SettingsSaveState
): void {
  const block = control?.closest<HTMLElement>(".settings_block")
  if (!block) return
  let status = block.querySelector<HTMLElement>(":scope > .settings_status")
  if (!status) {
    status = document.createElement("p")
    status.className = "settings_status"
    status.setAttribute("role", "status")
    block.append(status)
  }
  status.dataset.state = state
  status.textContent = MESSAGES[state]
}

/** Runs a save and reports both ends of it against the control that caused it. */
export async function trackSettingsSave(
  control: Element | null | undefined,
  save: () => Promise<unknown> | unknown
): Promise<void> {
  reportSettingsStatus(control, "saving")
  try {
    await save()
    reportSettingsStatus(control, "saved")
  } catch (error) {
    reportSettingsStatus(control, "failed")
    throw error
  }
}
