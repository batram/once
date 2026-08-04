const test = require("node:test")
const assert = require("node:assert/strict")
const { parseHTML } = require("linkedom")

const SHELL = `
  <div id="selected_container"></div>
  <div id="stories"></div>
  <div id="global_search_results"></div>
  <div id="filtered_stories"></div>
`

// StoryCursor only ever touches dataset.href, classList, tabIndex and focus on
// a row, so plain elements stand in for the real custom element. The heavy
// StoryListItem is exercised by its own tests.
function addRow(window, container, href, classes = []) {
  const row = window.document.createElement("story-item")
  row.classList.add("story", ...classes)
  row.dataset.href = href
  row.setAttribute("tabindex", "-1")
  row.focus = function focus() {
    Object.defineProperty(window.document, "activeElement", {
      value: this,
      configurable: true
    })
  }
  container.append(row)
  return row
}

function withShell(run) {
  const { window } = parseHTML(`<body>${SHELL}</body>`)
  const previous = {
    document: globalThis.document,
    getComputedStyle: globalThis.getComputedStyle,
    MutationObserver: globalThis.MutationObserver
  }
  globalThis.document = window.document
  // linkedom has neither of these; the cursor needs display resolution and the
  // observer only to re-apply its marker after a rebuild.
  globalThis.getComputedStyle = () => ({ display: "block" })
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  }
  try {
    const { StoryCursor } = require("../../../packages/ui-web/dist/story/storyCursor")
    return run({ window, StoryCursor })
  } finally {
    globalThis.document = previous.document
    globalThis.getComputedStyle = previous.getComputedStyle
    globalThis.MutationObserver = previous.MutationObserver
  }
}

function hrefsWithCursor(window) {
  return Array.from(window.document.querySelectorAll("story-item.cursor"))
    .map((row) => row.dataset.href)
}

test("the cursor enters at the top and moves by rows", () => {
  withShell(({ window, StoryCursor }) => {
    const stories = window.document.querySelector("#stories")
    addRow(window, stories, "a")
    addRow(window, stories, "b")
    addRow(window, stories, "c")
    const cursor = new StoryCursor()

    cursor.moveBy(1)
    assert.deepEqual(hrefsWithCursor(window), ["a"])
    cursor.moveBy(1)
    assert.deepEqual(hrefsWithCursor(window), ["b"])
    cursor.moveBy(-1)
    assert.deepEqual(hrefsWithCursor(window), ["a"])
    // The ends hold rather than wrapping.
    cursor.moveBy(-1)
    assert.deepEqual(hrefsWithCursor(window), ["a"])
    cursor.moveBy(5)
    assert.deepEqual(hrefsWithCursor(window), ["c"])
  })
})

test("the cursor row is the list's only tab stop", () => {
  withShell(({ window, StoryCursor }) => {
    const stories = window.document.querySelector("#stories")
    const first = addRow(window, stories, "a")
    const second = addRow(window, stories, "b")
    const cursor = new StoryCursor()

    cursor.moveBy(1)
    assert.equal(first.getAttribute("tabindex"), "0")
    assert.equal(first.getAttribute("aria-current"), "true")

    cursor.moveBy(1)
    assert.equal(second.getAttribute("tabindex"), "0")
    assert.equal(first.getAttribute("tabindex"), "-1")
    assert.equal(first.hasAttribute("aria-current"), false)
    assert.equal(window.document.activeElement, second)
  })
})

test("the cursor survives a row being replaced wholesale", () => {
  withShell(({ window, StoryCursor }) => {
    const stories = window.document.querySelector("#stories")
    addRow(window, stories, "a")
    const old = addRow(window, stories, "b")
    const cursor = new StoryCursor()
    cursor.moveBy(1)
    cursor.moveBy(1)
    assert.deepEqual(hrefsWithCursor(window), ["b"])

    // What storyList.refilter() does: a brand new element for the same story.
    old.remove()
    const replacement = addRow(window, stories, "b")
    cursor.refresh()
    assert.equal(replacement.classList.contains("cursor"), true)
    assert.equal(replacement.getAttribute("tabindex"), "0")
  })
})

test("the cursor follows its story when the list is re-sorted", () => {
  withShell(({ window, StoryCursor }) => {
    const stories = window.document.querySelector("#stories")
    addRow(window, stories, "a")
    const moved = addRow(window, stories, "b")
    addRow(window, stories, "c")
    const cursor = new StoryCursor()
    cursor.moveBy(1)
    cursor.moveBy(1)
    assert.deepEqual(hrefsWithCursor(window), ["b"])

    // sortStories() reparents the row; the cursor tracks the story, not a slot.
    stories.append(moved)
    assert.equal(cursor.current().dataset.href, "b")
    cursor.moveBy(-1)
    assert.deepEqual(hrefsWithCursor(window), ["c"])
  })
})

test("a vanished row resumes from where it used to be", () => {
  withShell(({ window, StoryCursor }) => {
    const stories = window.document.querySelector("#stories")
    addRow(window, stories, "a")
    const skipped = addRow(window, stories, "b")
    addRow(window, stories, "c")
    const cursor = new StoryCursor()
    cursor.moveBy(1)
    cursor.moveBy(1)
    assert.deepEqual(hrefsWithCursor(window), ["b"])

    // Skipping a story can hide it from the visible set entirely.
    skipped.classList.add("nomatch")
    assert.equal(cursor.current(), null)
    cursor.moveBy(1)
    assert.deepEqual(hrefsWithCursor(window), ["c"])
  })
})

test("rows hidden by search or filtering are skipped over", () => {
  withShell(({ window, StoryCursor }) => {
    const stories = window.document.querySelector("#stories")
    addRow(window, stories, "a")
    addRow(window, stories, "b", ["nomatch"])
    addRow(window, stories, "c", ["filtered"])
    addRow(window, stories, "d")
    const cursor = new StoryCursor()

    cursor.moveBy(1)
    cursor.moveBy(1)
    assert.deepEqual(hrefsWithCursor(window), ["d"])
  })
})

test("the duplicate row in #selected_container is never the cursor", () => {
  withShell(({ window, StoryCursor }) => {
    const stories = window.document.querySelector("#stories")
    // mountOnceUi mirrors the open story into #selected_container, so the same
    // href exists twice; only the list copy may carry the cursor.
    addRow(window, window.document.querySelector("#selected_container"), "a")
    addRow(window, stories, "a")
    const cursor = new StoryCursor()

    cursor.moveBy(1)
    const marked = window.document.querySelectorAll("story-item.cursor")
    assert.equal(marked.length, 1)
    assert.equal(marked[0].parentElement.id, "stories")
  })
})

test("the cursor follows a global search into its own bucket", () => {
  withShell(({ window, StoryCursor }) => {
    const results = window.document.querySelector("#global_search_results")
    addRow(window, window.document.querySelector("#stories"), "a")
    addRow(window, results, "g1")
    addRow(window, results, "g2")
    results.classList.add("search-visible")
    const cursor = new StoryCursor()

    cursor.moveBy(1)
    cursor.moveBy(1)
    assert.deepEqual(hrefsWithCursor(window), ["g2"])
  })
})

test("selectHref moves onto a named story and ignores unknown ones", () => {
  withShell(({ window, StoryCursor }) => {
    const stories = window.document.querySelector("#stories")
    addRow(window, stories, "a")
    addRow(window, stories, "b")
    addRow(window, stories, "c")
    const cursor = new StoryCursor()

    cursor.selectHref("c")
    assert.deepEqual(hrefsWithCursor(window), ["c"])
    // A story that is not on screen leaves the cursor alone.
    cursor.selectHref("https://elsewhere.example/story")
    assert.deepEqual(hrefsWithCursor(window), ["c"])
  })
})

test("clicking a story adopts it as the cursor without stealing focus", () => {
  withShell(({ window, StoryCursor }) => {
    const stories = window.document.querySelector("#stories")
    addRow(window, stories, "a")
    const second = addRow(window, stories, "b")
    const title = window.document.createElement("a")
    second.append(title)
    const mirrored = addRow(
      window,
      window.document.querySelector("#selected_container"),
      "a"
    )
    const cursor = new StoryCursor()
    cursor.mount()

    // A click on something inside the row still adopts the row itself.
    title.dispatchEvent(new window.Event("click", { bubbles: true }))
    assert.deepEqual(hrefsWithCursor(window), ["b"])
    assert.equal(second.getAttribute("tabindex"), "0")
    // The click already aimed focus, often at a link about to open.
    assert.notEqual(window.document.activeElement, second)

    // The mirror in #selected_container is not part of the list.
    mirrored.dispatchEvent(new window.Event("click", { bubbles: true }))
    assert.deepEqual(hrefsWithCursor(window), ["b"])
  })
})

test("an empty list is a no-op rather than a crash", () => {
  withShell(({ StoryCursor }) => {
    const cursor = new StoryCursor()
    assert.doesNotThrow(() => cursor.moveBy(1))
    assert.equal(cursor.current(), null)
    let ran = false
    cursor.run(() => { ran = true })
    assert.equal(ran, false)
  })
})
