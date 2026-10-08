const test = require("node:test")
const assert = require("node:assert/strict")
const { parseHTML } = require("linkedom")

function withDocument(html, run) {
  const { window } = parseHTML(html)
  const previous = {
    document: globalThis.document,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    getComputedStyle: globalThis.getComputedStyle,
    localStorage: globalThis.localStorage
  }
  const stored = new Map()
  globalThis.document = window.document
  globalThis.Element = window.Element
  globalThis.HTMLElement = window.HTMLElement
  // linkedom lays nothing out, so a measured minimum falls back to the fixed one.
  globalThis.getComputedStyle = () => ({ columnGap: "0", paddingLeft: "0", paddingRight: "0" })
  globalThis.localStorage = {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, String(value)),
    removeItem: (key) => stored.delete(key)
  }
  try {
    run(window, stored)
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) Reflect.deleteProperty(globalThis, name)
      else globalThis[name] = value
    }
  }
}

const SHELL = `
  <body>
    <div id="menu"><button class="button sidebar_panel">Settings</button></div>
    <div id="menu_resizer"></div>
    <button class="collapsebutton" aria-label="Collapse sidebar"></button>
    <button class="collapsebutton" aria-label="Collapse sidebar"></button>
  </body>
`

function load() {
  const path = "../../../packages/ui-web/dist/shell/menuCollapse"
  Reflect.deleteProperty(require.cache, require.resolve(path))
  return require(path)
}

function pointer(target, type, clientX, extra = {}) {
  const event = new target.ownerDocument.defaultView.Event(type, { bubbles: true })
  Object.assign(event, { clientX, button: 0, pointerId: 1 }, extra)
  target.dispatchEvent(event)
}

function resizer(window) {
  const menu = window.document.querySelector("#menu")
  menu.getBoundingClientRect = () => ({ left: 0 })
  Object.defineProperties(menu, { offsetWidth: { value: 0 }, clientWidth: { value: 0 } })
  const handle = window.document.querySelector("#menu_resizer")
  handle.setPointerCapture = () => {}
  handle.hasPointerCapture = () => true
  handle.releasePointerCapture = () => {}
  return { menu, handle }
}

test("collapse controls toggle the menu and notify their host", () => {
  withDocument(SHELL, () => {
    const { bindMenuCollapseControls, expandMenu } = load()
    const changes = []
    const controls = [...document.querySelectorAll(".collapsebutton")]
    bindMenuCollapseControls((collapsed) => changes.push(collapsed))
    const menu = document.querySelector("#menu")
    assert.ok(!document.body.classList.contains("menu-resizable"), "fixed width unless resizable")

    controls[0].click()
    assert.ok(menu.classList.contains("collapse"))
    assert.ok(controls.every((control) => control.classList.contains("collapsebutton--collapsed")))
    assert.deepEqual(
      controls.map((control) => control.getAttribute("aria-label")),
      ["Expand sidebar", "Expand sidebar"]
    )

    document.querySelector(".sidebar_panel").click()
    assert.ok(!menu.classList.contains("collapse"))
    assert.ok(controls.every((control) => !control.classList.contains("collapsebutton--collapsed")))
    assert.deepEqual(
      controls.map((control) => control.getAttribute("aria-label")),
      ["Collapse sidebar", "Collapse sidebar"]
    )

    controls[1].click()
    expandMenu()
    assert.ok(!menu.classList.contains("collapse"))
    assert.deepEqual(changes, [true, false, true, false])
  })
})

test("a drag folds the menu alone, without telling the host", () => {
  withDocument(SHELL, (window) => {
    const { bindMenuCollapseControls, MENU_WIDTH } = load()
    const changes = []
    bindMenuCollapseControls((collapsed) => changes.push(collapsed), { resizable: true })
    const { menu, handle } = resizer(window)
    const controls = [...document.querySelectorAll(".collapsebutton")]

    pointer(handle, "pointerdown", 89)
    pointer(handle, "pointermove", MENU_WIDTH.min - 1)
    pointer(handle, "pointerup", MENU_WIDTH.min - 1)
    assert.ok(menu.classList.contains("collapse"))
    assert.ok(controls.every((control) => control.classList.contains("collapsebutton--collapsed")))
    document.querySelector(".sidebar_panel").click()
    assert.ok(!menu.classList.contains("collapse"))
    assert.deepEqual(changes, [])

    // A button fold after a drag fold still reaches the host both ways.
    controls[0].click()
    document.querySelector(".sidebar_panel").click()
    assert.deepEqual(changes, [true, false])
  })
})

test("dragging the resizer sets a remembered width within the bounds", () => {
  withDocument(SHELL, (window, stored) => {
    const { bindMenuCollapseControls, MENU_WIDTH } = load()
    bindMenuCollapseControls(undefined, { resizable: true })
    const { menu, handle } = resizer(window)
    assert.ok(document.body.classList.contains("menu-resizable"))
    assert.equal(menu.style.getPropertyValue("--menu-width"), `${MENU_WIDTH.default}px`)

    pointer(handle, "pointerdown", 89)
    pointer(handle, "pointermove", 150)
    assert.equal(menu.style.getPropertyValue("--menu-width"), "150px")
    pointer(handle, "pointermove", 900)
    assert.equal(menu.style.getPropertyValue("--menu-width"), `${MENU_WIDTH.max}px`)
    pointer(handle, "pointerup", 900)
    assert.equal(stored.get("once:menu-width"), String(MENU_WIDTH.max))
    assert.equal(stored.get("once:menu-collapsed"), undefined)
  })
})

test("dragging under the minimum collapses the menu, and back out expands it", () => {
  withDocument(SHELL, (window, stored) => {
    const { bindMenuCollapseControls, MENU_WIDTH } = load()
    const changes = []
    bindMenuCollapseControls((collapsed) => changes.push(collapsed), { resizable: true })
    const { menu, handle } = resizer(window)

    pointer(handle, "pointerdown", 89)
    pointer(handle, "pointermove", MENU_WIDTH.min + 5)
    pointer(handle, "pointermove", MENU_WIDTH.min - 1)
    assert.ok(menu.classList.contains("collapse"))
    pointer(handle, "pointermove", 20)
    pointer(handle, "pointerup", 20)
    assert.equal(stored.get("once:menu-collapsed"), "true")
    assert.equal(menu.style.getPropertyValue("--menu-width"), `${MENU_WIDTH.default}px`, "the last width is kept")

    pointer(handle, "pointerdown", 28)
    pointer(handle, "pointermove", 120)
    assert.ok(!menu.classList.contains("collapse"))
    pointer(handle, "pointerup", 120)
    assert.equal(stored.get("once:menu-collapsed"), undefined)
    assert.equal(stored.get("once:menu-width"), "120")
    assert.deepEqual(changes, [], "a drag fold is the menu's alone")
  })
})

test("a stored width and collapsed state are restored on mount", () => {
  withDocument(SHELL, (window, stored) => {
    stored.set("once:menu-width", "200")
    stored.set("once:menu-collapsed", "true")
    const { bindMenuCollapseControls } = load()
    const changes = []
    bindMenuCollapseControls((collapsed) => changes.push(collapsed), { resizable: true })
    const menu = document.querySelector("#menu")
    assert.equal(menu.style.getPropertyValue("--menu-width"), "200px")
    assert.ok(menu.classList.contains("collapse"))
    assert.deepEqual(changes, [], "a restored fold is the menu's alone")

    document.querySelector(".sidebar_panel").click()
    assert.ok(!menu.classList.contains("collapse"))
    assert.equal(stored.get("once:menu-collapsed"), undefined)
    assert.equal(menu.style.getPropertyValue("--menu-width"), "200px")
  })
})
