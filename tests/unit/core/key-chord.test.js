const test = require("node:test")
const assert = require("node:assert/strict")

const {
  RESERVED_CHORDS,
  chordFromKey,
  chordFromParts,
  isModifiedChord,
  isValidChord,
  parseChord
} = require("../../../packages/core/dist/keyboard/keyChord")

test("letters and digits lose their code prefix", () => {
  assert.equal(chordFromParts({ code: "KeyF", ctrl: true }), "Ctrl+F")
  assert.equal(chordFromParts({ code: "Digit1", alt: true }), "Alt+1")
  assert.equal(chordFromParts({ code: "KeyW" }), "W")
})

test("modifiers always serialize in Ctrl, Alt, Shift, Meta order", () => {
  const parts = { code: "KeyT", meta: true, shift: true, alt: true, ctrl: true }
  assert.equal(chordFromParts(parts), "Ctrl+Alt+Shift+Meta+T")
  assert.equal(
    chordFromParts({ code: "KeyT", shift: true, ctrl: true }),
    "Ctrl+Shift+T"
  )
})

test("chordFromParts reads the physical position", () => {
  assert.equal(chordFromParts({ code: "KeyZ", ctrl: true }), "Ctrl+Z")
  // Shift+2 is " on some layouts and @ on others; by position it stays 2.
  assert.equal(chordFromParts({ code: "Digit2", shift: true }), "Shift+2")
})

test("chordFromKey reads the keycap, which is what a mnemonic follows", () => {
  // A German keyboard puts Z where a US one has Y. Ctrl+Z must stay undo on
  // the Z-labelled key, so the produced character decides, not the position.
  assert.equal(
    chordFromKey({ code: "KeyY", key: "z", ctrl: true }),
    "Ctrl+Z"
  )
  assert.equal(
    chordFromKey({ code: "KeyZ", key: "y", ctrl: true }),
    "Ctrl+Y"
  )
  // Case and named keys normalize the same way as the positional form.
  assert.equal(chordFromKey({ code: "KeyF", key: "F", ctrl: true }), "Ctrl+F")
  assert.equal(chordFromKey({ code: "Space", key: " " }), "Space")
  assert.equal(chordFromKey({ code: "ArrowUp", key: "ArrowUp" }), "ArrowUp")
  assert.equal(chordFromKey({ code: "F11", key: "F11" }), "F11")
})

test("chordFromKey ignores dead keys, modifiers and punctuation", () => {
  assert.equal(chordFromKey({ code: "KeyA", key: "Dead" }), null)
  assert.equal(chordFromKey({ code: "ShiftLeft", key: "Shift", shift: true }), null)
  assert.equal(chordFromKey({ code: "Unidentified", key: "Unidentified" }), null)
  // Punctuation varies far too much between layouts to key a binding on.
  assert.equal(chordFromKey({ code: "Digit2", key: "\"", shift: true }), null)
})

test("modifier-only presses and unknown codes produce no chord", () => {
  assert.equal(chordFromParts({ code: "ShiftLeft", shift: true }), null)
  assert.equal(chordFromParts({ code: "ControlRight", ctrl: true }), null)
  assert.equal(chordFromParts({ code: "" }), null)
  assert.equal(chordFromParts({ code: "Unidentified" }), null)
})

test("named keys and function keys survive unchanged", () => {
  for (const code of ["ArrowDown", "ArrowLeft", "Tab", "Escape", "Enter", "F11"]) {
    assert.equal(chordFromParts({ code }), code)
  }
  assert.equal(chordFromParts({ code: "ArrowLeft", ctrl: true }), "Ctrl+ArrowLeft")
})

test("chords round-trip through parseChord", () => {
  for (const chord of ["Ctrl+F", "Ctrl+Shift+T", "ArrowUp", "W", "F11", "Ctrl+ArrowLeft"]) {
    const parts = parseChord(chord)
    assert.notEqual(parts, null, chord)
    assert.equal(chordFromParts(parts), chord)
  }
})

test("non-canonical spellings are rejected rather than silently accepted", () => {
  // Wrong modifier order, unknown modifier, lowercase key, and duplicates would
  // otherwise create a second map key for the same physical shortcut.
  for (const chord of ["Shift+Ctrl+T", "Super+T", "ctrl+f", "Ctrl+Ctrl+T", "Ctrl+", "", "+"]) {
    assert.equal(parseChord(chord), null, chord)
    assert.equal(isValidChord(chord), false, chord)
  }
  assert.equal(parseChord(`Ctrl+${"A".repeat(64)}`), null)
})

test("only modified chords and function keys may be stolen from a web page", () => {
  assert.equal(isModifiedChord("Ctrl+T"), true)
  assert.equal(isModifiedChord("Alt+ArrowLeft"), true)
  assert.equal(isModifiedChord("F11"), true)
  // A bare letter or arrow would swallow ordinary typing and scrolling.
  assert.equal(isModifiedChord("S"), false)
  assert.equal(isModifiedChord("ArrowDown"), false)
  assert.equal(isModifiedChord("Shift+S"), false)
  assert.equal(isModifiedChord("nonsense"), false)
})

test("every reserved chord is itself a valid chord", () => {
  for (const chord of RESERVED_CHORDS) {
    assert.equal(isValidChord(chord), true, chord)
  }
})
