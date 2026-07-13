const test = require("node:test")
const assert = require("node:assert/strict")
const { parseHTML } = require("linkedom")

function installDom(source) {
  const { window } = parseHTML(source)
  const previous = new Map()
  for (const [name, value] of Object.entries({
    document: window.document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Node: window.Node
  })) {
    previous.set(name, globalThis[name])
    globalThis[name] = value
  }
  return {
    window,
    restore() {
      for (const [name, value] of previous) {
        if (value === undefined) Reflect.deleteProperty(globalThis, name)
        else globalThis[name] = value
      }
    }
  }
}

function dispatch(window, element, type, relatedTarget = null) {
  const event = new window.Event(type, { bubbles: true })
  Object.defineProperty(event, "relatedTarget", { value: relatedTarget })
  element.dispatchEvent(event)
}

test("hover URL indicator delays, cancels, and completes dismissal", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const dom = installDom(`
    <section id="stories_panel">
      <a id="first" href="https://example.com/first">First</a>
      <a id="second" href="https://example.com/second">Second</a>
    </section>
  `)
  try {
    const { HoverUrlIndicator } = require(
      "../../../packages/ui-web/dist/HoverUrlIndicator"
    )
    const indicator = HoverUrlIndicator.mount()
    assert.ok(indicator)

    const first = document.querySelector("#first")
    const second = document.querySelector("#second")
    const output = document.querySelector("#hover_url")

    dispatch(dom.window, first, "mouseover")
    assert.equal(output.textContent, "https://example.com/first")
    assert.ok(output.classList.contains("visible"))

    dispatch(dom.window, first, "mouseout")
    t.mock.timers.tick(799)
    assert.ok(output.classList.contains("visible"))
    dispatch(dom.window, second, "mouseover")
    t.mock.timers.tick(1)
    assert.equal(output.textContent, "https://example.com/second")
    assert.ok(output.classList.contains("visible"))

    dispatch(dom.window, second, "mouseout")
    t.mock.timers.tick(800)
    assert.ok(!output.classList.contains("visible"))

    HoverUrlIndicator.show("https://example.com/web-contents")
    assert.equal(output.textContent, "https://example.com/web-contents")
    assert.ok(output.classList.contains("visible"))
    HoverUrlIndicator.show("")
    t.mock.timers.tick(799)
    assert.ok(output.classList.contains("visible"))
    t.mock.timers.tick(1)
    assert.ok(!output.classList.contains("visible"))
    indicator.destroy()
  } finally {
    dom.restore()
  }
})

test("status issues stack, dismiss, restore, and reset per reload", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const dom = installDom('<nav id="menu"></nav><main id="left_main"></main>')
  const settingsModule = require.resolve(
    "../../../packages/ui-web/dist/SettingsPanel"
  )
  const previousSettingsModule = require.cache[settingsModule]
  require.cache[settingsModule] = {
    id: settingsModule,
    filename: settingsModule,
    loaded: true,
    exports: { SettingsPanel: { instance: null } }
  }
  try {
    const { LoaderInsights } = require(
      "../../../packages/ui-web/dist/LoaderInsights"
    )
    const subscriptions = new Map()
    LoaderInsights.init({
      subscribe(name, handler) {
        subscriptions.set(name, handler)
        return () => undefined
      }
    })

    subscriptions.get("loaderChanged")({
      processing: [{ domain: "example.com", parserType: "RSS" }]
    })
    assert.match(document.querySelector("#status_bar_text").textContent, /Loading 1 source/)
    assert.ok(document.querySelector("#status_bar_activity").classList.contains("spinning"))
    document.querySelector("#status_bar_state").click()
    assert.ok(document.querySelector("#status_bar").hidden)

    const errors = [
      { url: "warning:one", title: "Warning one", message: "one", type: "warning" },
      { url: "warning:two", title: "Warning two", message: "two", type: "warning" },
      { url: "error:one", title: "Error one", message: "one", type: "error" },
      { url: "error:two", title: "Error two", message: "two", type: "error" }
    ]
    subscriptions.get("sourceErrorsChanged")({ errors })
    assert.equal(document.querySelectorAll(".status_issue_bubble").length, 4)
    assert.equal(document.querySelector("#status_bar_warnings .status_indicator_count").textContent, "2")
    assert.equal(document.querySelector("#status_bar_errors .status_indicator_count").textContent, "2")

    document.querySelector(".status_issue_bubble.error .status_issue_close").click()
    assert.equal(document.querySelectorAll(".status_issue_bubble.error").length, 1)
    document.querySelector("#status_bar_errors").click()
    assert.equal(document.querySelectorAll(".status_issue_bubble.error").length, 0)
    document.querySelector("#status_bar_errors").click()
    assert.equal(document.querySelectorAll(".status_issue_bubble.error").length, 2)

    t.mock.timers.tick(5000)
    assert.equal(document.querySelectorAll(".status_issue_bubble.warning").length, 0)
    assert.equal(document.querySelectorAll(".status_issue_bubble.error").length, 2)
    document.querySelector("#status_bar_warnings").click()
    assert.equal(document.querySelectorAll(".status_issue_bubble.warning").length, 2)

    LoaderInsights.showErrorMessage("Reader mode failed")
    t.mock.timers.tick(10_000)
    assert.match(
      document.querySelector(".status_issue_bubble.error").textContent,
      /Reader mode failed|Error/
    )

    subscriptions.get("sourceErrorsChanged")({ errors: [] })
    assert.equal(document.querySelectorAll(".status_issue_bubble").length, 0)
    assert.ok(document.querySelector("#status_bar_warnings").hidden)
    assert.ok(document.querySelector("#status_bar_errors").hidden)
  } finally {
    if (previousSettingsModule) require.cache[settingsModule] = previousSettingsModule
    else Reflect.deleteProperty(require.cache, settingsModule)
    dom.restore()
  }
})
