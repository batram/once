// A chord is the serialized form of a keyboard shortcut, e.g. "Ctrl+Shift+T"
// or "ArrowDown". Modifiers always appear in the order Ctrl, Alt, Shift, Meta
// so a chord has exactly one spelling and can be used as a map key.
//
// A chord can be read off a key press two ways, and both are needed:
//
// - By the character the key produces (KeyboardEvent.key). Shortcuts are
//   mnemonic — Z for undo, F for find — so they must follow the keycap. On a
//   German layout the Z-labelled key sits where a US layout has Y, and reading
//   position alone turns Ctrl+Z into redo.
// - By physical position (KeyboardEvent.code). WASD is a shape under the left
//   hand, not four letters, so it must stay put on AZERTY and friends.
//
// The dispatcher tries the produced character first and falls back to position,
// which resolves both correctly. This module is shared by the web renderers and
// the Electron main process, which sees Electron.Input rather than a
// KeyboardEvent, so it deliberately takes plain parts instead of an event.

export interface KeyChordParts {
  code: string
  ctrl?: boolean
  alt?: boolean
  shift?: boolean
  meta?: boolean
}

const MODIFIER_CODES = new Set([
  "ControlLeft", "ControlRight",
  "AltLeft", "AltRight",
  "ShiftLeft", "ShiftRight",
  "MetaLeft", "MetaRight"
])

const NAMED_CODES = new Set([
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Home", "End", "PageUp", "PageDown",
  "Enter", "NumpadEnter", "Space", "Tab", "Escape", "Backspace", "Delete", "Insert",
  "Backquote", "Minus", "Equal", "BracketLeft", "BracketRight", "Backslash",
  "Semicolon", "Quote", "Comma", "Period", "Slash"
])

// Chords a user may not assign, because text editing, the settings editors, or
// the OS would break. Note "Tab" is reserved but "Ctrl+Tab" is not: the bare key
// drives focus traversal, the chord does not.
export const RESERVED_CHORDS: readonly string[] = Object.freeze([
  "Tab", "Enter", "Space", "Backspace", "Delete",
  "Ctrl+S", "Ctrl+C", "Ctrl+V", "Ctrl+X", "Ctrl+A",
  "Ctrl+Q", "F5", "Ctrl+R", "Ctrl+Shift+I", "Alt+F4"
])

export function isReservedChord(chord: string): boolean {
  return RESERVED_CHORDS.includes(chord)
}

// "KeyF" -> "F", "Digit1" -> "1", "F11"/"ArrowUp" -> unchanged.
function normalizeCode(code: string): string | null {
  if (!code || MODIFIER_CODES.has(code)) return null
  if (code.startsWith("Key") && code.length === 4) return code.slice(3)
  if (code.startsWith("Digit") && code.length === 6) return code.slice(5)
  if (code.startsWith("Numpad") && code.length > 6) return code
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code
  if (NAMED_CODES.has(code)) return code
  return null
}

export function chordFromParts(parts: KeyChordParts): string | null {
  return withModifiers(parts, normalizeCode(parts.code))
}

/**
 * The chord as the keycap reads it, from the character the key produced.
 * `key` is the KeyboardEvent.key / Electron.Input.key value.
 */
export function chordFromKey(parts: KeyChordParts & { key: string }): string | null {
  return withModifiers(parts, normalizeKey(parts.key))
}

function withModifiers(parts: KeyChordParts, key: string | null): string | null {
  if (!key) return null
  let chord = ""
  if (parts.ctrl) chord += "Ctrl+"
  if (parts.alt) chord += "Alt+"
  if (parts.shift) chord += "Shift+"
  if (parts.meta) chord += "Meta+"
  return chord + key
}

// "z" -> "Z", " " -> "Space", "ArrowUp"/"F11" unchanged. Anything longer than a
// single character that is not a key we name is a dead key or an IME artefact.
function normalizeKey(key: string): string | null {
  if (!key) return null
  if (key === " ") return "Space"
  if (key.length === 1) {
    const upper = key.toUpperCase()
    return /^[A-Z0-9]$/.test(upper) ? upper : null
  }
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) return key
  return NAMED_CODES.has(key) ? key : null
}

export function parseChord(chord: string): KeyChordParts | null {
  if (typeof chord !== "string" || chord.length === 0 || chord.length > 40) return null
  const segments = chord.split("+")
  const key = segments.pop() as string
  const parts: KeyChordParts = { code: "" }
  for (const segment of segments) {
    if (segment === "Ctrl" && !parts.ctrl) parts.ctrl = true
    else if (segment === "Alt" && !parts.alt) parts.alt = true
    else if (segment === "Shift" && !parts.shift) parts.shift = true
    else if (segment === "Meta" && !parts.meta) parts.meta = true
    else return null
  }
  // Round-tripping proves both the key and the modifier order are canonical.
  const code = /^[A-Z]$/.test(key)
    ? `Key${key}`
    : /^[0-9]$/.test(key)
      ? `Digit${key}`
      : key
  parts.code = code
  return chordFromParts(parts) === chord ? parts : null
}

export function isValidChord(chord: string): boolean {
  return parseChord(chord) !== null
}

// A chord safe to steal from a focused web page. Bare letters would swallow
// ordinary typing, so only modified chords and function keys qualify.
export function isModifiedChord(chord: string): boolean {
  const parts = parseChord(chord)
  if (!parts) return false
  if (parts.ctrl || parts.alt || parts.meta) return true
  return /^F([1-9]|1[0-9]|2[0-4])$/.test(chord)
}
