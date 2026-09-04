const test = require("node:test")
const assert = require("node:assert/strict")

const {
  get_active,
  get_parser,
  get_parser_by_id
} = require("../../../packages/collectors/dist/registry")

/**
 * Collector ids are public persistence identifiers: they are stored in every
 * source that names its collector explicitly, and in the per-collector settings
 * to come. Renaming one silently orphans stored data, so the set is frozen here
 * and a rename has to come with an alias and a migration.
 *
 * This list is also the only enforcement there is. `get_active()` casts its
 * array to `StoryParser[]`, because each collector's `parse` takes the narrower
 * input type it actually handles, so a missing id would not be a type error.
 */
const COLLECTOR_IDS = Object.freeze([
  "geny",
  "hackernews",
  "jsonselect",
  "lobsters",
  "redditjson",
  "redditrss",
  "rss"
])

test("every collector has an id, and the set is exactly the frozen one", () => {
  const ids = get_active().map((collector) => collector.options.id)
  ids.forEach((id) => {
    assert.equal(typeof id, "string")
    assert.ok(id.length > 0, "a collector without an id cannot be referenced")
  })
  assert.equal(new Set(ids).size, ids.length, "ids must be unique")
  assert.deepEqual([...ids].sort(), [...COLLECTOR_IDS].sort())
})

test("ids are distinct even where the badge is shared", () => {
  // The two Reddit collectors deliberately share the `re` badge, which is
  // exactly why `type` cannot be used to key anything persisted.
  const byType = get_active().filter((collector) => collector.options.type === "re")
  assert.equal(byType.length, 2)
  assert.notEqual(byType[0].options.id, byType[1].options.id)
})

test("a collector can be looked up by the id a source names", () => {
  for (const id of COLLECTOR_IDS) {
    assert.equal(get_parser_by_id(id)?.options.id, id, id)
  }
  assert.equal(get_parser_by_id("nope"), undefined)
})

test("only the configurable collectors own configuration codecs", () => {
  const configurable = get_parser()
    .filter((collector) => collector.normalizeConfig)
    .map((collector) => collector.options.id)
  assert.deepEqual(configurable.sort(), ["geny", "jsonselect"])

  for (const id of configurable) {
    const collector = get_parser_by_id(id)
    assert.equal(typeof collector.serializeConfig, "function", id)
    const config = {
      stories: { sel: "items", all: true },
      link: { sel: "url" },
      title: { sel: "title" }
    }
    assert.deepEqual(collector.serializeConfig(config), config)
  }
  assert.deepEqual(
    get_parser().filter((collector) => collector.serializeConfig)
      .map((collector) => collector.options.id).sort(),
    ["geny", "jsonselect"]
  )
})

test("the configurable collectors are never detected from a URL", () => {
  // They are only ever reached by a source naming them, since their selectors
  // cannot be guessed from an address.
  for (const id of ["geny", "jsonselect"]) {
    assert.deepEqual(get_parser_by_id(id).options.pattern, [], id)
  }
})
