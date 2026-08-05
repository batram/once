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
  availableKeyCommands,
  keyCommand,
  keyCommands,
  registerKeyCommand,
  setShell
} = require("../../../packages/ui-web/dist/keyboard/commands")
// Registers the story actions as a side effect of import, which is how a
// plugin will add its own.
require("../../../packages/ui-web/dist/keyboard/storyActionCommands")
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

test("built-in commands ship bound; registered actions start unbound", () => {
  const builtins = keyCommands().filter((command) => !command.id.startsWith("story-action."))
  for (const command of builtins) {
    assert.ok(command.defaultKeys.length > 0, command.id)
  }
  // Story actions exist so a user can bind what they use, without the app
  // guessing at a dozen more default chords.
  const actions = keyCommands().filter((command) => command.id.startsWith("story-action."))
  assert.ok(actions.length > 0)
  for (const command of actions) {
    assert.deepEqual(command.defaultKeys, [], command.id)
  }
})

test("a command can be registered and withdrawn again", () => {
  const definition = {
    id: "plugin.example",
    label: "Example plugin action",
    group: "actions",
    context: "stories",
    defaultKeys: [],
    allowInTextEntry: "never"
  }
  const remove = registerKeyCommand(definition)
  assert.equal(keyCommand("plugin.example"), definition)
  assert.ok(keyCommands().some((command) => command.id === "plugin.example"))
  // A second registration of the same id is a bug in the registering code,
  // not something to resolve silently.
  assert.throws(() => registerKeyCommand(definition), /Duplicate key command/)

  remove()
  assert.equal(keyCommand("plugin.example"), undefined)
})

test("a command can be left with no shortcut at all", () => {
  const storage = fakeStorage()
  const bindings = defaultKeybindings()
  bindings.set("story.open", [])
  saveKeybindings(bindings, storage)

  // An unset command must survive a reload rather than falling back to its
  // default, which is the whole point of clearing it.
  assert.deepEqual(loadKeybindings(storage).get("story.open"), [])
  assert.equal(customizedCommandCount(loadKeybindings(storage)), 1)
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

// The shell is module state, so anything that changes it puts it back. Electron
// is the default and sees the whole catalogue.
test("a sidepanel is offered only the commands it can run", (t) => {
  t.after(() => setShell("electron"))
  setShell("webext")

  const offered = availableKeyCommands().map((command) => command.id)
  // The browser swallows Ctrl+T and friends before the panel document sees
  // them, there is no second pane to focus and no API for the address bar.
  for (const id of offered) {
    assert.ok(
      !id.startsWith("browser.") && !id.startsWith("panes.") &&
      !id.startsWith("window."),
      `${id} cannot work in a sidepanel`
    )
  }
  assert.ok(offered.includes("story.open"))
  assert.ok(offered.includes("search.focus"))
  // Electron-only story actions go the same way as the built-ins.
  assert.ok(!offered.includes("story-action.open-external"))
  assert.ok(offered.includes("story-action.copy-link"))

  const bindings = defaultKeybindings()
  assert.equal(bindings.has("browser.new-tab"), false)
  // And the chord it used to hold is free for something the panel can do.
  assert.equal(conflictingCommand(bindings, "story.open", "Ctrl+T"), null)
  assert.deepEqual(findKeybindingConflicts(bindings), [])
})

test("an override for a command this shell cannot run is discarded", (t) => {
  t.after(() => setShell("electron"))
  setShell("webext")

  const merged = mergeKeybindings({
    version: 1,
    bindings: { "browser.new-tab": ["Ctrl+Alt+T"], "story.open": ["K"] }
  })
  assert.equal(merged.has("browser.new-tab"), false)
  assert.deepEqual(merged.get("story.open"), ["K"])
})

test("electron keeps the full catalogue", () => {
  const ids = availableKeyCommands().map((command) => command.id)
  assert.ok(ids.includes("browser.new-tab"))
  assert.ok(ids.includes("panes.focus-left"))
  assert.ok(ids.includes("story-action.open-external"))
  assert.equal(ids.length, keyCommands().length)
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
