const test = require("node:test")
const assert = require("node:assert/strict")

const {
  KEYBINDINGS_STORAGE_KEY,
  customizedCommandCount,
  defaultKeybindings,
  loadKeybindings,
  mergeKeybindings,
  saveKeybindings
} = require("../../../packages/ui-web/dist/keyboard/keybindingStore")
const {
  KEY_COMMANDS
} = require("../../../packages/ui-web/dist/keyboard/commands")
const {
  findKeybindingConflicts,
  conflictingCommand,
  contextsOverlap
} = require("../../../packages/ui-web/dist/keyboard/conflicts")

function fakeStorage(initial) {
  const data = new Map(Object.entries(initial || {}))
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key)
  }
}

test("the shipped defaults do not conflict with each other", () => {
  assert.deepEqual(findKeybindingConflicts(defaultKeybindings()), [])
})

test("every command has at least one default chord", () => {
  for (const command of KEY_COMMANDS) {
    assert.ok(command.defaultKeys.length > 0, command.id)
  }
})

test("stored overrides merge over the defaults", () => {
  const merged = mergeKeybindings({
    version: 1,
    bindings: { "story.cursor-next": ["J"] }
  })
  assert.deepEqual(merged.get("story.cursor-next"), ["J"])
  // Untouched commands must keep their defaults, so new ones reach existing
  // installs instead of arriving unbound.
  assert.deepEqual(merged.get("story.cursor-prev"), ["ArrowUp", "W"])
})

test("untrusted stored data is dropped rather than trusted", () => {
  const merged = mergeKeybindings({
    version: 1,
    bindings: {
      "story.cursor-next": ["J", "J", 7, "ctrl+f", "Shift+Ctrl+T", "Ctrl+S"],
      "no.such.command": ["K"],
      "story.open": "not-an-array"
    }
  })
  // Duplicates, non-strings, non-canonical spellings and reserved chords go.
  assert.deepEqual(merged.get("story.cursor-next"), ["J"])
  assert.equal(merged.has("no.such.command"), false)
  assert.deepEqual(merged.get("story.open"), ["O"])
})

test("a wrong or missing schema version falls back to defaults", () => {
  for (const stored of [null, "text", {}, { version: 2, bindings: { "story.open": ["K"] } }]) {
    assert.deepEqual(mergeKeybindings(stored), defaultKeybindings())
  }
})

test("only overrides are written, and clearing them removes the key", () => {
  const storage = fakeStorage()
  const bindings = defaultKeybindings()
  bindings.set("story.cursor-next", ["J"])
  saveKeybindings(bindings, storage)
  assert.deepEqual(
    JSON.parse(storage.getItem(KEYBINDINGS_STORAGE_KEY)),
    { version: 1, bindings: { "story.cursor-next": ["J"] } }
  )

  saveKeybindings(defaultKeybindings(), storage)
  assert.equal(storage.getItem(KEYBINDINGS_STORAGE_KEY), null)
})

test("saved bindings survive a reload", () => {
  const storage = fakeStorage()
  const bindings = defaultKeybindings()
  bindings.set("story.action-right", ["Ctrl+Alt+D"])
  saveKeybindings(bindings, storage)
  assert.deepEqual(loadKeybindings(storage).get("story.action-right"), ["Ctrl+Alt+D"])
})

test("unreadable or corrupt storage still yields a usable shell", () => {
  assert.deepEqual(loadKeybindings(fakeStorage()), defaultKeybindings())
  assert.deepEqual(
    loadKeybindings(fakeStorage({ [KEYBINDINGS_STORAGE_KEY]: "{not json" })),
    defaultKeybindings()
  )
  const hostile = {
    getItem: () => { throw new Error("denied") },
    setItem: () => { throw new Error("denied") },
    removeItem: () => { throw new Error("denied") }
  }
  assert.deepEqual(loadKeybindings(hostile), defaultKeybindings())
  assert.doesNotThrow(() => saveKeybindings(defaultKeybindings(), hostile))
})

test("the customised count drives the settings summary", () => {
  const bindings = defaultKeybindings()
  assert.equal(customizedCommandCount(bindings), 0)
  bindings.set("story.open", ["K"])
  bindings.set("story.cursor-next", [])
  assert.equal(customizedCommandCount(bindings), 2)
})

test("contexts overlap only where both commands can fire at once", () => {
  assert.equal(contextsOverlap("global", "stories"), true)
  assert.equal(contextsOverlap("stories", "stories"), true)
  // The story list and the content pane never have focus simultaneously, so
  // they may reuse a chord.
  assert.equal(contextsOverlap("stories", "browser"), false)
})

test("a chord already used by an overlapping command is reported", () => {
  const bindings = defaultKeybindings()
  assert.equal(conflictingCommand(bindings, "story.open", "Ctrl+F"), "search.focus")
  assert.equal(conflictingCommand(bindings, "story.open", "Ctrl+Alt+K"), null)
  // browser.close-tab is browser-context, story.open is stories-context.
  assert.equal(conflictingCommand(bindings, "story.open", "Ctrl+W"), null)

  bindings.set("story.open", ["ArrowDown"])
  const conflicts = findKeybindingConflicts(bindings)
  assert.equal(conflicts.length, 1)
  assert.deepEqual(conflicts[0], {
    chord: "ArrowDown",
    commandId: "story.open",
    conflictsWith: "story.cursor-next"
  })
})
