const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const { parseDocument } = require("../../helpers/dom")
const { assertStories } = require("../../helpers/collector-contract")

const separator = "§§"

test("parses configured JSON selectors, processors, tags, and URLs", () => {
  const collector = require("../../../packages/collectors/dist/collectors/jsonSelect")
  const input = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../fixtures/collectors/generic.json"), "utf8"))
  const config = { stories: { sel: "items", all: true }, link: { sel: "href" }, title: { sel: "title", processors: ["trim"] }, timestamp: { sel: "published" }, tags: [{ elements: { class: { sel: "kind" }, text: { sel: "author" } } }] }
  const source = `json:${separator}${JSON.stringify(config)}${separator}https://example.com/feed.json`
  const stories = collector.parse(input, "https://example.com/feed.json", source)
  assertStories(stories, "JX")
  assert.equal(stories[0].title, "JSON title")
  assert.equal(stories[0].tags[0].text, "alice")
  assert.equal(collector.resolve_url(source), "https://example.com/feed.json")
  assert.deepEqual(collector.parse(input, "", "json:bad"), [])
})

test("parses configured HTML selectors and skips invalid configuration", () => {
  const collector = require("../../../packages/collectors/dist/collectors/genyMatch")
  const doc = parseDocument(fs.readFileSync(path.resolve(__dirname, "../../fixtures/collectors/generic.html"), "utf8"))
  const config = { stories: { sel: "article", all: true }, link: { sel: ".link", component: "href" }, title: { sel: ".link", component: "innerText", processors: ["trim"] }, tags: [{ elements: { text: { sel: ".tag", component: "innerText" } } }] }
  const source = `geny:${separator}${JSON.stringify(config)}${separator}https://example.com/`
  const stories = collector.parse(doc, "https://example.com/", source)
  assertStories(stories, "GY")
  assert.equal(stories[0].title, "Generic title")
  assert.equal(stories[0].tags[0].text, "tools")
  assert.deepEqual(collector.parse(doc, "", "geny:bad"), [])
})

test("applies an empty geny fallback before title processors", () => {
  const collector = require("../../../packages/collectors/dist/collectors/genyMatch")
  const doc = parseDocument(
    '<!doctype html><html><body><article><h2><a href="https://example.com/owner/repo">Repo</a></h2></article></body></html>'
  )
  const config = {
    stories: { sel: "article", all: true },
    link: { sel: "h2 a", component: "href" },
    title: {
      sel: "p.missing",
      component: "innerText",
      processors: ["trim", "show_path"],
      fallback: ""
    }
  }
  const source = `geny:${separator}${JSON.stringify(config)}${separator}https://example.com/`

  const stories = collector.parse(doc, "https://example.com/", source)

  assert.equal(stories[0].title, "[owner/repo] ")
})

test("reports which required geny selector is empty", () => {
  const collector = require("../../../packages/collectors/dist/collectors/genyMatch")
  const doc = parseDocument(
    "<!doctype html><html><body><article></article></body></html>"
  )
  const source = (link, title) =>
    `geny:${separator}${JSON.stringify({
      stories: { sel: "article", all: true },
      link,
      title
    })}${separator}https://example.com/`

  assert.throws(
    () => collector.parse(doc, "", source({ sel: ".missing" }, { fallback: "title" })),
    /link selector produced an empty value/
  )
  assert.throws(
    () => collector.parse(doc, "", source({ fallback: "https://example.com" }, { sel: ".missing" })),
    /title selector produced an empty value/
  )
})

test("rejects malformed configurable-source JSON", () => {
  const jsonCollector = require("../../../packages/collectors/dist/collectors/jsonSelect")
  const htmlCollector = require("../../../packages/collectors/dist/collectors/genyMatch")
  const doc = parseDocument("<main></main>")

  assert.throws(
    () => jsonCollector.parse({}, "", `json:${separator}{bad${separator}https://example.com/feed.json`),
    /json_select config is invalid JSON/
  )
  assert.throws(
    () => htmlCollector.parse(doc, "", `geny:${separator}{bad${separator}https://example.com/`),
    /geny_match config is invalid JSON/
  )
})
