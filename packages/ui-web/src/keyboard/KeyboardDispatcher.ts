import { chordFromKey, chordFromParts } from "@once/core"
import {
  availableKeyCommands,
  KeyCommandContext,
  KeyCommandId,
  TextEntryReach,
  keyCommand
} from "./commands"

type CommandHandler = () => void
type Blocker = () => boolean

/**
 * The single keyboard entry point for the shell UI. One capture-phase listener
 * on `window` resolves a chord to a command and runs its handler; feature
 * modules register handlers instead of adding listeners of their own.
 *
 * Capture is required so shortcuts beat element-level handlers, which also
 * means the dispatcher runs *before* the document-level capture handlers used
 * by the anchored story menu and the source picker. Those overlays register a
 * blocker so the dispatcher stands down while they own the keyboard.
 */
export class KeyboardDispatcher {
  private readonly handlers = new Map<KeyCommandId, CommandHandler>()
  private readonly blockers = new Set<Blocker>()
  private bindings = new Map<string, KeyCommandId[]>()
  private listener: ((event: KeyboardEvent) => void) | null = null
  private suspended = false

  constructor(bindings?: Map<string, KeyCommandId[]>) {
    this.setBindings(bindings ?? defaultBindings())
  }

  mount(target: Window = window): void {
    if (this.listener) return
    this.listener = (event) => this.handleKeydown(event)
    target.addEventListener("keydown", this.listener, true)
  }

  unmount(target: Window = window): void {
    if (!this.listener) return
    target.removeEventListener("keydown", this.listener, true)
    this.listener = null
  }

  register(id: KeyCommandId, handler: CommandHandler): () => void {
    this.handlers.set(id, handler)
    return () => {
      if (this.handlers.get(id) === handler) this.handlers.delete(id)
    }
  }

  registerBlocker(blocker: Blocker): () => void {
    this.blockers.add(blocker)
    return () => this.blockers.delete(blocker)
  }

  /** Stops the dispatcher while the settings key-capture control is recording. */
  suspend(): void {
    this.suspended = true
  }

  resume(): void {
    this.suspended = false
  }

  setBindings(bindings: Map<string, KeyCommandId[]>): void {
    this.bindings = bindings
  }

  /** Runs a command directly, bypassing chord lookup and the context rules. */
  run(id: KeyCommandId): boolean {
    const handler = this.handlers.get(id)
    if (!handler) return false
    handler()
    return true
  }

  /** Chords worth forwarding from a focused web page in the Electron shell. */
  boundChords(): string[] {
    return [...this.bindings.keys()]
  }

  /**
   * Runs the command bound to a chord that did not arrive as a DOM event —
   * the Electron main process forwards keys pressed while a browser tab has
   * focus. Returns whether a handler ran.
   */
  dispatchChord(chord: string, contexts = this.activeContexts()): boolean {
    if (this.suspended || this.isBlocked()) return false
    const id = this.resolve(chord, contexts, null)
    if (!id) return false
    const handler = this.handlers.get(id)
    if (!handler) return false
    handler()
    return true
  }

  private handleKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || this.suspended || this.isBlocked()) return
    const contexts = this.activeContexts()
    const entry = textEntryKind(event.target)
    let id: KeyCommandId | null = null
    for (const chord of chordsFor(event)) {
      id = this.resolve(chord, contexts, entry)
      if (id) break
    }
    if (!id) return
    const handler = this.handlers.get(id)
    // An unhandled command still appears in settings, but must not swallow the
    // key: leave it to whatever would have received it.
    if (!handler) return
    event.preventDefault()
    event.stopPropagation()
    handler()
  }

  private resolve(
    chord: string,
    contexts: KeyCommandContext[],
    entry: TextEntryKind
  ): KeyCommandId | null {
    const candidates = this.bindings.get(chord)
    if (!candidates) return null
    for (const context of contexts) {
      for (const id of candidates) {
        const command = keyCommand(id)
        if (!command || command.context !== context) continue
        if (!reaches(command.allowInTextEntry, entry)) continue
        return id
      }
    }
    return null
  }

  private isBlocked(): boolean {
    for (const blocker of this.blockers) {
      if (blocker()) return true
    }
    return false
  }

  /** Most specific context first; "global" always last so it is the fallback. */
  private activeContexts(): KeyCommandContext[] {
    const contexts: KeyCommandContext[] = []
    const active = document.activeElement
    if (active && active.closest("#right_panel")) contexts.push("browser")
    const panel = document.querySelector("#left_panel")
    if (panel?.getAttribute("active_panel") === "stories") contexts.push("stories")
    contexts.push("global")
    return contexts
  }
}

/**
 * The chords one key press could mean, best first: what the keycap says, then
 * where the key sits. Ctrl+Z must follow the Z key on a German layout, while
 * WASD must stay a cluster on a French one.
 */
export function chordsFor(event: KeyboardEvent): string[] {
  const parts = {
    code: event.code,
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    meta: event.metaKey
  }
  const byKey = chordFromKey({ ...parts, key: event.key })
  const byCode = chordFromParts(parts)
  if (byKey && byCode && byKey !== byCode) return [byKey, byCode]
  return [byKey ?? byCode].filter((chord): chord is string => Boolean(chord))
}

const TEXT_INPUT_TYPES = new Set([
  "text", "search", "url", "email", "password", "tel", "number", "date", "time"
])

/**
 * How much of the keyboard a target is already claiming.
 * - `editor`: multi-line or gestural editing, where arrow keys do real work.
 *   Sliders count, because the swipe lab and the structured settings editors
 *   drive ARIA sliders with the arrows.
 * - `field`: a single-line input; losing a modified arrow chord here is a small
 *   price for being able to leave the field with the keyboard.
 */
export type TextEntryKind = null | "field" | "editor"

export function textEntryKind(target: EventTarget | null): TextEntryKind {
  // Duck-typed rather than `instanceof Element`: this runs in the Electron and
  // extension renderers, and under linkedom in the unit tests, where the global
  // Element constructor is not the one that built the node.
  const element = target as Element | null
  if (!element || typeof element.tagName !== "string") return null
  if (element.getAttribute("role") === "slider") return "editor"
  if (element.closest("[contenteditable='']") || element.closest("[contenteditable='true']")) {
    return "editor"
  }
  const name = element.tagName
  if (name === "TEXTAREA") return "editor"
  if (name === "SELECT") return "field"
  if (name !== "INPUT") return null
  return TEXT_INPUT_TYPES.has((element as HTMLInputElement).type) ? "field" : null
}

function reaches(allowed: TextEntryReach, entry: TextEntryKind): boolean {
  if (entry === null || allowed === "always") return true
  return allowed === "field" && entry === "field"
}

export function defaultBindings(): Map<string, KeyCommandId[]> {
  return bindingsFrom(new Map(availableKeyCommands().map((command) => [
    command.id,
    [...command.defaultKeys]
  ])))
}

/**
 * Inverts an id → chords map into the chord → ids map the dispatcher reads.
 * Commands this shell cannot run are skipped, so their chords stay free.
 */
export function bindingsFrom(byCommand: Map<KeyCommandId, string[]>): Map<string, KeyCommandId[]> {
  const bindings = new Map<string, KeyCommandId[]>()
  for (const command of availableKeyCommands()) {
    for (const chord of byCommand.get(command.id) ?? []) {
      const existing = bindings.get(chord)
      if (existing) existing.push(command.id)
      else bindings.set(chord, [command.id])
    }
  }
  return bindings
}
