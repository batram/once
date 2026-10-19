import type { OnceClient, SyncStatus } from "@once/app"
import type { SyncSettingReview } from "@once/core"
import { showConfirmDialog } from "../confirmDialog"

function settingValues(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((entry, index) => settingValues(entry, `${path} ${index + 1}`))
  if (value && typeof value === "object") return Object.entries(value).flatMap(([key, entry]) =>
    settingValues(entry, key === "list" ? path : `${path ? path + " · " : ""}${key.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ")}`))
  const text = typeof value === "boolean" ? value ? "Yes" : "No" : value == null ? "Not set" : String(value)
  return [`${path ? path.charAt(0).toUpperCase() + path.slice(1) + ": " : ""}${text}`]
}

/** Review requires an explicit selection; status updates never choose or write a version. */
export function bindSyncSettingReviewControls(client: OnceClient): (status: SyncStatus) => void {
  const root = document.querySelector<HTMLElement>("#sync_settings")
  if (!root) return () => undefined
  const panel = document.createElement("section"); panel.className = "settings_rows"; panel.hidden = true
  panel.dataset.testid = "sync-setting-review"; panel.setAttribute("aria-label", "Review conflicting settings")
  const title = document.createElement("h3"); title.textContent = "Choose which setting to keep"
  const hint = document.createElement("p")
  hint.textContent = "This device has different saved versions. Review them before sync continues. Your original versions will be backed up on this device."
  const message = document.createElement("p"); message.setAttribute("role", "status")
  const choices = document.createElement("div")
  const actions = document.createElement("div"); actions.className = "settings_actions cluster"
  const review = document.createElement("button"); review.type = "button"; review.className = "button"; review.textContent = "Review versions"
  const save = document.createElement("button"); save.type = "button"; save.className = "button"; save.textContent = "Use selected version and resume sync"; save.disabled = true
  const all = document.createElement("fieldset"); all.hidden = true
  const legend = document.createElement("legend"); legend.textContent = "Do for all remaining settings conflicts"
  const synced = document.createElement("button"); synced.type = "button"; synced.className = "button"; synced.textContent = "Use synced for all"
  const local = document.createElement("button"); local.type = "button"; local.className = "button"; local.textContent = "Use current local for all"
  all.append(legend, synced, local)
  actions.append(review, save); panel.append(title, hint, message, choices, actions, all); root.prepend(panel)
  let id: string | undefined, snapshot: SyncSettingReview | undefined, selected = "", busy = false, revision = 0
  const showError = (error: unknown) => { message.textContent = error instanceof Error ? error.message : "Could not review this setting. Try again." }
  review.onclick = async () => {
    if (!id || busy) return
    busy = true; review.disabled = true; save.disabled = true
    const current = ++revision
    choices.replaceChildren(); all.hidden = true; snapshot = undefined; selected = ""; message.textContent = "Loading saved versions…"
    try {
      const result = await client.reviewSyncSetting(id)
      if (current !== revision) return
      snapshot = result; title.textContent = result.label
      all.hidden = false; synced.disabled = !result.choices.some(entry => entry.key === "remote"); local.disabled = false
      message.textContent = "Select the version you want to use. Other devices will receive it after sync resumes."
      for (const choice of result.choices) {
        const label = document.createElement("label"); label.className = "settings_row"
        const radio = document.createElement("input"); radio.type = "radio"; radio.name = "sync-setting-version"; radio.value = choice.key
        const name = document.createElement("strong"); name.textContent = choice.label; name.className = "settings_row_name"
        radio.onchange = () => { selected = choice.key; save.disabled = busy }
        const values = document.createElement("ul"); values.className = "settings_row_hint"
        for (const line of settingValues(choice.value)) { const item = document.createElement("li"); item.textContent = line; values.append(item) }
        label.append(name, values, radio); choices.append(label)
      }
    } catch (error) { if (current === revision) showError(error) }
    finally { busy = false; review.disabled = false }
  }
  const apply = async (applyToAll?: "synced" | "local") => {
    if (!snapshot || !selected && !applyToAll || busy) return
    const reviewed = snapshot, choice = applyToAll === "synced" ? "remote" : applyToAll === "local" ? snapshot.currentLocalRevision : selected, current = revision
    const label = reviewed.choices.find(entry => entry.key === choice)?.label
    busy = true; review.disabled = true; save.disabled = true; synced.disabled = true; local.disabled = true
    try {
      const confirmed = await showConfirmDialog({ message: applyToAll
        ? `Use ${applyToAll === "synced" ? "the synced version" : "this device’s current local version"} for this and all remaining settings conflicts in this migration? Original versions will be backed up on this device. This will not become a rule for future syncs.`
        : `Use “${label}” for ${reviewed.label.toLowerCase()}? A backup of the original versions will stay on this device.`, confirmLabel: applyToAll ? "Apply to all settings conflicts" : "Use this version" })
      if (!confirmed || current !== revision) return
      await client.resolveSyncSetting({ id: reviewed.id, localRevisions: reviewed.localRevisions, remoteRevision: reviewed.remoteRevision, choice, ...(applyToAll ? { applyToAll } : {}) })
      if (current === revision) message.textContent = "Choice saved. Sync is resuming…"
    } catch (error) {
      if (current === revision) { showError(error); snapshot = undefined; selected = ""; choices.replaceChildren(); all.hidden = true }
    } finally {
      busy = false; review.disabled = false; save.disabled = !snapshot || !selected
      synced.disabled = !snapshot?.choices.some(entry => entry.key === "remote"); local.disabled = !snapshot
    }
  }
  save.onclick = () => apply(); synced.onclick = () => apply("synced"); local.onclick = () => apply("local")
  return status => {
    const next = status.settingReview?.documentId
    if (next !== id) { revision++; snapshot = undefined; selected = ""; choices.replaceChildren(); save.disabled = true; all.hidden = true }
    id = next; panel.hidden = !next
    if (next && !snapshot) message.textContent = status.message
  }
}
