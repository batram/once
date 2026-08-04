import { isReservedChord } from "@once/core"
import {
  keyCommands,
  KeyCommandDefinition,
  KeyCommandGroup,
  KeyCommandId,
  keyCommand
} from "../keyboard/commands"
import { conflictingCommand } from "../keyboard/conflicts"
import { defaultKeybindings } from "../keyboard/keybindingStore"
import { chordsFor } from "../keyboard/KeyboardDispatcher"
import { getKeyboardDispatcher, getKeybindings, updateKeybindings } from "../keyboard"

const GROUP_LABELS: Record<KeyCommandGroup, string> = {
  stories: "Story list",
  actions: "Story actions",
  browser: "Tabs and windows",
  panes: "Panes and window",
  search: "Search",
  history: "Undo"
}

const MAX_CHORD_SLOTS = 2

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

  constructor(
    private readonly host: HTMLElement,
    private readonly onChanged: () => void
  ) {
    this.status = element("p", "keybinding_status")
    this.status.setAttribute("role", "alert")
    this.render()
  }

  private render(): void {
    const bindings = getKeybindings()
    this.host.replaceChildren()

    const heading = element("h3", "settings_panel_heading")
    heading.textContent = "Keyboard shortcuts"
    const description = element("p", "settings_description")
    description.textContent =
      "Pick a shortcut, then press the keys you want. Shortcuts are remembered " +
      "on this device. Shortcuts without a modifier only work in the sidebar."
    this.host.append(heading, description, this.status)

    for (const group of Object.keys(GROUP_LABELS) as KeyCommandGroup[]) {
      const commands = keyCommands().filter((command) => command.group === group)
      if (commands.length === 0) continue
      const groupHeading = element("h4", "keybinding_group")
      groupHeading.textContent = GROUP_LABELS[group]
      this.host.append(groupHeading)
      for (const command of commands) {
        this.host.append(this.row(command, bindings.get(command.id) ?? []))
      }
    }

    const resetAll = element("button", "button keybinding_reset_all")
    resetAll.type = "button"
    resetAll.textContent = "Reset all shortcuts"
    resetAll.dataset.testid = "keybindings-reset-all"
    resetAll.addEventListener("click", () => this.commit(defaultKeybindings()))
    this.host.append(resetAll)
  }

  private row(command: KeyCommandDefinition, chords: string[]): HTMLElement {
    const row = element("div", "keybinding_row")
    row.dataset.command = command.id
    const label = element("span", "keybinding_label")
    label.textContent = command.label
    row.append(label)

    const slots = element("span", "keybinding_slots")
    for (let index = 0; index < MAX_CHORD_SLOTS; index += 1) {
      const chord = chords[index] ?? ""
      slots.append(this.slot(command, chord, index))
      if (chord) slots.append(this.clearButton(command, chord, index))
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

  private slot(
    command: KeyCommandDefinition,
    chord: string,
    index: number
  ): HTMLButtonElement {
    const button = element("button", "keybinding_capture")
    button.type = "button"
    button.dataset.command = command.id
    button.dataset.slot = String(index)
    button.dataset.testid = `keybinding-${command.id}-${index}`
    setChordText(button, command, chord)
    button.addEventListener("click", () => this.startCapture(button, command, index))
    return button
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
    button.title = `Clear ${chord} from ${command.label}`
    button.setAttribute("aria-label", button.title)
    button.dataset.testid = `keybinding-clear-${command.id}-${index}`
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
