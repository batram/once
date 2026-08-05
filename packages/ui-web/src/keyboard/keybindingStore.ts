import { isReservedChord, isValidChord } from "@once/core"
import { KeyCommandId, availableKeyCommands, isKeyCommandId } from "./commands"

// Keybindings are device-local: keyboards and layouts differ per machine, so
// they are deliberately not part of the synced settings document.
export const KEYBINDINGS_STORAGE_KEY = "once-keybindings"
const SCHEMA_VERSION = 1
const MAX_CHORDS_PER_COMMAND = 4

/** Only overrides are stored, so new defaults reach existing installs. */
interface StoredKeybindings {
  version: number
  bindings: Record<string, string[]>
}

// Only what this shell can run: a command it cannot perform must not hold a
// chord, or it would block the user from binding that chord to something the
// shell does offer. See availableKeyCommands().
export function defaultKeybindings(): Map<KeyCommandId, string[]> {
  return new Map(availableKeyCommands().map(
    (command) => [command.id, [...command.defaultKeys]]
  ))
}

/**
 * Merges stored overrides over the defaults. Everything read back is treated as
 * untrusted: unknown ids, malformed chords, reserved chords, duplicates, and
 * non-array values are dropped rather than allowed to break the dispatcher.
 * Ids this shell cannot run are dropped too — they are absent from the defaults
 * the overrides are merged onto, so re-adding them would smuggle a chord back.
 */
export function mergeKeybindings(stored: unknown): Map<KeyCommandId, string[]> {
  const bindings = defaultKeybindings()
  const overrides = readOverrides(stored)
  if (!overrides) return bindings
  for (const [id, chords] of Object.entries(overrides)) {
    if (!isKeyCommandId(id) || !Array.isArray(chords)) continue
    if (!bindings.has(id)) continue
    const cleaned: string[] = []
    for (const chord of chords) {
      if (typeof chord !== "string") continue
      if (!isValidChord(chord) || isReservedChord(chord)) continue
      if (!cleaned.includes(chord)) cleaned.push(chord)
      if (cleaned.length === MAX_CHORDS_PER_COMMAND) break
    }
    bindings.set(id, cleaned)
  }
  return bindings
}

function readOverrides(stored: unknown): Record<string, unknown> | null {
  if (!stored || typeof stored !== "object") return null
  const record = stored as Partial<StoredKeybindings>
  if (record.version !== SCHEMA_VERSION) return null
  if (!record.bindings || typeof record.bindings !== "object") return null
  return record.bindings as Record<string, unknown>
}

export function loadKeybindings(storage = deviceStorage()): Map<KeyCommandId, string[]> {
  let raw: string | null = null
  try {
    raw = storage?.getItem(KEYBINDINGS_STORAGE_KEY) ?? null
  } catch {
    // Private-mode storage denials must not stop the shell from starting.
    return defaultKeybindings()
  }
  if (!raw) return defaultKeybindings()
  try {
    return mergeKeybindings(JSON.parse(raw))
  } catch {
    return defaultKeybindings()
  }
}

export function saveKeybindings(
  bindings: Map<KeyCommandId, string[]>,
  storage = deviceStorage()
): void {
  if (!storage) return
  const overrides: Record<string, string[]> = {}
  for (const command of availableKeyCommands()) {
    const chords = bindings.get(command.id) ?? []
    if (sameChords(chords, command.defaultKeys)) continue
    overrides[command.id] = [...chords]
  }
  try {
    if (Object.keys(overrides).length === 0) {
      storage.removeItem(KEYBINDINGS_STORAGE_KEY)
      return
    }
    const payload: StoredKeybindings = { version: SCHEMA_VERSION, bindings: overrides }
    storage.setItem(KEYBINDINGS_STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // Nothing useful to do if the quota is full; the session keeps its bindings.
  }
}

export function customizedCommandCount(bindings: Map<KeyCommandId, string[]>): number {
  let count = 0
  for (const command of availableKeyCommands()) {
    if (!sameChords(bindings.get(command.id) ?? [], command.defaultKeys)) count += 1
  }
  return count
}

// Absent in the unit tests and in any host without DOM storage; bindings then
// stay at their defaults for the session rather than throwing on startup.
function deviceStorage(): Storage | null {
  return typeof localStorage === "undefined" ? null : localStorage
}

function sameChords(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((chord, index) => chord === b[index])
}
