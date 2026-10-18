const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")
const PouchDB = require("pouchdb")
const { Story } = require("../../../packages/core/dist")
const { PouchStoryStore } = require("../../../packages/persistence/dist")

async function twoDevices(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "once-determinism-"))
  const [phone, desktop] = ["phone", "desktop"].map(name => new PouchDB(path.join(dir, name)))
  t.after(async () => {
    await Promise.all([phone.close(), desktop.close()])
    await fs.rm(dir, { recursive: true, force: true })
  })
  return { phone, desktop }
}

/** The same feed item as each device's collector builds it, keys in a different order. */
function feedItem(order) {
  const fields = {
    type: "HN",
    href: "https://example.com/article",
    title: "An article",
    comment_url: "https://news.ycombinator.com/item?id=1",
    timestamp: 1791637428000
  }
  const story = new Story(fields.type, fields.href, fields.title, fields.comment_url, fields.timestamp)
  story.tags = [{ class: "user", text: "alice", href: "https://news.ycombinator.com/submitted?id=alice" }]
  const extras = { bucket: "stories" }
  if (order === "reversed") return Object.assign(story, extras)
  const reordered = Object.assign(new Story(fields.type, fields.href, fields.title), extras)
  return Object.assign(reordered, { tags: story.tags, timestamp: story.timestamp, comment_url: story.comment_url })
}

async function exchange(left, right) {
  await left.replicate.to(right)
  await right.replicate.to(left)
}

test("two devices ingesting the same feed item replicate one revision, not a conflict", async t => {
  const { phone, desktop } = await twoDevices(t)
  const fromObj = Story.from_obj.bind(Story)
  const phoneSaved = await new PouchStoryStore(phone, fromObj).saveStory(feedItem("reversed"))
  const desktopSaved = await new PouchStoryStore(desktop, fromObj).saveStory(feedItem("natural"))
  assert.equal(phoneSaved._rev, desktopSaved._rev, "both devices mint the same first revision")

  await exchange(phone, desktop)

  for (const db of [phone, desktop]) {
    const doc = await db.get("sto_https://example.com/article", { conflicts: true })
    assert.equal(doc._conflicts, undefined)
    assert.equal(doc.ingested_at, undefined, "no device clock in the document")
  }
})

test("the same feed text on both devices stays one revision; different text still conflicts", async t => {
  const { phone, desktop } = await twoDevices(t)
  const fromObj = Story.from_obj.bind(Story)
  const withContent = (html) => {
    const story = feedItem("natural")
    story.attachContent(html, { source: "feed", saved_at: story.timestamp })
    return story
  }
  await new PouchStoryStore(phone, fromObj).saveStory(withContent("<p>Same text</p>"))
  await new PouchStoryStore(desktop, fromObj).saveStory(withContent("<p>Same text</p>"))
  await exchange(phone, desktop)
  const same = await phone.get("sto_https://example.com/article", { conflicts: true })
  assert.equal(same._conflicts, undefined)

  const other = await twoDevices(t)
  await new PouchStoryStore(other.phone, fromObj).saveStory(withContent("<p>Phone text</p>"))
  await new PouchStoryStore(other.desktop, fromObj).saveStory(withContent("<p>Desktop text</p>"))
  const history = async (db) => (await db.get("sto_https://example.com/article", { revs: true }))._revisions.ids
  const [phoneHistory, desktopHistory] = [await history(other.phone), await history(other.desktop)]
  // The first revision includes both content and its fingerprint on every platform.
  assert.equal(phoneHistory.length, 1, "content and metadata are committed atomically")
  assert.notEqual(phoneHistory[0], desktopHistory[0], "different html never shares a revision id")
  await exchange(other.phone, other.desktop)
  const merged = await other.phone.get("sto_https://example.com/article", { conflicts: true })
  assert.equal(merged._conflicts?.length, 1, "a real difference is a visible conflict, not silent divergence")
})
