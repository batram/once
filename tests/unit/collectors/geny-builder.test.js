const test = require("node:test")
const assert = require("node:assert/strict")
const {
  build_source,
  sanitize_selector_conf
} = require("../../../packages/collectors/dist/collectors/genyMatch")

const validConf = {
  stories: { sel: "article.story", all: true },
  link: { sel: "a.title", component: "href" },
  title: { sel: "a.title", component: "innerText", processors: ["trim"] },
  timestamp: { sel: "time", component: "dateTime" },
  tags: [{ elements: { text: { sel: ".tag", component: "innerText" } } }]
}

test("sanitizes a valid selector configuration without changing it", () => {
  assert.deepEqual(sanitize_selector_conf(validConf), validConf)
})

test("rejects configurations with unknown or malformed fields", () => {
  assert.throws(() => sanitize_selector_conf(null), /must be an object/)
  assert.throws(
    () => sanitize_selector_conf({ ...validConf, extra: { sel: "a" } }),
    /not a known field/
  )
  assert.throws(
    () => sanitize_selector_conf({ ...validConf, link: { sel: "a", onclick: "x" } }),
    /not a known selector field/
  )
  assert.throws(
    () => sanitize_selector_conf({ ...validConf, title: { sel: "a", processors: ["evil"] } }),
    /known processors/
  )
  assert.throws(
    () => sanitize_selector_conf({ ...validConf, stories: { sel: "a".repeat(501) } }),
    /short string/
  )
  assert.throws(
    () => sanitize_selector_conf({ stories: { sel: "article" } }),
    /missing stories, link, or title/
  )
  assert.throws(
    () => sanitize_selector_conf({ ...validConf, tags: [{ other: {} }] }),
    /not a known tag field/
  )
})

test("builds an object-native configured source", () => {
  const source = build_source(validConf, "https://example.com/news")
  assert.match(source.id, /^src_/)
  assert.equal(source.url, "https://example.com/news")
  assert.equal(source.collector, "geny")
  assert.deepEqual(source.select, validConf)
})

test("rejects source URLs that are not HTTP or HTTPS", () => {
  assert.throws(() => build_source(validConf, "file:///etc/passwd"), /HTTP or HTTPS/)
  assert.throws(() => build_source(validConf, "not a url"))
})
