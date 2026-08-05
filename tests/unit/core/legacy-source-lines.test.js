const test = require("node:test")
const assert = require("node:assert/strict")

const {
  LEGACY_SEPARATOR,
  LEGACY_SOURCES_DOC_ID,
  canonicalLegacySourceLines,
  convertLegacySourceLines,
  legacySourceDigest,
  readLegacySourceLine
} = require("../../../packages/core/dist/settings/legacySourceLines")
const {
  SOURCES_SCHEMA_VERSION,
  groupedStorySources,
  isStorySourceGroupId,
  isStorySourceId,
  repairStorySources
} = require("../../../packages/core/dist/settings/storySource")
const { defaultSources } = require("../../../packages/core/dist/settings/defaults")

const sep = LEGACY_SEPARATOR

function genyLine(config, url) {
  return `geny:${sep}${JSON.stringify(config)}${sep}${url}`
}

const SELECTORS = { stories: { sel: "article" }, link: { sel: "a" }, title: { sel: "h2" } }

test("canonical lines trim both ends and drop blanks", () => {
  // Both ends, because that is what the live parsers do — a digest that only
  // stripped trailing space would disagree with how the line is interpreted.
  assert.deepEqual(
    canonicalLegacySourceLines(["  https://a.test/  ", "", "   ", "\thttps://b.test/"]),
    ["https://a.test/", "https://b.test/"]
  )
})

test("the digest ignores newline style and stray whitespace", () => {
  const digest = legacySourceDigest(["*news", "https://a.test/"])
  assert.equal(legacySourceDigest(["*news  ", "  https://a.test/"]), digest)
  assert.equal(legacySourceDigest(["*news\r\nhttps://a.test/"]), digest)
  assert.equal(legacySourceDigest(["*news\rhttps://a.test/"]), digest)
  assert.equal(legacySourceDigest(["*news", "", "https://a.test/", ""]), digest)
  // But a real change changes it, which is what detects a post-cutover edit.
  assert.notEqual(legacySourceDigest(["*news", "https://b.test/"]), digest)
  assert.match(digest, /^[0-9a-f]{8}$/)
})

test("a legacy list converts to groups and sources", () => {
  const { doc, reports } = convertLegacySourceLines([
    "https://news.ycombinator.com/",
    "*security",
    "https://old.reddit.com/r/netsec/.rss",
    genyLine(SELECTORS, "https://two.test/")
  ])

  assert.deepEqual(reports, [])
  assert.equal(doc.version, SOURCES_SCHEMA_VERSION)
  assert.equal(doc.migratedFrom.docId, LEGACY_SOURCES_DOC_ID)
  assert.match(doc.migratedFrom.digest, /^[0-9a-f]{8}$/)

  // The line before any header is in the implicit Default group.
  assert.equal("groupId" in doc.sources[0], false)
  assert.equal(doc.sources[0].url, "https://news.ycombinator.com/")
  assert.equal("collector" in doc.sources[0], false, "detected from the url later")

  assert.equal(doc.groups.length, 1)
  assert.equal(doc.groups[0].name, "security")
  assert.equal(doc.sources[1].groupId, doc.groups[0].id)

  // The §§ hack becomes a field, and the url stops carrying a config.
  assert.equal(doc.sources[2].collector, "geny")
  assert.equal(doc.sources[2].url, "https://two.test/")
  assert.deepEqual(doc.sources[2].select, SELECTORS)
})

test("a converted list is valid to the reader that will store it", () => {
  const { doc } = convertLegacySourceLines([
    "*news",
    "https://a.test/",
    genyLine(SELECTORS, "https://two.test/")
  ])
  const reread = repairStorySources(doc)
  assert.equal(reread.ok, true)
  assert.deepEqual(reread.reports, [], "conversion must not need repairing")
  assert.deepEqual(reread.doc, doc)
  doc.sources.forEach((source) => assert.ok(isStorySourceId(source.id), source.id))
  doc.groups.forEach((group) => assert.ok(isStorySourceGroupId(group.id), group.id))
})

test("the shipped defaults convert cleanly", () => {
  const { doc, reports } = convertLegacySourceLines(defaultSources)
  assert.deepEqual(reports, [])
  assert.equal(doc.sources.length, defaultSources.length)
  assert.deepEqual(doc.groups, [], "the defaults use no groups")
  assert.deepEqual(
    doc.sources.map((source) => source.url),
    [...defaultSources]
  )
  assert.equal(repairStorySources(doc).ok, true)
})

test("two conversions of the same list agree on every id", () => {
  // The whole reason ids are derived rather than random: two devices converting
  // independently must not end up syncing the same sources as different ones.
  const lines = ["*news", "https://a.test/", "https://b.test/", "*news", "https://c.test/"]
  const first = convertLegacySourceLines(lines)
  const second = convertLegacySourceLines([...lines])
  assert.deepEqual(second.doc, first.doc)

  // A duplicate header name still yields two distinct groups.
  assert.equal(first.doc.groups.length, 2)
  assert.notEqual(first.doc.groups[0].id, first.doc.groups[1].id)
  assert.deepEqual(first.doc.groups.map((group) => group.name), ["news", "news"])
})

test("ids survive an unrelated line being added elsewhere", () => {
  // Counting identical lines rather than absolute position is what buys this,
  // and it matters because two devices may convert lists that differ slightly.
  const before = convertLegacySourceLines(["https://a.test/", "https://b.test/"])
  const after = convertLegacySourceLines([
    "https://a.test/",
    "https://inserted.test/",
    "https://b.test/"
  ])
  const idFor = (result, url) =>
    result.doc.sources.find((source) => source.url === url).id
  assert.equal(idFor(after, "https://a.test/"), idFor(before, "https://a.test/"))
  assert.equal(idFor(after, "https://b.test/"), idFor(before, "https://b.test/"))
})

test("duplicate lines get their own ids", () => {
  const { doc } = convertLegacySourceLines(["https://a.test/", "https://a.test/"])
  assert.equal(doc.sources.length, 2, "duplicates are legal and stay separate")
  assert.notEqual(doc.sources[0].id, doc.sources[1].id)
})

test("an empty group header survives conversion", () => {
  const { doc } = convertLegacySourceLines(["*news", "*security", "https://a.test/"])
  const grouped = groupedStorySources(doc)
  assert.equal(doc.groups.length, 2)
  assert.deepEqual(grouped[1].sources, [], "news keeps no sources but still exists")
  assert.equal(grouped[2].sources.length, 1)
  // A bare `*` was a legal header with an empty name.
  const bare = convertLegacySourceLines(["*", "https://a.test/"])
  assert.equal(bare.doc.groups[0].name, "")
})

test("a malformed configurable source is reported, not dropped in silence", () => {
  const { doc, reports } = convertLegacySourceLines([
    "https://a.test/",
    `geny:${sep}{not json${sep}https://b.test/`,
    `json:${sep}{"stories":{"sel":"items"}}`,
    `geny:${sep}{}${sep}`
  ])
  assert.deepEqual(doc.sources.map((source) => source.url), ["https://a.test/"])
  assert.equal(reports.length, 3)
  assert.match(reports[0].path, /^line 2$/)
  assert.match(reports[0].message, /unreadable selector configuration/)
  assert.match(reports[1].message, /no selector configuration/)
  assert.match(reports[2].message, /no URL/)
  // Every report carries the line, so nothing is lost invisibly.
  reports.forEach((report) => assert.match(report.message, /geny:|json:/))
})

test("a url containing the separator is not truncated", () => {
  // The old builder refused to emit one, but a hand-written line was unchecked,
  // and the old resolver would have cut the url short.
  const parsed = readLegacySourceLine(genyLine(SELECTORS, `https://a.test/${sep}x`))
  assert.equal(parsed.url, `https://a.test/${sep}x`)
})

test("a plain line stays a plain url", () => {
  assert.deepEqual(readLegacySourceLine("https://a.test/"), { url: "https://a.test/" })
  // Not a URL at all is still converted: the runtime already reports the
  // no-handler case, and dropping it here would lose the entry silently.
  assert.deepEqual(readLegacySourceLine("nonsense"), { url: "nonsense" })
})

test("the json form maps to the jsonselect collector", () => {
  const config = { stories: { sel: "items", all: true } }
  const parsed = readLegacySourceLine(
    `json:${sep}${JSON.stringify(config)}${sep}https://a.test/feed.json`
  )
  assert.equal(parsed.collector, "jsonselect")
  assert.equal(parsed.url, "https://a.test/feed.json")
  assert.deepEqual(parsed.select, config)
})
