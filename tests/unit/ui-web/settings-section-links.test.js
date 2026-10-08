const test = require("node:test")
const assert = require("node:assert/strict")
const { parseHTML } = require("linkedom")

test("a word on one page opens another section and lights the row it meant", async () => {
  const { window } = parseHTML(`<html><body><div id="panel">
    <p>Choose it under <button type="button" data-open-settings-section="theme" data-open-settings-row="placement">Appearance</button>.</p>
    <div class="settings_row"><label for="placement">Where</label><select id="placement"><option>a</option></select></div>
  </div></body></html>`)
  const names = ["window", "document", "HTMLElement", "Element"]
  const previous = Object.fromEntries(names.map(name => [name, globalThis[name]]))
  for (const name of names) globalThis[name] = window[name]
  const frames = []
  globalThis.requestAnimationFrame = callback => { frames.push(callback); return frames.length }
  try {
    const { bindSettingsSectionLinks } = require("../../../packages/ui-web/dist/settings/settingsSectionLinks")
    const opened = []
    const panel = window.document.getElementById("panel")
    const row = panel.querySelector(".settings_row")
    const select = panel.querySelector("select")
    let scrolled = 0, focused = 0
    row.scrollIntoView = () => { scrolled++ }
    select.focus = () => { focused++ }
    bindSettingsSectionLinks(panel, key => opened.push(key))
    panel.querySelector("button").dispatchEvent(new window.Event("click", { bubbles: true }))
    assert.deepEqual(opened, ["theme"])
    // The row waits two frames: the section's own default focus comes first.
    assert.equal(frames.length, 1)
    frames.shift()()
    assert.equal(frames.length, 1)
    frames.shift()()
    assert.equal(scrolled, 1)
    assert.equal(focused, 1)
    assert.ok(row.classList.contains("settings_row_spotlight"))
    row.dispatchEvent(new window.Event("animationend"))
    assert.equal(row.classList.contains("settings_row_spotlight"), false)
  } finally {
    delete globalThis.requestAnimationFrame
    for (const name of names) {
      if (previous[name] === undefined) Reflect.deleteProperty(globalThis, name)
      else globalThis[name] = previous[name]
    }
  }
})
