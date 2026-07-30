const test = require("node:test")
const assert = require("node:assert/strict")
const { parseHTML } = require("linkedom")

test("collapse controls toggle the menu and notify their host", () => {
  const { window } = parseHTML(`
    <nav id="menu"><button class="button sidebar_panel">Settings</button></nav>
    <button class="collapsebutton" aria-label="Collapse sidebar"></button>
    <button class="collapsebutton" aria-label="Collapse sidebar"></button>
  `)
  const previousDocument = globalThis.document
  const previousElement = globalThis.Element
  globalThis.document = window.document
  globalThis.Element = window.Element

  try {
    const { bindMenuCollapseControls } = require(
      "../../../packages/ui-web/dist/shell/menuCollapse"
    )
    const changes = []
    const controls = [...document.querySelectorAll(".collapsebutton")]
    bindMenuCollapseControls((collapsed) => changes.push(collapsed))

    controls[0].click()
    assert.ok(document.querySelector("#menu").classList.contains("collapse"))
    assert.ok(controls.every((control) =>
      control.classList.contains("collapsebutton--collapsed")
    ))
    assert.deepEqual(
      controls.map((control) => control.getAttribute("aria-label")),
      ["Expand sidebar", "Expand sidebar"]
    )

    document.querySelector(".sidebar_panel").click()
    assert.ok(!document.querySelector("#menu").classList.contains("collapse"))
    assert.ok(controls.every((control) =>
      !control.classList.contains("collapsebutton--collapsed")
    ))
    assert.deepEqual(
      controls.map((control) => control.getAttribute("aria-label")),
      ["Collapse sidebar", "Collapse sidebar"]
    )
    assert.deepEqual(changes, [true, false])
  } finally {
    if (previousDocument === undefined) Reflect.deleteProperty(globalThis, "document")
    else globalThis.document = previousDocument
    if (previousElement === undefined) Reflect.deleteProperty(globalThis, "Element")
    else globalThis.Element = previousElement
  }
})
