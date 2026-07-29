const test = require("node:test")
const assert = require("node:assert/strict")
const {
  build_source,
  sanitize_selector_conf,
  resolve_url
} = require("../../../packages/collectors/dist/collectors/genyMatch")

const separator = "§§"

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

test("builds a geny source line that resolves back to the page URL", () => {
  const source = build_source(validConf, "https://example.com/news")
  const parts = source.split(separator)
  assert.equal(parts.length, 3)
  assert.equal(parts[0], "geny:")
  assert.deepEqual(JSON.parse(parts[1]), validConf)
  assert.equal(resolve_url(source), "https://example.com/news")
})

test("rejects source URLs that are not HTTP or HTTPS", () => {
  assert.throws(() => build_source(validConf, "file:///etc/passwd"), /HTTP or HTTPS/)
  assert.throws(() => build_source(validConf, "not a url"))
})

test("rejects configurations containing the source separator", () => {
  const conf = {
    ...validConf,
    stories: { sel: `article${separator}.story` }
  }
  assert.throws(() => build_source(conf, "https://example.com/"), /separator/)
})
