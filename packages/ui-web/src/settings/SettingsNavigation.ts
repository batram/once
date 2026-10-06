import { open_panel } from "../shell/panelNavigation"

export interface SettingsPanelOptions {
  /** Last rung of the header Back chain, used by mobile to exit Settings. */
  exitSettings?: () => void
  /** Scans a pairing code with the camera; resolves with its link, or null when cancelled. */
  scanPairingCode?: () => Promise<string | null>
}

interface SettingsNavigationHost {
  section(): string | null
  show(section: string | null): void
  back: HTMLButtonElement
  backEditor(): boolean
  showIndex(): void
  exitSettings(): void
  forwardEditor(): boolean
  clearForwardEditors(): void
}

/** Settings visits have their own history; story read-state history is separate. */
export class SettingsNavigation {
  private backHistory: Array<string | null> = []
  private forwardHistory: Array<string | null> = []
  private replaying = false
  private returnPanel = "stories"
  private forwardToSettings = false
  private restoringSettings = false

  constructor(private host: SettingsNavigationHost) {
    host.back.onclick = () => {
      if (host.backEditor()) return
      if (host.section()) {
        host.show(null)
        return
      }
      // On the index the chevron leaves Settings outright. Without this the
      // shared Back step would replay earlier section visits first.
      this.backHistory = []
      host.exitSettings()
    }
    document.addEventListener("once-settings-index-requested", () => host.showIndex())
    document.addEventListener("once-settings-navigate", event => this.mouse(event))
    document.addEventListener("once-panel-changed", event => {
      const { panel, previous } = (event as CustomEvent<{ panel: string; previous: string | null }>).detail
      if (panel === previous) return
      this.forwardToSettings = false
      if (panel !== "settings" || this.restoringSettings) return
      this.returnPanel = previous || "stories"
      this.backHistory = this.host.section() === null ? [] : [null]
      this.forwardHistory = []
      this.host.clearForwardEditors()
    })
  }

  record(next: string | null): void {
    if (this.replaying || next === this.host.section()) return
    this.backHistory.push(this.host.section())
    this.forwardHistory = []
    this.host.clearForwardEditors()
  }

  navigate(direction: "back" | "forward"): void {
    if (direction === "forward" && this.host.forwardEditor()) return
    if (document.querySelector("#settings_panel.settings_form_open, " +
      "#settings_panel .settings_section.active .structured_row_editing, " +
      "#settings_panel .settings_section.active .structured_form")) return
    const from = direction === "back" ? this.backHistory : this.forwardHistory
    const to = direction === "back" ? this.forwardHistory : this.backHistory
    if (!from.length) {
      if (direction === "back") {
        open_panel(this.returnPanel)
        this.forwardToSettings = true
      }
      return
    }
    const next = from.pop()
    if (next === undefined) return
    to.push(this.host.section())
    this.replaying = true
    try { this.host.show(next) } finally { this.replaying = false }
  }

  private mouse(event: Event): void {
    const direction = (event as CustomEvent<{ direction: string }>).detail.direction
    if (direction !== "back" && direction !== "forward") return
    const active = document.querySelector("#left_panel")?.getAttribute("active_panel")
    if (active !== "settings") {
      if (direction !== "forward" || !this.forwardToSettings) return
      event.preventDefault()
      this.restoringSettings = true
      try { open_panel("settings") } finally { this.restoringSettings = false }
      return
    }
    event.preventDefault()
    // Share the header's nested-editor handling, including add-on subpages.
    // Not by clicking the chevron: the mobile shell sends this event from
    // the chevron's own handler (exitSettings), and a click nested inside a
    // click on the same button is dropped by the browser.
    if (direction === "back" && this.host.backEditor()) return
    this.navigate(direction)
  }
}
