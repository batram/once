import type { AddonEntry } from "@once/core"
import { isBundledAddon } from "../addons/bundledAddons"

/**
 * Where an installed add-on came from, in the few words of its list row:
 * what it is, not what it is not.
 */
export function addonOrigin(entry: AddonEntry): string {
  if (isBundledAddon(entry)) return "Bundled with Once"
  if (entry.source) {
    try { return `From ${new URL(entry.source.url).host}` } catch { return "From a URL" }
  }
  return "Imported copy"
}

/** The same, as the sentence that opens the add-on page's Source card: where from, and how it updates. */
export function addonOriginSentence(entry: AddonEntry): string {
  if (isBundledAddon(entry)) return "Bundled with Once. It updates when Once does."
  if (entry.source) return "Installed from this manifest URL. Check for updates fetches it again and shows what changed before installing."
  return "An imported copy, from a ZIP, a folder or a shared snapshot. To update it, import the newer version."
}

/** The last part of a folder path, for a row that has no room for the whole of it. */
export function folderName(directory: string): string {
  return directory.split(/[\\/]+/).filter(Boolean).at(-1) ?? directory
}

export interface AddonRuntimeLabel {
  text: string
  tone: "ok" | "busy" | "off" | "error"
  /** Whether Retry has anything to do: only after the script failed to start or stopped. */
  retry: boolean
}

/**
 * The sandbox's state in the reader's words. "idle" is a loaded, verified
 * script that starts with the first story that needs it: ready, not stuck.
 */
export function addonRuntimeLabel(status: { state: string; error?: string } | undefined, enabled: boolean): AddonRuntimeLabel {
  const why = status?.error ? `: ${status.error}` : ""
  if (!enabled) return { text: "Disabled", tone: "off", retry: false }
  if (!status) return { text: "Starting…", tone: "busy", retry: false }
  switch (status.state) {
    case "idle":
    case "declarative": return { text: "Ready", tone: "ok", retry: false }
    case "running": return { text: "Running", tone: "ok", retry: false }
    case "failed": return { text: `Failed${why}`, tone: "error", retry: true }
    case "unavailable": return { text: `Unavailable${why}`, tone: "error", retry: true }
    case "disabled": return { text: `Stopped${why}`, tone: "error", retry: true }
    case "disposed": return { text: "Stopped", tone: "off", retry: false }
    default: return { text: `${status.state}${why}`, tone: "busy", retry: false }
  }
}

/** Shows a runtime label on the head's status element, and Retry only when it can help. */
export function showAddonRuntime(state: HTMLElement, retry: HTMLElement | null, label: AddonRuntimeLabel): void {
  if (state.textContent !== label.text) state.textContent = label.text
  state.dataset.tone = label.tone
  if (retry) retry.hidden = !label.retry
}
