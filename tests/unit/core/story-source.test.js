const test = require("node:test")
const assert = require("node:assert/strict")

const {
  DEFAULT_GROUP_ID,
  MAX_CACHE_MINUTES,
  SOURCES_SCHEMA_VERSION,
  emptyStorySourceDocument,
  enabledStorySources,
  groupedStorySources,
  isCacheMinutes,
  isStorySourceGroupId,
  isStorySourceId,
  mintStorySourceGroupId,
  mintStorySourceId,
  parseStorySources,
  readCacheMinutesInput,
  reconcileStorySources,
  repairStorySources
} = require("../../../packages/core/dist/settings/storySource")

// Sequential so a failure names the entry it came from, and so no test depends
// on randomness. Long enough to satisfy the id grammar's minimum.
function counter(prefix = "aaaaaaa") {
  let next = 0
  return () => `${prefix}${next++}`
}

function doc(overrides = {}) {
  return { ...emptyStorySourceDocument(), ...overrides }
}

test("ids are prefixed, and only their own kind passes", () => {
  const source = mintStorySourceId(counter())
  const group = mintStorySourceGroupId(counter())
  assert.ok(isStorySourceId(source), source)
  assert.ok(isStorySourceGroupId(group), group)
  // The two keyspaces do not overlap: a group id in a source field is a bug
  // worth catching, not a value to coerce.
  assert.equal(isStorySourceId(group), false)
  assert.equal(isStorySourceGroupId(source), false)
  // The grammar's minimum exists so a short derived hash cannot slip through.
  assert.equal(isStorySourceId("src_1234567"), false)
  assert.equal(isStorySourceId("src_12345678"), true)
  assert.equal(isStorySourceId("group_default"), false)
})

test("cache minutes accept zero but refuse anything unrepresentable", () => {
  assert.ok(isCacheMinutes(0), "zero means always refetch")
  assert.ok(isCacheMinutes(MAX_CACHE_MINUTES))
  for (const value of [-1, 1.5, MAX_CACHE_MINUTES + 1, "4", NaN, null, undefined]) {
    assert.equal(isCacheMinutes(value), false, String(value))
  }
})

test("a strict read refuses rather than repairing", () => {
  const rejected = parseStorySources(doc({
    sources: [{ id: "nope", url: "https://a.test/" }]
  }), { mintId: counter() })
  assert.equal(rejected.ok, false)
  assert.match(rejected.reports[0].path, /^sources\[0\]\.id$/)

  const accepted = parseStorySources(doc({
    sources: [{ id: "src_12345678", url: "  https://a.test/  " }]
  }))
  assert.equal(accepted.ok, true)
  assert.deepEqual(accepted.reports, [])
  assert.equal(accepted.doc.sources[0].url, "https://a.test/")
})

test("a tolerant read repairs, and says what it repaired", () => {
  const repaired = repairStorySources(doc({
    sources: [
      { id: "nope", url: "https://a.test/" },
      { id: "src_12345678", url: "https://b.test/", cacheMinutes: -3 },
      { id: "src_12345678", url: "https://c.test/" },
      { url: "" },
      "not an object"
    ]
  }), { mintId: counter() })

  assert.equal(repaired.ok, true)
  // The unusable pair is dropped; everything else survives with a fresh id.
  assert.deepEqual(
    repaired.doc.sources.map((source) => source.url),
    ["https://a.test/", "https://b.test/", "https://c.test/"]
  )
  const ids = repaired.doc.sources.map((source) => source.id)
  assert.equal(new Set(ids).size, 3, "a duplicate id is re-minted, never shared")
  ids.forEach((id) => assert.ok(isStorySourceId(id), id))
  // Out of range means inherit, which is absence rather than zero.
  assert.equal("cacheMinutes" in repaired.doc.sources[1], false)
  // One per fault: the bad id, the out-of-range window, the duplicate id, the
  // urlless entry, and the entry that was not an object at all.
  assert.equal(repaired.reports.length, 5)
})

test("an unsupported schema version is refused by both readers", () => {
  for (const read of [parseStorySources, repairStorySources]) {
    const result = read({ version: 99, groups: [], sources: [] })
    assert.equal(result.ok, false, read.name)
    assert.match(result.reports[0].message, /unsupported schema version 99/)
  }
  // Repairing a future record would mean rewriting it without the fields this
  // build cannot see, so refusing is the only safe answer.
  assert.equal(parseStorySources(undefined).ok, false)
  assert.equal(parseStorySources([]).ok, false)
})

test("the Default group is implicit and never stored", () => {
  const stored = repairStorySources(doc({
    groups: [{ id: DEFAULT_GROUP_ID, name: "Default" }],
    sources: []
  }))
  assert.equal(stored.doc.groups.length, 0)
  assert.match(stored.reports[0].message, /implicit/)

  const grouped = groupedStorySources(doc({
    groups: [{ id: "grp_11111111", name: "news" }],
    sources: [
      { id: "src_11111111", url: "https://a.test/" },
      { id: "src_22222222", url: "https://b.test/", groupId: "grp_11111111" }
    ]
  }))
  // Default first and always present, so the editor always has a drop target.
  assert.deepEqual(grouped.map((group) => group.id), [DEFAULT_GROUP_ID, "grp_11111111"])
  assert.deepEqual(grouped[0].sources.map((source) => source.id), ["src_11111111"])
  assert.deepEqual(grouped[1].sources.map((source) => source.id), ["src_22222222"])
})

test("an empty group survives, and duplicate names stay distinct", () => {
  const grouped = groupedStorySources(doc({
    groups: [
      { id: "grp_11111111", name: "news" },
      { id: "grp_22222222", name: "news" }
    ],
    sources: [{ id: "src_11111111", url: "https://a.test/", groupId: "grp_22222222" }]
  }))
  assert.equal(grouped.length, 3)
  assert.deepEqual(grouped[1].sources, [], "an empty group is not dropped")
  assert.equal(grouped[2].sources.length, 1)
})

test("a dangling group reference is moved to Default, never left dangling", () => {
  const repaired = repairStorySources(doc({
    groups: [],
    sources: [{ id: "src_11111111", url: "https://a.test/", groupId: "grp_99999999" }]
  }))
  assert.equal(repaired.ok, true)
  assert.equal("groupId" in repaired.doc.sources[0], false)
  assert.match(repaired.reports[0].message, /moved to Default/)
  // Strict refuses instead, because the user wrote that reference themselves.
  assert.equal(parseStorySources(doc({
    groups: [],
    sources: [{ id: "src_11111111", url: "https://a.test/", groupId: "grp_99999999" }]
  })).ok, false)
})

test("a group without a usable id is refused, never re-minted", () => {
  // Minting one would orphan every source pointing at the old value.
  const repaired = repairStorySources(doc({
    groups: [{ id: "news", name: "news" }],
    sources: []
  }), { mintId: counter() })
  assert.equal(repaired.doc.groups.length, 0)
  assert.match(repaired.reports[0].message, /not a group id/)
})

test("disabled sources are excluded from what can produce stories", () => {
  const sources = enabledStorySources(doc({
    sources: [
      { id: "src_11111111", url: "https://a.test/" },
      { id: "src_22222222", url: "https://b.test/", enabled: true },
      { id: "src_33333333", url: "https://c.test/", enabled: false }
    ]
  }))
  assert.deepEqual(sources.map((source) => source.id), ["src_11111111", "src_22222222"])
})

test("reading is idempotent", () => {
  const once = repairStorySources(doc({
    groups: [{ id: "grp_11111111", name: "news" }],
    sources: [
      { id: "src_11111111", url: "https://a.test/", groupId: "grp_11111111" },
      { id: "src_22222222", url: "https://b.test/", cacheMinutes: 0, enabled: false }
    ]
  }), { mintId: counter() })
  const twice = repairStorySources(once.doc, { mintId: counter() })
  assert.deepEqual(twice.doc, once.doc)
  assert.deepEqual(twice.reports, [])
})

test("an import keeps the id and the settings of the source it matches", () => {
  const existing = [
    {
      id: "src_11111111",
      url: "https://a.test/",
      label: "Alpha",
      cacheMinutes: 5,
      groupId: "grp_11111111"
    },
    { id: "src_22222222", url: "https://b.test/" }
  ]
  // What pasting a bare URL list produces: urls and nothing else.
  const { sources, reports } = reconcileStorySources(
    [{ id: "", url: "https://a.test/" }, { id: "", url: "https://new.test/" }],
    existing,
    { mintId: counter() }
  )
  assert.deepEqual(reports, [])
  assert.equal(sources[0].id, "src_11111111")
  assert.equal(sources[0].label, "Alpha")
  assert.equal(sources[0].cacheMinutes, 5)
  assert.equal(sources[0].groupId, "grp_11111111")
  // Absent from the import means inherit; a dropped source is simply gone.
  assert.ok(isStorySourceId(sources[1].id))
  assert.equal(sources.length, 2)
})

test("a supplied id wins over matching by url", () => {
  const existing = [
    { id: "src_11111111", url: "https://a.test/", label: "Alpha" },
    { id: "src_22222222", url: "https://b.test/", label: "Beta" }
  ]
  // The url moved from one source to the other; ids say which is which.
  const { sources } = reconcileStorySources(
    [{ id: "src_22222222", url: "https://a.test/" }],
    existing,
    { mintId: counter() }
  )
  assert.equal(sources[0].id, "src_22222222")
  assert.equal(sources[0].label, "Beta")
})

test("pairing duplicates is positional, and says so", () => {
  const existing = [
    { id: "src_11111111", url: "https://a.test/", cacheMinutes: 5 },
    { id: "src_22222222", url: "https://a.test/", cacheMinutes: 90 }
  ]
  const { sources, reports } = reconcileStorySources(
    [{ id: "", url: "https://a.test/" }, { id: "", url: "https://a.test/" }],
    existing,
    { mintId: counter() }
  )
  assert.deepEqual(sources.map((source) => source.id), ["src_11111111", "src_22222222"])
  assert.deepEqual(sources.map((source) => source.cacheMinutes), [5, 90])
  // Only the first is a guess; by the second there is nothing left to choose.
  assert.equal(reports.length, 1)
  assert.match(reports[0].message, /appears more than once; paired with src_11111111/)
})

test("an import never emits a duplicate or an unusable id", () => {
  const { sources } = reconcileStorySources(
    [
      { id: "src_11111111", url: "https://a.test/" },
      { id: "src_11111111", url: "https://b.test/" },
      { id: "junk", url: "https://c.test/" }
    ],
    [{ id: "src_11111111", url: "https://a.test/" }],
    { mintId: counter() }
  )
  const ids = sources.map((source) => source.id)
  assert.equal(new Set(ids).size, 3)
  ids.forEach((id) => assert.ok(isStorySourceId(id), id))
  assert.equal(ids[0], "src_11111111", "the first claim keeps it")
})

test("the schema version is what the readers accept", () => {
  assert.equal(SOURCES_SCHEMA_VERSION, 2)
  assert.equal(emptyStorySourceDocument().version, SOURCES_SCHEMA_VERSION)
})

test("a typed cache window is read, not coerced", () => {
  assert.deepEqual(readCacheMinutesInput(""), { ok: true })
  assert.deepEqual(readCacheMinutesInput("   "), { ok: true }, "blank inherits")
  assert.deepEqual(readCacheMinutesInput("0"), { ok: true, minutes: 0 })
  assert.deepEqual(readCacheMinutesInput(" 45 "), { ok: true, minutes: 45 })
  assert.deepEqual(
    readCacheMinutesInput(String(MAX_CACHE_MINUTES)),
    { ok: true, minutes: MAX_CACHE_MINUTES }
  )
  for (const rejected of [
    "-5",
    "5.5",
    "1e3",
    "45 minutes",
    "abc",
    String(MAX_CACHE_MINUTES + 1)
  ]) {
    assert.deepEqual(readCacheMinutesInput(rejected), { ok: false }, rejected)
  }
})
