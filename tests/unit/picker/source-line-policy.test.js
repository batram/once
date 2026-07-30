const test = require("node:test")
const assert = require("node:assert/strict")
const {
  buildPickerConf,
  parseSourceLine,
  serializeSourceLine
} = require("../../../packages/ui-web/dist/picker/sourceLinePolicy")

function state(overrides = {}) {
  return {
    baseConf: {},
    components: new Map(),
    values: {
      stories: ".story",
      link: "a",
      title: "h2",
      timestamp: "",
      tag: "",
      ...overrides
    }
  }
}

test("builds the picker configuration with collector-compatible defaults", () => {
  assert.deepEqual(buildPickerConf(state()), {
    stories: { all: true, sel: ".story" },
    link: { component: "href", sel: "a" },
    title: { component: "innerText", processors: ["trim"], sel: "h2" }
  })
})

test("preserves hand-edited selector details while their selectors are unchanged", () => {
  const baseConf = {
    stories: { all: true, sel: ".story" },
    link: { component: "data-href", processors: ["trim"], sel: "a" },
    title: { component: "textContent", sel: "h2" },
    comment_href: { sel: ".comments", component: "href" },
    tags: [{ elements: { text: { sel: ".author", component: "textContent" } } }]
  }
  const built = buildPickerConf({
    ...state({ tag: ".author" }),
    baseConf
  })

  assert.deepEqual(built.link, baseConf.link)
  assert.deepEqual(built.title, baseConf.title)
  assert.deepEqual(built.comment_href, baseConf.comment_href)
  assert.deepEqual(built.tags, baseConf.tags)
})

test("parses and serializes source lines without losing extra configuration", () => {
  const conf = {
    stories: { all: true, sel: "li.story" },
    link: { sel: "a", component: "href" },
    title: { sel: "h2", component: "innerText", processors: ["trim"] },
    comment_href: { sel: "a.comments", component: "href" }
  }
  const line = serializeSourceLine(conf, "https://example.test/news")
  const parsed = parseSourceLine(line)

  assert.equal(parsed.warning, "")
  assert.equal(parsed.state.values.stories, "li.story")
  assert.equal(parsed.state.components.get("link"), "href")
  assert.deepEqual(parsed.state.baseConf.comment_href, conf.comment_href)
})

test("rejects malformed source lines and reports invalid selector configurations", () => {
  assert.throws(() => parseSourceLine("not a source"), /expected geny:/)
  assert.throws(
    () => parseSourceLine(serializeSourceLine([], "https://example.test")),
    /configuration must be a JSON object/
  )
  const invalid = parseSourceLine(serializeSourceLine(
    { stories: { sel: ".story" } },
    "https://example.test"
  ))
  assert.notEqual(invalid.warning, "")
})
