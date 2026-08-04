import { KeyboardDispatcher, bindingsFrom } from "./KeyboardDispatcher"
import { KeyCommandId } from "./commands"
import { loadKeybindings, saveKeybindings } from "./keybindingStore"

let dispatcher: KeyboardDispatcher | null = null
let bindings: Map<KeyCommandId, string[]> | null = null

/**
 * The shell's one dispatcher. Created on first use so feature modules can
 * register handlers without caring whether mountOnceUi has run yet.
 */
export function getKeyboardDispatcher(): KeyboardDispatcher {
  if (!dispatcher) {
    bindings = loadKeybindings()
    dispatcher = new KeyboardDispatcher(bindingsFrom(bindings))
  }
  return dispatcher
}

export function getKeybindings(): Map<KeyCommandId, string[]> {
  getKeyboardDispatcher()
  return new Map(bindings as Map<KeyCommandId, string[]>)
}

/** Persists a new binding map and pushes it into the live dispatcher. */
export function updateKeybindings(next: Map<KeyCommandId, string[]>): void {
  const target = getKeyboardDispatcher()
  bindings = new Map(next)
  saveKeybindings(bindings)
  target.setBindings(bindingsFrom(bindings))
}
