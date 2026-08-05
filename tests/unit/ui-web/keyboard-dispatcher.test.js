const test = require("node:test")
const assert = require("node:assert/strict")
const { parseHTML } = require("linkedom")

const SHELL = `
  <div id="left_panel" active_panel="stories">
    <input id="searchfield" type="search" />
    <textarea id="sources_area"></textarea>
    <div id="slider" role="slider" tabindex="0"></div>
    <div id="stories"></div>
  </div>
  <div id="right_panel"><div id="tab_content" tabindex="0"></div></div>
`

// The dispatcher reads document.activeElement and #left_panel, so each case
// runs against a fresh linkedom document installed as the global.
function withShell(run) {
  const { window } = parseHTML(`<body>${SHELL}</body>`)
  const previousDocument = globalThis.document
  globalThis.document = window.document
  try {
    const {
      KeyboardDispatcher,
      defaultBindings,
      bindingsFrom,
      textEntryKind
    } = require("../../../packages/ui-web/dist/keyboard/KeyboardDispatcher")
    return run({
      window,
      KeyboardDispatcher,
      defaultBindings,
      bindingsFrom,
      textEntryKind
    })
  } finally {
    globalThis.document = previousDocument
  }
}

// linkedom has no KeyboardEvent constructor, so the modifier flags are pinned
// onto a plain Event the same way the structured-settings tests do it.
function press(window, init) {
  const event = new window.Event("keydown", { bubbles: true, cancelable: true })
  // `key` defaults to the US-layout character for the code, so a test only
  // spells it out when it is simulating a different layout.
  const defaults = { key: defaultKeyFor(init.code) }
  for (const field of ["code", "key", "ctrlKey", "altKey", "shiftKey", "metaKey"]) {
    Object.defineProperty(event, field, {
      value: init[field] ?? defaults[field] ?? false
    })
  }
  const target = init.target || window.document.body
  target.dispatchEvent(event)
  return event
}

function defaultKeyFor(code = "") {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase()
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  return code
}

test("a bound chord runs its handler once and swallows the key", () => {
  withShell(({ window, KeyboardDispatcher, defaultBindings }) => {
    const dispatcher = new KeyboardDispatcher(defaultBindings())
    let undos = 0
    dispatcher.register("history.undo", () => { undos += 1 })
    dispatcher.mount(window)

    const event = press(window, { code: "KeyZ", ctrlKey: true })
    assert.equal(undos, 1)
    assert.equal(event.defaultPrevented, true)

    // Nothing else in the shell listens for Ctrl+Z any more, so a second
    // dispatch is the only way the count could rise.
    press(window, { code: "KeyZ", ctrlKey: true })
    assert.equal(undos, 2)
  })
})

test("an unhandled command leaves the key to whoever else wants it", () => {
  withShell(({ window, KeyboardDispatcher, defaultBindings }) => {
    const dispatcher = new KeyboardDispatcher(defaultBindings())
    dispatcher.mount(window)
    // browser.new-tab has no handler outside the Electron shell.
    const event = press(window, { code: "KeyT", ctrlKey: true })
    assert.equal(event.defaultPrevented, false)
  })
})

test("text entry keeps bare keys but still allows modified commands", () => {
  withShell(({ window, KeyboardDispatcher, defaultBindings }) => {
    const dispatcher = new KeyboardDispatcher(defaultBindings())
    let next = 0
    let focused = 0
    dispatcher.register("story.cursor-next", () => { next += 1 })
    dispatcher.register("search.focus", () => { focused += 1 })
    dispatcher.mount(window)

    const field = window.document.querySelector("#searchfield")
    press(window, { code: "KeyS", target: field })
    assert.equal(next, 0, "typing an s in the search field must not move the cursor")

    press(window, { code: "KeyF", ctrlKey: true, target: field })
    assert.equal(focused, 1, "Ctrl+F still reaches the shell from a text field")

    press(window, { code: "KeyS", target: window.document.querySelector("#stories") })
    assert.equal(next, 1)
  })
})

test("arrow keys stay with sliders and textareas", () => {
  withShell(({ window, KeyboardDispatcher, defaultBindings, textEntryKind }) => {
    const dispatcher = new KeyboardDispatcher(defaultBindings())
    let next = 0
    dispatcher.register("story.cursor-next", () => { next += 1 })
    dispatcher.mount(window)

    const slider = window.document.querySelector("#slider")
    const textarea = window.document.querySelector("#sources_area")
    assert.equal(textEntryKind(slider), "editor")
    assert.equal(textEntryKind(textarea), "editor")
    assert.equal(textEntryKind(window.document.querySelector("#searchfield")), "field")
    assert.equal(textEntryKind(window.document.querySelector("#stories")), null)

    press(window, { code: "ArrowDown", target: slider })
    press(window, { code: "ArrowDown", target: textarea })
    assert.equal(next, 0)
  })
})

test("story commands only fire while the stories panel is active", () => {
  withShell(({ window, KeyboardDispatcher, defaultBindings }) => {
    const dispatcher = new KeyboardDispatcher(defaultBindings())
    let next = 0
    dispatcher.register("story.cursor-next", () => { next += 1 })
    dispatcher.mount(window)

    press(window, { code: "ArrowDown" })
    assert.equal(next, 1)

    window.document.querySelector("#left_panel").setAttribute("active_panel", "settings")
    press(window, { code: "ArrowDown" })
    assert.equal(next, 1, "the cursor must not move while settings is open")
  })
})

test("a blocker stands the dispatcher down entirely", () => {
  withShell(({ window, KeyboardDispatcher, defaultBindings }) => {
    const dispatcher = new KeyboardDispatcher(defaultBindings())
    let next = 0
    let open = true
    dispatcher.register("story.cursor-next", () => { next += 1 })
    const release = dispatcher.registerBlocker(() => open)
    dispatcher.mount(window)

    const event = press(window, { code: "ArrowDown" })
    assert.equal(next, 0)
    assert.equal(
      event.defaultPrevented,
      false,
      "the overlay's own Escape handler must still see the event"
    )

    open = false
    press(window, { code: "ArrowDown" })
    assert.equal(next, 1)

    release()
    open = true
    press(window, { code: "ArrowDown" })
    assert.equal(next, 2, "a released blocker no longer applies")
  })
})

test("suspend and resume bracket the settings key-capture control", () => {
  withShell(({ window, KeyboardDispatcher, defaultBindings }) => {
    const dispatcher = new KeyboardDispatcher(defaultBindings())
    let next = 0
    dispatcher.register("story.cursor-next", () => { next += 1 })
    dispatcher.mount(window)

    dispatcher.suspend()
    press(window, { code: "ArrowDown" })
    assert.equal(dispatcher.dispatchChord("ArrowDown"), false)
    assert.equal(next, 0)

    dispatcher.resume()
    press(window, { code: "ArrowDown" })
    assert.equal(next, 1)
  })
})

test("dispatchChord drives commands that never reached the DOM", () => {
  withShell(({ window, KeyboardDispatcher, defaultBindings }) => {
    const dispatcher = new KeyboardDispatcher(defaultBindings())
    let tabs = 0
    dispatcher.register("browser.new-tab", () => { tabs += 1 })
    // Mounting is irrelevant here: this is the path the Electron main process
    // uses for keys pressed while a browser tab has focus.
    assert.equal(dispatcher.dispatchChord("Ctrl+T"), true)
    assert.equal(tabs, 1)
    assert.equal(dispatcher.dispatchChord("Ctrl+Shift+Q"), false)
    void window
  })
})

test("unmount removes the listener", () => {
  withShell(({ window, KeyboardDispatcher, defaultBindings }) => {
    const dispatcher = new KeyboardDispatcher(defaultBindings())
    let next = 0
    dispatcher.register("story.cursor-next", () => { next += 1 })
    dispatcher.mount(window)
    dispatcher.unmount(window)
    press(window, { code: "ArrowDown" })
    assert.equal(next, 0)
  })
})

test("remapped bindings replace the defaults", () => {
  withShell(({ window, KeyboardDispatcher, bindingsFrom }) => {
    const dispatcher = new KeyboardDispatcher(
      bindingsFrom(new Map([["story.cursor-next", ["J"]]]))
    )
    let next = 0
    dispatcher.register("story.cursor-next", () => { next += 1 })
    dispatcher.mount(window)

    press(window, { code: "ArrowDown" })
    assert.equal(next, 0, "the default chord is gone once it is overridden")
    press(window, { code: "KeyJ" })
    assert.equal(next, 1)
  })
})

test("a command this shell cannot run holds no chord", (t) => {
  const { setShell } = require("../../../packages/ui-web/dist/keyboard/commands")
  t.after(() => setShell("electron"))
  withShell(({ window, KeyboardDispatcher, bindingsFrom }) => {
    setShell("webext")
    // Even asked for explicitly: Ctrl+T never reaches a sidepanel document, so
    // binding it would only shadow whatever the user does bind it to later.
    const dispatcher = new KeyboardDispatcher(
      bindingsFrom(new Map([["browser.new-tab", ["Ctrl+T"]]]))
    )
    let opened = 0
    dispatcher.register("browser.new-tab", () => { opened += 1 })
    dispatcher.mount(window)

    press(window, { code: "KeyT", ctrlKey: true })
    assert.equal(opened, 0)
    assert.deepEqual(dispatcher.boundChords(), [])
  })
})

test("pane jumps escape a one-line field but leave editors alone", () => {
  withShell(({ window, KeyboardDispatcher, defaultBindings }) => {
    const dispatcher = new KeyboardDispatcher(defaultBindings())
    let jumps = 0
    dispatcher.register("panes.focus-right", () => { jumps += 1 })
    dispatcher.mount(window)

    // Otherwise the search box is a keyboard dead end.
    press(window, {
      code: "ArrowRight",
      altKey: true,
      shiftKey: true,
      target: window.document.querySelector("#searchfield")
    })
    assert.equal(jumps, 1)

    // In a textarea a modified arrow is selection or word navigation, and must
    // stay that way.
    const event = press(window, {
      code: "ArrowRight",
      altKey: true,
      shiftKey: true,
      target: window.document.querySelector("#sources_area")
    })
    assert.equal(jumps, 1)
    assert.equal(event.defaultPrevented, false)
  })
})

test("a mnemonic follows the keycap, and a movement key follows position", () => {
  withShell(({ window, KeyboardDispatcher, defaultBindings }) => {
    const dispatcher = new KeyboardDispatcher(defaultBindings())
    let undos = 0
    let redos = 0
    let next = 0
    dispatcher.register("history.undo", () => { undos += 1 })
    dispatcher.register("history.redo", () => { redos += 1 })
    dispatcher.register("story.cursor-next", () => { next += 1 })
    dispatcher.mount(window)

    // German layout: the Z-labelled key sits where a US layout has Y. Reading
    // position alone made Ctrl+Z redo, which is the bug this guards.
    press(window, { code: "KeyY", key: "z", ctrlKey: true })
    assert.equal(undos, 1)
    assert.equal(redos, 0)

    press(window, { code: "KeyZ", key: "y", ctrlKey: true })
    assert.equal(redos, 1)
    assert.equal(undos, 1)

    // French layout: the key under the left hand at the US S position still
    // produces "s", but even where a layout disagrees the position wins for
    // movement, because WASD is a shape rather than four letters.
    press(window, { code: "KeyS", key: "S" })
    assert.equal(next, 1)
    press(window, { code: "KeyS", key: "ς" })
    assert.equal(next, 2)
  })
})
