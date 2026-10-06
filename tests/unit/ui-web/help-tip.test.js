const test = require("node:test")
const assert = require("node:assert/strict")
const { parseHTML } = require("linkedom")

test("a long hint goes behind a (?) beside its setting's name, opens on click or hover and closes on Escape", () => {
  const { document, window } = parseHTML(`<html><body><div class="settings_row">
    <label class="settings_row_name" for="control">Receive sent tabs</label>
    <p class="settings_row_hint" id="control_hint" data-help>Other devices can send tabs here.</p>
    <input id="control" type="checkbox" aria-describedby="control_hint" />
  </div><section><h4>Filter lists</h4><p class="settings_group_hint" data-help>One URL per line.</p></section></body></html>`)
  const previous = { document: global.document, window: global.window, Node: global.Node }
  global.document = document
  global.window = Object.assign(window, { innerWidth: 400, innerHeight: 800 })
  global.Node = window.Node
  window.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 10, top: 10, right: 30, bottom: 30, width: 20, height: 20 })
  try {
    const { bindHelpTips } = require("../../../packages/ui-web/dist/helpTip")
    bindHelpTips(document)
    const [rowTip, groupTip] = document.querySelectorAll("[data-testid=help-tip]")
    const text = document.querySelector("#control_hint")
    assert.equal(rowTip.getAttribute("aria-label"), "About Receive sent tabs")
    assert.equal(rowTip.getAttribute("aria-controls"), "control_hint")
    assert.equal(text.hidden, true, "the explanation starts hidden")
    assert.ok(text.classList.contains("help_tip_text") && !text.classList.contains("settings_row_hint"))
    assert.equal(document.querySelector("#control").getAttribute("aria-describedby"), "control_hint", "the control is still described by it")
    const name = document.querySelector(".help_tip_name")
    assert.ok(name.contains(document.querySelector("label")) && name.contains(rowTip) && name.contains(text))
    assert.ok(!document.querySelector("label").contains(rowTip), "the label keeps its own name")
    assert.ok(document.querySelector("h4").contains(groupTip), "a group's hint goes beside its heading")

    rowTip.click()
    assert.equal(text.hidden, false)
    assert.equal(rowTip.getAttribute("aria-expanded"), "true")
    document.dispatchEvent(Object.assign(new window.Event("keydown", { bubbles: true }), { key: "Escape" }))
    assert.equal(text.hidden, true, "Escape closes it")

    rowTip.dispatchEvent(Object.assign(new window.Event("pointerenter"), { pointerType: "mouse" }))
    assert.equal(text.hidden, false, "a pointer resting on it shows it")
    rowTip.dispatchEvent(Object.assign(new window.Event("pointerleave"), { pointerType: "mouse" }))
    assert.equal(text.hidden, true, "and leaving hides it unless it was clicked open")
  } finally {
    global.document = previous.document
    global.window = previous.window
    global.Node = previous.Node
  }
})

test("a switch row with a (?) still toggles from anywhere but its own controls", () => {
  const { document, window } = parseHTML(`<html><body><div id="panel"><div class="settings_row settings_row_inline">
    <label class="settings_row_name" for="control">Receive sent tabs</label>
    <p class="settings_row_hint" id="control_hint" data-help>Other devices can send tabs here.</p>
    <input id="control" class="switch" type="checkbox" aria-describedby="control_hint" />
  </div></div></body></html>`)
  const previous = { document: global.document, window: global.window, Node: global.Node }
  global.document = document
  global.window = window
  global.Node = window.Node
  global.Element = window.Element
  try {
    const { bindSettingsRows } = require("../../../packages/ui-web/dist/settings/settingsControlBindings")
    bindSettingsRows(document.querySelector("#panel"))
    // linkedom does not flip a checkbox on click(), so count the clicks it receives.
    let toggles = 0
    document.querySelector("#control").click = () => { toggles += 1 }
    const click = (element) => element.dispatchEvent(new window.Event("click", { bubbles: true }))
    click(document.querySelector(".help_tip_name"))
    assert.equal(toggles, 1, "the name column beside the label toggles")
    click(document.querySelector(".settings_row"))
    assert.equal(toggles, 2, "the row's padding toggles")
    click(document.querySelector("[data-testid=help-tip]"))
    click(document.querySelector("#control_hint"))
    assert.equal(toggles, 2, "the (?) and its text do not")
  } finally {
    Object.assign(global, previous)
    delete global.Element
  }
})
