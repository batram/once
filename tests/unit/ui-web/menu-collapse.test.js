const test = require("node:test")
const assert = require("node:assert/strict")
const { parseHTML } = require("linkedom")

function withDocument(html, run) {
  const { window } = parseHTML(html)
  const previous = {
    document: globalThis.document,
    Element: globalThis.Element,
    localStorage: globalThis.localStorage
  }
  const stored = new Map()
  globalThis.document = window.document
  globalThis.Element = window.Element
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

test("a click on a collapsed menu's entry expands it and notifies the host", () => {
  withDocument(SHELL, () => {
    const { bindMenuCollapseControls, expandMenu } = load()
    const changes = []
    bindMenuCollapseControls((collapsed) => changes.push(collapsed))
    const menu = document.querySelector("#menu")
    menu.classList.add("collapse")

    document.querySelector(".sidebar_panel").click()
    assert.ok(!menu.classList.contains("collapse"))
    expandMenu()
    assert.deepEqual(changes, [false])
    assert.ok(!document.body.classList.contains("menu-resizable"), "fixed width unless resizable")
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
    assert.deepEqual(changes, [true, false])
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
    assert.deepEqual(changes, [true])

    document.querySelector(".sidebar_panel").click()
    assert.ok(!menu.classList.contains("collapse"))
    assert.equal(stored.get("once:menu-collapsed"), undefined)
    assert.equal(menu.style.getPropertyValue("--menu-width"), "200px")
  })
})
