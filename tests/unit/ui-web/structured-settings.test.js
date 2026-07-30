const test = require("node:test")
const assert = require("node:assert/strict")

const {
  parseSourceGroups,
  serializeSourceGroups,
  parseFilterRows,
  parseRedirectRows,
  serializeRedirectRows
} = require("../../../packages/ui-web/dist/StructuredSettingsEditors")
const {
  createRedirectTester
} = require("../../../packages/ui-web/dist/structuredSettings/redirectTester")
const {
  FlatSettingsEditors
} = require("../../../packages/ui-web/dist/structuredSettings/FlatSettingsEditors")
const {
  renderSourceRow
} = require("../../../packages/ui-web/dist/structuredSettings/SourceRows")
const {
  SourceGroupView
} = require("../../../packages/ui-web/dist/structuredSettings/SourceGroupView")
const { parseHTML } = require("linkedom")

function withDom(html, callback) {
  const { window } = parseHTML(html)
  const previous = {}
  for (const name of [
    "document",
    "window",
    "Node",
    "Element",
    "HTMLElement",
    "HTMLDetailsElement",
    "HTMLButtonElement",
    "HTMLInputElement",
    "HTMLTextAreaElement"
  ]) {
    previous[name] = globalThis[name]
    globalThis[name] = window[name] || window.document
  }
  const previousAnimationFrame = globalThis.requestAnimationFrame
  const previousCancelAnimationFrame = globalThis.cancelAnimationFrame
  const previousCss = globalThis.CSS
  globalThis.requestAnimationFrame = (action) => {
    action()
    return 1
  }
  globalThis.cancelAnimationFrame = () => {}
  globalThis.CSS = { escape: (value) => value }
  window.HTMLElement.prototype.scrollIntoView = () => {}
  try {
    return callback(window)
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) Reflect.deleteProperty(globalThis, name)
      else globalThis[name] = value
    }
    if (previousAnimationFrame === undefined) {
      Reflect.deleteProperty(globalThis, "requestAnimationFrame")
    } else {
      globalThis.requestAnimationFrame = previousAnimationFrame
    }
    if (previousCancelAnimationFrame === undefined) {
      Reflect.deleteProperty(globalThis, "cancelAnimationFrame")
    } else {
      globalThis.cancelAnimationFrame = previousCancelAnimationFrame
    }
    if (previousCss === undefined) Reflect.deleteProperty(globalThis, "CSS")
    else globalThis.CSS = previousCss
  }
}

test("story source groups round-trip order, duplicates, and empty groups", () => {
  const lines = [
    "https://one.test/",
    "*news",
    "geny:§§{\"stories\":{\"sel\":\"article\"}}§§https://two.test/",
    "https://two.test/",
    "*empty"
  ]
  assert.deepEqual(serializeSourceGroups(parseSourceGroups(lines)), lines)
})

test("filter rows preserve exact nonblank values, duplicates, and order", () => {
  assert.deepEqual(parseFilterRows("  first.test\n\nfirst.test\n second.test "), [
    "  first.test",
    "first.test",
    " second.test "
  ])
})

test("redirect rows preserve valid and malformed raw lines", () => {
  const text = [
    "https://one.test/(.*) => https://two.test/$1 => retained",
    "malformed redirect"
  ].join("\n")
  const rows = parseRedirectRows(text)
  assert.equal(rows[0].match_url, "https://one.test/(.*)")
  assert.equal(rows[0].replace_url, "https://two.test/$1 => retained")
  assert.equal(rows[1].invalid, true)
  assert.equal(serializeRedirectRows(rows), text)
})

test("redirect tester seeds a matching URL and highlights exact captures", async () => {
  const { window } = parseHTML("<main></main>")
  const previous = {
    document: globalThis.document,
    window: globalThis.window
  }
  globalThis.document = window.document
  globalThis.window = window
  try {
    const pattern = window.document.createElement("textarea")
    pattern.value = "example\\.test/(same)/(.*)"
    const replacement = window.document.createElement("textarea")
    replacement.value = "mirror.test/$2/$1"
    const tester = createRedirectTester(pattern, replacement, [
      "https://example.test/same/value",
      "https://unmatched.test/article"
    ])
    window.document.querySelector("main").append(tester.element, tester.corpus)
    tester.refresh()
    await new Promise((resolve) => setTimeout(resolve, 150))

    const input = tester.element.querySelector("input")
    assert.equal(input.value, "https://example.test/same/value")
    assert.deepEqual(
      [...tester.element.querySelectorAll("mark")].map((mark) => mark.textContent),
      ["same", "value"]
    )
    assert.match(
      tester.element.querySelector(".structured_redirect_output").textContent,
      /mirror\.test\/value\/same/
    )
    assert.equal(tester.corpus.textContent, "Matches 1 of 2 loaded stories")
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) Reflect.deleteProperty(globalThis, name)
      else globalThis[name] = value
    }
  }
})

test("redirect tester reports invalid expressions without throwing", async () => {
  const { window } = parseHTML("<main></main>")
  const previous = {
    document: globalThis.document,
    window: globalThis.window
  }
  globalThis.document = window.document
  globalThis.window = window
  try {
    const pattern = window.document.createElement("textarea")
    pattern.value = "["
    const replacement = window.document.createElement("textarea")
    const tester = createRedirectTester(pattern, replacement, [])
    tester.refresh()
    await new Promise((resolve) => setTimeout(resolve, 150))

    assert.match(
      tester.element.querySelector(".structured_redirect_parse_error").textContent,
      /Invalid regular expression/
    )
    assert.equal(tester.corpus.textContent, "Matches 0 of 0 loaded stories")
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) Reflect.deleteProperty(globalThis, name)
      else globalThis[name] = value
    }
  }
})

test("flat settings editor renders and saves filter edits through its host", () => {
  withDom('<main data-structured-section="filters"></main>', (window) => {
    const root = window.document.querySelector("main")
    const saved = []
    let openEditor = null
    let detailEntries = 0
    const host = {
      onTouch: () => false,
      closeOpenEditor: () => openEditor?.(),
      setOpenEditor: (close) => {
        openEditor = close
      },
      enterFilterDetail: () => { detailEntries += 1 },
      listActions: () => null,
      renderListStatus: () => {},
      render: () => {
        root.textContent = ""
        editor.renderFilters(root)
      },
      root: () => root,
      setText: (_section, text) => saved.push(["text", text]),
      showForm: () => {},
      saveFilters: (values) => saved.push(["filters", values]),
      saveRedirects: () => {}
    }
    const editor = new FlatSettingsEditors(host)
    editor.readFilters("first\nsecond")
    editor.renderFilters(root)

    assert.deepEqual(
      [...root.querySelectorAll("[data-testid='filter-row']")]
        .map((button) => button.textContent),
      ["first", "second"]
    )
    window.HTMLInputElement.prototype.select = () => {}
    root.querySelector("[data-testid='filter-row']").click()
    assert.equal(detailEntries, 1)
    const input = root.querySelector("[data-testid='filter-inline-input']")
    input.value = "changed"
    const enter = new window.Event("keydown")
    Object.defineProperty(enter, "key", { value: "Enter" })
    input.dispatchEvent(enter)

    assert.deepEqual(saved, [
      ["text", "changed\nsecond"],
      ["filters", ["changed", "second"]]
    ])
  })
})

test("flat settings editor preserves malformed redirect rows", () => {
  withDom('<main data-structured-section="redirects"></main>', (window) => {
    const root = window.document.querySelector("main")
    const editor = new FlatSettingsEditors({
      onTouch: () => false,
      closeOpenEditor: () => {},
      setOpenEditor: () => {},
      enterFilterDetail: () => {},
      listActions: () => null,
      renderListStatus: () => {},
      render: () => {},
      root: () => root,
      setText: () => {},
      showForm: () => {},
      saveFilters: () => {},
      saveRedirects: () => {}
    })
    editor.readRedirects("malformed redirect")
    editor.renderRedirects(root)

    const row = root.querySelector("[data-testid='redirect-row']")
    assert.equal(row.textContent, 'malformed redirectNot a "match => replace" line')
    assert.match(row.title, /Invalid redirect/)
  })
})

function sourceRowHost(window, groups, saved, overrides = {}) {
  return {
    groups,
    errors: new Map(),
    onTouch: () => true,
    edit: (...position) => saved.push(["edit", ...position.slice(1)]),
    save: (reload) => saved.push(["save", reload]),
    showError: (source) => saved.push(["error", source]),
    openMenu: () => {},
    ...overrides
  }
}

test("source row rendering keeps edit and error callbacks on the host", () => {
  withDom("<main></main>", (window) => {
    const root = window.document.querySelector("main")
    const groups = [{ id: "default", name: "Default", sources: ["bad.test"] }]
    const calls = []
    const host = sourceRowHost(window, groups, calls, {
      errors: new Map([["bad.test", {
        url: "bad.test",
        type: "error",
        title: "Unavailable",
        message: "The source is unavailable"
      }]])
    })
    root.append(renderSourceRow(root, host, "bad.test", 0, 0, "source-1"))

    root.querySelector("[data-testid='source-row']").click()
    root.querySelector("[data-testid='source-error']").click()

    assert.deepEqual(calls, [
      ["edit", 0, 0],
      ["error", "bad.test"]
    ])
    assert.equal(
      root.querySelector(".structured_row_secondary").textContent,
      "Unavailable"
    )
  })
})

test("source row drop reorders the model and saves without story reload", () => {
  withDom("<main></main>", (window) => {
    const root = window.document.querySelector("main")
    const groups = [{
      id: "default",
      name: "Default",
      sources: ["first.test", "second.test"]
    }]
    const calls = []
    const host = sourceRowHost(window, groups, calls)
    const row = renderSourceRow(root, host, "second.test", 0, 1, "source-2")
    root.append(row)
    row.getBoundingClientRect = () => ({ top: 20, height: 20 })
    const drop = new window.Event("drop", { bubbles: true, cancelable: true })
    Object.defineProperties(drop, {
      clientY: { value: 20 },
      dataTransfer: {
        value: { getData: () => "0:0" }
      }
    })
    row.dispatchEvent(drop)

    assert.deepEqual(groups[0].sources, ["first.test", "second.test"])
    assert.deepEqual(calls, [["save", false]])
  })
})

function sourceGroupHost(window, groups, calls, overrides = {}) {
  return sourceRowHost(window, groups, calls, {
    listActions: () => null,
    editGroup: () => {},
    deleteGroup: () => {},
    ...overrides
  })
}

function dragEvent(window, type, values = {}) {
  const event = new window.Event(type, { bubbles: true, cancelable: true })
  Object.defineProperties(event, Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, { value }])
  ))
  return event
}

test("source group view preserves expansion state across renders", () => {
  withDom("<main></main>", (window) => {
    const root = window.document.querySelector("main")
    const groups = [
      { id: "default", name: "Default", sources: [] },
      { id: "alpha", name: "Alpha", sources: ["alpha.test"] }
    ]
    const view = new SourceGroupView(sourceGroupHost(window, groups, []))
    view.render(root)
    const alpha = root.querySelector("[data-group-id='alpha']")
    alpha.open = false
    alpha.dispatchEvent(new window.Event("toggle"))
    root.textContent = ""
    view.render(root)
    assert.equal(root.querySelector("[data-group-id='alpha']").open, false)
  })
})

test("source group title drop moves a row into an empty group", () => {
  withDom("<main></main>", (window) => {
    const root = window.document.querySelector("main")
    const groups = [
      { id: "default", name: "Default", sources: ["one.test"] },
      { id: "empty", name: "Empty", sources: [] }
    ]
    const calls = []
    new SourceGroupView(sourceGroupHost(window, groups, calls)).render(root)
    const summary = root.querySelector("[data-group-id='empty'] summary")
    summary.dispatchEvent(dragEvent(window, "drop", {
      dataTransfer: { getData: () => "0:0" }
    }))
    assert.deepEqual(groups.map((group) => group.sources), [[], ["one.test"]])
    assert.deepEqual(calls, [["save", false]])
  })
})

test("source group drag commits order and restores expanded groups", () => {
  withDom("<main></main>", (window) => {
    const root = window.document.querySelector("main")
    const groups = [
      { id: "default", name: "Default", sources: [] },
      { id: "alpha", name: "Alpha", sources: [] },
      { id: "beta", name: "Beta", sources: [] }
    ]
    const calls = []
    new SourceGroupView(sourceGroupHost(window, groups, calls)).render(root)
    const details = [...root.querySelectorAll(".structured_group")]
    details.forEach((group, index) => {
      group.open = index !== 1
      group.getBoundingClientRect = () => ({
        top: index * 20,
        bottom: index * 20 + 20,
        height: 20
      })
      group.querySelector("summary").getBoundingClientRect =
        group.getBoundingClientRect
    })
    const transfer = {
      dropEffect: "move",
      effectAllowed: "",
      setData: () => {},
      getData: () => "group:2"
    }
    details[2].querySelector(".structured_group_name").dispatchEvent(
      dragEvent(window, "dragstart", { dataTransfer: transfer })
    )
    details[1].dispatchEvent(dragEvent(window, "drop", {
      clientY: 20,
      dataTransfer: transfer
    }))
    assert.deepEqual(groups.map((group) => group.name), [
      "Default", "Beta", "Alpha"
    ])
    assert.deepEqual(calls, [["save", false]])
    assert.equal(details[1].open, false)
    assert.equal(details[2].open, true)
  })
})

test("source row ignores stale drag coordinates", () => {
  withDom("<main></main>", (window) => {
    const root = window.document.querySelector("main")
    const groups = [{ id: "default", name: "Default", sources: ["one.test"] }]
    const calls = []
    const row = renderSourceRow(
      root,
      sourceRowHost(window, groups, calls),
      "one.test",
      0,
      0,
      "source-1"
    )
    root.append(row)
    row.dispatchEvent(dragEvent(window, "drop", {
      clientY: 0,
      dataTransfer: { getData: () => "9:4" }
    }))
    assert.deepEqual(groups[0].sources, ["one.test"])
    assert.deepEqual(calls, [])
  })
})

test("source row dragleave only clears its own insertion indicator", () => {
  withDom("<main></main>", (window) => {
    const root = window.document.querySelector("main")
    const groups = [{
      id: "default",
      name: "Default",
      sources: ["one.test", "two.test"]
    }]
    const host = sourceRowHost(window, groups, [])
    const source = renderSourceRow(root, host, "one.test", 0, 0, "source-1")
    const target = renderSourceRow(root, host, "two.test", 0, 1, "source-2")
    root.append(source, target)
    target.getBoundingClientRect = () => ({
      top: 20,
      bottom: 40,
      height: 20
    })
    const transfer = { getData: () => "0:0", dropEffect: "" }

    target.dispatchEvent(dragEvent(window, "dragover", {
      clientY: 21,
      dataTransfer: transfer
    }))
    source.dispatchEvent(dragEvent(window, "dragleave"))
    assert.equal(target.classList.contains("structured_source_drop_before"), true)

    target.dispatchEvent(dragEvent(window, "dragleave"))
    assert.equal(target.classList.contains("structured_source_drop_before"), false)
  })
})
