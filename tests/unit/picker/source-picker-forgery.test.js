const test = require("node:test")
const assert = require("node:assert/strict")
const { parseHTML } = require("linkedom")
const { startSourcePicker } = require("../../../packages/ui-web/dist/picker/sourcePicker")

const page = `<!doctype html><html><body>
  <ul class="stories">
    <li class="story"><a class="title" href="https://example.test/one">One</a></li>
    <li class="story"><a class="title" href="https://example.test/two">Two</a></li>
  </ul>
</body></html>`

// The worst case for the overlay: it shares a world with the page (Android
// Lite without DevTools), and the page patched attachShadow beforehand, so it
// holds the closed root and every control in it.
function openPickerInHostilePage(t) {
  const { document, Event } = parseHTML(page)
  let elementPrototype = document.createElement("div")
  while (!Object.hasOwn(elementPrototype, "attachShadow")) {
    elementPrototype = Object.getPrototypeOf(elementPrototype)
  }
  const attachShadow = elementPrototype.attachShadow
  let captured = null
  elementPrototype.attachShadow = function (init) {
    captured = attachShadow.call(this, init)
    captured.requestedMode = init.mode
    return captured
  }
  const globals = {
    document,
    location: { href: "https://example.test/list" },
    window: {
      innerWidth: 800,
      innerHeight: 600,
      addEventListener() {},
      removeEventListener() {},
      requestAnimationFrame: () => 1,
      cancelAnimationFrame() {},
      setTimeout,
      clearTimeout
    }
  }
  const previous = {}
  for (const [name, value] of Object.entries(globals)) {
    previous[name] = Object.getOwnPropertyDescriptor(globalThis, name)
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  }
  t.after(async () => {
    // One session at a time: end this one so the next test gets an overlay.
    const cancel = new Event("click")
    Object.defineProperty(cancel, "isTrusted", { value: true })
    captured.querySelector("#actions button").dispatchEvent(cancel)
    await session
    elementPrototype.attachShadow = attachShadow
    for (const [name, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  })

  let outcome = "pending"
  const session = startSourcePicker()
  session.then((result) => { outcome = result })
  const host = document.querySelector("once-source-picker")
  const fire = (target, type, trusted = false) => {
    const event = new Event(type, { bubbles: true })
    // Only the browser can set isTrusted; the test stands in for it here.
    if (trusted) Object.defineProperty(event, "isTrusted", { value: true })
    target.dispatchEvent(event)
  }
  const settle = () => new Promise((resolve) => setImmediate(resolve))
  return { host, root: captured, session, fire, settle, outcome: () => outcome }
}

function fillSelectors(root) {
  const inputs = root.querySelectorAll(".row input")
  inputs[0].value = "li.story"
  inputs[1].value = "a.title"
  inputs[2].value = "a.title"
}

test("keeps the overlay in a closed shadow root", (t) => {
  const picker = openPickerInHostilePage(t)
  assert.ok(picker.host, "the overlay is in the page")
  assert.equal(picker.root.requestedMode, "closed")
  assert.equal(picker.host.shadowRoot, null)
})

test("ignores script-raised events on Save, Cancel, Pick and the source line", async (t) => {
  const picker = openPickerInHostilePage(t)
  fillSelectors(picker.root)
  const [cancel, save] = picker.root.querySelectorAll("#actions button")
  const source = picker.root.querySelector("#source textarea")
  source.value = JSON.stringify({ stories: { sel: "body", all: true } })

  picker.fire(source, "input")
  picker.fire(save, "click")
  save.click?.()
  picker.fire(cancel, "click")
  for (const pick of picker.root.querySelectorAll(".row button")) picker.fire(pick, "click")
  picker.fire(picker.root.querySelector("#catcher"), "click")
  await picker.settle()

  assert.equal(picker.outcome(), "pending")
  assert.ok(picker.host.isConnected, "the overlay is still open")
  // Pick mode is still on the field it started on.
  assert.equal(picker.root.querySelector(".row button").textContent, "Esc")
})

test("saves the selectors on a trusted click", async (t) => {
  const picker = openPickerInHostilePage(t)
  fillSelectors(picker.root)
  picker.fire(picker.root.querySelector("#actions .save"), "click", true)
  const result = await picker.session

  assert.equal(result.url, "https://example.test/list")
  assert.deepEqual(JSON.parse(result.conf), {
    stories: { sel: "li.story", all: true },
    link: { sel: "a.title", component: "href" },
    title: { sel: "a.title", component: "innerText", processors: ["trim"] }
  })
  assert.equal(picker.host.isConnected, false)
})

test("cancels on a trusted click", async (t) => {
  const picker = openPickerInHostilePage(t)
  picker.fire(picker.root.querySelector("#actions button"), "click", true)
  assert.equal(await picker.session, null)
})
