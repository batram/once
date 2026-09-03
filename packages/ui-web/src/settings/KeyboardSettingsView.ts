import { isReservedChord } from "@once/core"
import {
  availableKeyCommands,
  onKeyCommandsChanged,
  KeyCommandDefinition,
  KeyCommandGroup,
  KeyCommandId,
  keyCommand
} from "../keyboard/commands"
import { conflictingCommand } from "../keyboard/conflicts"
import { defaultKeybindings } from "../keyboard/keybindingStore"
import { chordsFor } from "../keyboard/KeyboardDispatcher"
import { getKeyboardDispatcher, getKeybindings, updateKeybindings } from "../keyboard"

// Order is the reading order of the settings section. Story actions sit last:
// it is the longest group and the one nothing is bound in by default.
const GROUP_LABELS: Record<KeyCommandGroup, string> = {
  stories: "Story list",
  browser: "Tabs and windows",
  panes: "Panes and window",
  search: "Search",
  history: "Undo",
  actions: "Story actions"
}

const MAX_CHORD_SLOTS = 2

/**
 * A shortcut the host browser owns rather than Once — the extension command
 * that opens the side panel. It is the only shortcut that works while a web
 * page has focus, so it belongs in this list even though nothing here can
 * change it; the settings page that can is offered instead.
 */
export interface BrowserManagedShortcut {
  label: string
  /** Null when the user cleared the browser's binding. */
  chord: string | null
  /** Where the browser lets the user change it, e.g. "about:addons". */
  settingsUrl: string
  /** Anything else the user needs after arriving there. */
  hint?: string
  /**
   * Opens `settingsUrl`. Supplied only where the browser permits it: Chrome
   * lets an extension open chrome://extensions/shortcuts in a tab, Firefox
   * refuses about:addons, so there the address is copyable and nothing more.
   */
  openSettings?: () => void
}

/**
 * Per-command shortcut editor.
 *
 * Chords are shown as the direct text of a real <button>, with a matching
 * aria-label and title, so settings search indexes both the command name and
 * its current chord — a bare custom control would contribute nothing.
 */
export class KeyboardSettingsView {
  private capturing: HTMLButtonElement | null = null
  private readonly status: HTMLParagraphElement
  // Every binding change re-renders the list, so which groups the user folded
  // away has to be remembered here or it springs back open on each edit.
  private readonly collapsed = new Set<KeyCommandGroup>()

  constructor(
    private readonly host: HTMLElement,
    private readonly onChanged: () => void,
    private readonly browserShortcuts: readonly BrowserManagedShortcut[] = []
  ) {
    this.status = element("p", "keybinding_status")
    this.status.setAttribute("role", "alert")
    this.render()
    onKeyCommandsChanged(() => this.render())
  }

  private render(): void {
    const bindings = getKeybindings()
    this.host.replaceChildren()

    this.host.append(this.status)
    const browserBox = this.browserManagedGroup()
    if (browserBox) this.host.append(browserBox)

    for (const group of Object.keys(GROUP_LABELS) as KeyCommandGroup[]) {
      const commands = availableKeyCommands().filter(
        (command) => command.group === group
      )
      if (commands.length === 0) continue
      this.host.append(this.group(group, commands, bindings))
    }

    const resetAll = element("button", "button keybinding_reset_all")
    resetAll.type = "button"
    resetAll.textContent = "Reset all shortcuts"
    resetAll.dataset.testid = "keybindings-reset-all"
    resetAll.addEventListener("click", () => this.commit(defaultKeybindings()))
    this.host.append(resetAll)
  }

  /**
   * The browser's own shortcuts, shown but not editable. Deliberately spans
   * and not capture buttons: nothing here can be recorded, and a control that
   * looks like the ones above would invite the user to try. The label and the
   * chord stay real text so settings search still finds them.
   */
  private browserManagedGroup(): HTMLElement | null {
    if (this.browserShortcuts.length === 0) return null
    const box = element("details", "keybinding_group settings_group")
    box.dataset.group = "browser-managed"
    box.open = true
    const title = element("summary", "keybinding_group_title settings_group_title settings_subheading")
    title.textContent = "Managed by your browser"
    box.append(title)

    const rows = element("div", "keybinding_group_rows settings_group_body")
    for (const shortcut of this.browserShortcuts) {
      const row = element("div", "keybinding_row keybinding_row--readonly")
      const label = element("span", "keybinding_label")
      label.textContent = shortcut.label
      const chord = element("span", "keybinding_managed_chord")
      chord.textContent = shortcut.chord || "Not set"
      row.append(label, chord, this.settingsPointer(shortcut))
      rows.append(row)
    }
    box.append(rows)
    return box
  }

  /**
   * How to reach the page that can change it. The address is real selectable
   * text rather than prose, since a browser settings URL cannot be a link from
   * an extension page — it is typed or pasted into the address bar. Chrome will
   * open it for us, so there it also gets a button.
   */
  private settingsPointer(shortcut: BrowserManagedShortcut): HTMLElement {
    const hint = element("span", "keybinding_managed_hint field_hint")
    const lead = document.createElement("span")
    lead.textContent = "Change it at"
    const url = element("span", "keybinding_managed_url")
    url.textContent = shortcut.settingsUrl
    // Selectable on its own, so a double-click or drag takes the address and
    // nothing around it.
    url.tabIndex = 0
    url.dataset.testid = "keybinding-managed-url"
    hint.append(lead, url)

    if (shortcut.openSettings) {
      const open = element("button", "button keybinding_managed_action")
      open.type = "button"
      open.textContent = "Open"
      open.title = `Open ${shortcut.settingsUrl}`
      open.setAttribute("aria-label", open.title)
      open.dataset.testid = "keybinding-managed-open"
      open.addEventListener("click", () => shortcut.openSettings?.())
      hint.append(open)
    }

    const copy = element("button", "button keybinding_managed_action")
    copy.type = "button"
    copy.textContent = "Copy"
    copy.title = `Copy ${shortcut.settingsUrl}`
    copy.setAttribute("aria-label", copy.title)
    copy.dataset.testid = "keybinding-managed-copy"
    copy.addEventListener("click", () => {
      navigator.clipboard.writeText(shortcut.settingsUrl).then(
        () => this.announce(`${shortcut.settingsUrl} copied.`, false),
        () => this.announce(
          `${shortcut.settingsUrl} could not be copied. Select it and copy it ` +
          "by hand.",
          true
        )
      )
    })
    hint.append(copy)

    if (shortcut.hint) {
      const rest = document.createElement("span")
      rest.textContent = shortcut.hint
      hint.append(rest)
    }
    return hint
  }

  /** One boxed, foldable group of commands. */
  private group(
    group: KeyCommandGroup,
    commands: readonly KeyCommandDefinition[],
    bindings: Map<KeyCommandId, string[]>
  ): HTMLElement {
    const box = element("details", "keybinding_group settings_group")
    box.dataset.group = group
    box.open = !this.collapsed.has(group)
    const title = element("summary", "keybinding_group_title settings_group_title settings_subheading")
    title.textContent = GROUP_LABELS[group]
    box.append(title)

    const rows = element("div", "keybinding_group_rows settings_group_body")
    for (const command of commands) {
      rows.append(this.row(command, bindings.get(command.id) ?? []))
    }
    box.append(rows)
    box.addEventListener("toggle", () => {
      if (box.open) this.collapsed.delete(group)
      else this.collapsed.add(group)
    })
    return box
  }

  private row(command: KeyCommandDefinition, chords: string[]): HTMLElement {
    const row = element("div", "keybinding_row")
    row.dataset.command = command.id
    const label = element("span", "keybinding_label")
    label.textContent = command.label
    row.append(label)

    const slots = element("span", "keybinding_slots")
    for (let index = 0; index < MAX_CHORD_SLOTS; index += 1) {
      slots.append(this.slot(command, chords[index] ?? "", index))
    }
    row.append(slots)

    const reset = element("button", "button keybinding_reset")
    reset.type = "button"
    reset.textContent = "Reset"
    reset.title = `Reset ${command.label} to its default shortcut`
    reset.setAttribute("aria-label", reset.title)
    reset.addEventListener("click", () => {
      const next = getKeybindings()
      next.set(command.id, [...command.defaultKeys])
      this.commit(next)
    })
    row.append(reset)
    return row
  }

  /**
   * One chord slot: the box carries the border, and the capture control and
   * its clear cross sit inside it. The cross keeps its space when there is
   * nothing to clear, so a "Not set" slot is exactly as wide as a bound one
   * and the columns line up down the list.
   */
  private slot(
    command: KeyCommandDefinition,
    chord: string,
    index: number
  ): HTMLElement {
    const slot = element("span", "keybinding_slot")
    const button = element("button", "keybinding_capture")
    button.type = "button"
    button.dataset.command = command.id
    button.dataset.slot = String(index)
    button.dataset.testid = `keybinding-${command.id}-${index}`
    setChordText(button, command, chord)
    button.addEventListener("click", () => this.startCapture(button, command, index))
    slot.append(button, this.clearButton(command, chord, index))
    return slot
  }

  /** Unsets one chord. Backspace during capture does the same thing. */
  private clearButton(
    command: KeyCommandDefinition,
    chord: string,
    index: number
  ): HTMLButtonElement {
    const button = element("button", "keybinding_clear")
    button.type = "button"
    button.textContent = "×"
    button.dataset.testid = `keybinding-clear-${command.id}-${index}`
    if (!chord) {
      // Present but inert, so the slot keeps its width.
      button.disabled = true
      button.setAttribute("aria-hidden", "true")
      button.tabIndex = -1
      return button
    }
    button.title = `Clear ${chord} from ${command.label}`
    button.setAttribute("aria-label", button.title)
    button.addEventListener("click", () => {
      this.setChord(command.id, index, null)
      this.announce(`${chord} cleared. ${command.label} has no shortcut.`, false)
    })
    return button
  }

  private startCapture(
    button: HTMLButtonElement,
    command: KeyCommandDefinition,
    index: number
  ): void {
    if (this.capturing) this.stopCapture()
    this.capturing = button
    button.setAttribute("aria-pressed", "true")
    button.parentElement?.classList.add("keybinding_slot--capturing")
    button.textContent = "Press a key…"
    this.announce("Escape cancels. Backspace clears the shortcut.", false)
    // The dispatcher would otherwise run whatever the user presses.
    getKeyboardDispatcher().suspend()

    const listener = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopPropagation()
      this.applyCapture(event, command, index, listener)
    }
    window.addEventListener("keydown", listener, true)
    button.dataset.listening = "true"
    this.captureListener = listener
  }

  private captureListener: ((event: KeyboardEvent) => void) | null = null

  private applyCapture(
    event: KeyboardEvent,
    command: KeyCommandDefinition,
    index: number,
    listener: (event: KeyboardEvent) => void
  ): void {
    if (event.code === "Escape") {
      this.stopCapture(listener)
      this.render()
      return
    }
    if (event.code === "Backspace" || event.code === "Delete") {
      this.stopCapture(listener)
      this.setChord(command.id, index, null)
      return
    }
    // Recorded as the keycap reads it, which is what the user will press again.
    const chord = chordsFor(event)[0]
    // Modifier-only presses are the user still reaching for the real key.
    if (!chord) return
    this.stopCapture(listener)
    if (isReservedChord(chord)) {
      this.refuse(
        `${chord} is reserved by the app and cannot be reassigned. ` +
        "Try adding Ctrl, Alt or Shift.",
        command.id
      )
      return
    }
    const clash = conflictingCommand(getKeybindings(), command.id, chord)
    if (clash) {
      this.refuse(
        `${chord} is already used by "${keyCommand(clash)?.label}". ` +
        "Clear it there first, or pick another key.",
        command.id,
        clash
      )
      return
    }
    this.setChord(command.id, index, chord)
  }

  /**
   * Says no, and shows where. The refused row and the command already holding
   * the chord both light up, so "already used by" does not send the user
   * hunting through the list for it.
   */
  private refuse(message: string, refusedId: string, holderId?: string): void {
    this.render()
    this.announce(message, true)
    for (const id of [refusedId, holderId]) {
      if (!id) continue
      const row = this.host.querySelector<HTMLElement>(
        `.keybinding_row[data-command="${CSS.escape(id)}"]`
      )
      row?.classList.add(id === refusedId ? "keybinding_refused" : "keybinding_holder")
    }
  }

  private announce(message: string, isError: boolean): void {
    this.status.textContent = message
    this.status.classList.toggle("keybinding_status--error", isError)
  }

  private stopCapture(listener = this.captureListener): void {
    if (listener) window.removeEventListener("keydown", listener, true)
    this.captureListener = null
    this.capturing?.parentElement?.classList.remove("keybinding_slot--capturing")
    this.capturing = null
    getKeyboardDispatcher().resume()
  }

  private setChord(id: KeyCommandId, index: number, chord: string | null): void {
    const bindings = getKeybindings()
    const chords = [...(bindings.get(id) ?? [])]
    if (chord === null) chords.splice(index, 1)
    else chords[index] = chord
    bindings.set(id, chords.filter(Boolean))
    this.commit(bindings)
  }

  private commit(bindings: Map<KeyCommandId, string[]>): void {
    updateKeybindings(bindings)
    this.render()
    this.onChanged()
  }
}

function setChordText(
  button: HTMLButtonElement,
  command: KeyCommandDefinition,
  chord: string
): void {
  button.textContent = chord || "Not set"
  button.title = `Shortcut for ${command.label}: ${chord || "not set"}`
  button.setAttribute("aria-label", button.title)
  button.setAttribute("aria-pressed", "false")
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  return node
}
