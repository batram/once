const test = require("node:test")
const assert = require("node:assert/strict")
const { parseHTML } = require("linkedom")
const { bindSyncSettingsControls, withCredentials } = require("../../../packages/ui-web/dist/settings/syncSettingsControls")

const markup = `
  <div class="settings_block">
    <div class="couch-container">
      <input id="couch_input" type="text" />
      <button id="couch_toggle" type="button" aria-label="Show username and password" aria-pressed="false">
        <span class="icon icon--eye"></span>
      </button>
    </div>
    <p id="couch_hint" hidden></p>
    <button type="button" data-action="save">Save</button>
    <button type="button" data-action="cancel">Cancel</button>
  </div>`

async function bind(stored) {
  globalThis.document = parseHTML(markup).document
  const saved = []
  const field = bindSyncSettingsControls(async () => stored, (url) => saved.push(url))
  await Promise.resolve()
  await Promise.resolve()
  const q = (selector) => document.querySelector(selector)
  const type = (value) => {
    const input = q("#couch_input")
    input.value = value
    input.dispatchEvent(new (input.ownerDocument.defaultView.Event)("input"))
  }
  return { field, saved, type, input: q("#couch_input"), toggle: q("#couch_toggle"), hint: q("#couch_hint"),
    save: q('[data-action="save"]'), cancel: q('[data-action="cancel"]'), icon: q("#couch_toggle .icon") }
}

test("hidden, the input holds the URL without its credentials and saves them back in", async () => {
  const previous = globalThis.document
  try {
    const { field, saved, input, toggle, hint, save, icon } = await bind("https://user:secret@example.test/db")
    assert.equal(input.value, "https://example.test/db")
    assert.equal(field.get(), "https://user:secret@example.test/db")
    assert.equal(hint.hidden, false)
    assert.equal(toggle.getAttribute("aria-pressed"), "false")
    assert.ok(icon.classList.contains("icon--eye"))
    save.click()
    assert.deepEqual(saved, ["https://user:secret@example.test/db"])
    toggle.click()
    assert.equal(input.value, "https://user:secret@example.test/db")
    assert.equal(hint.hidden, true)
    assert.equal(toggle.getAttribute("aria-label"), "Hide username and password")
    assert.ok(icon.classList.contains("icon--eye-off"))
    toggle.click()
    assert.equal(input.value, "https://example.test/db")
    assert.equal(field.get(), "https://user:secret@example.test/db")
  } finally { globalThis.document = previous }
})

test("edits to the hidden URL keep the credentials; typed credentials replace them", async () => {
  const previous = globalThis.document
  try {
    const { field, type, input, saved, save, cancel } = await bind("https://user:secret@example.test/db")
    type("https://example.test/other")
    assert.equal(field.get(), "https://user:secret@example.test/other")
    type("https://new:pass@example.test/other")
    assert.equal(field.get(), "https://new:pass@example.test/other")
    save.click()
    assert.deepEqual(saved, ["https://new:pass@example.test/other"])
    // Saved, the pasted credentials go back out of sight.
    assert.equal(input.value, "https://example.test/other")
    assert.equal(field.get(), "https://new:pass@example.test/other")
    // Half-typed, with no scheme yet, the URL is taken as typed and the
    // credentials wait for the scheme to come back.
    type("example.test/x")
    assert.equal(field.get(), "example.test/x")
    type("https://example.test/x")
    assert.equal(field.get(), "https://new:pass@example.test/x")
    cancel.click()
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(input.value, "https://example.test/db")
    assert.equal(field.get(), "https://user:secret@example.test/db")
  } finally { globalThis.document = previous }
})

test("a URL without credentials shows no hint and reads back as typed", async () => {
  const previous = globalThis.document
  try {
    const { field, hint, input, type } = await bind("https://example.test/db")
    assert.equal(input.value, "https://example.test/db")
    assert.equal(hint.hidden, true)
    assert.equal(field.get(), "https://example.test/db")
    type("")
    assert.equal(field.get(), "")
  } finally { globalThis.document = previous }
})

test("withCredentials swaps the authority's credentials by text", () => {
  assert.equal(withCredentials("https://a:b@h/p?q=1@x", "c:d@"), "https://c:d@h/p?q=1@x")
  assert.equal(withCredentials("https://h/p", "c:d@"), "https://c:d@h/p")
  assert.equal(withCredentials("https://a:b@h/p", ""), "https://h/p")
  assert.equal(withCredentials("not a url", "c:d@"), "not a url")
})
