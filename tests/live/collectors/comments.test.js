// Live probes of the comment readers: one current thread per site, read the
// way the app reads it. Excluded from normal runs like the source probes.
const test = require("node:test")
const assert = require("node:assert/strict")
const { installDomGlobals } = require("../../helpers/dom")
const { comments_provider_for } = require("../../../packages/collectors/dist")

installDomGlobals()

const TIMEOUT_MS = 20_000
const headers = { "user-agent": "once-collector-compatibility-check/1.0 (manual single-request probe)" }
const io = () => ({ fetch: (url, init = {}) => fetch(url, { ...init, headers }), signal: AbortSignal.timeout(TIMEOUT_MS) })

async function json(url) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
  assert.ok(response.ok, `${url} answered ${response.status}`)
  return response.json()
}

function assertThread(thread) {
  assert.ok(thread.total > 0, "the thread has comments")
  const walk = nodes => nodes.forEach(node => {
    assert.ok(node.id, "every comment has an id")
    assert.match(node.permalink, /^https:\/\//)
    assert.ok(node.removed || node.html.length > 0, `comment ${node.id} has a body`)
    assert.ok(node.removed || node.time > 0, `comment ${node.id} has a time`)
    walk(node.children)
  })
  walk(thread.comments)
}

test("live Hacker News thread reads through Algolia", async () => {
  const front = await json("https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=10")
  const hit = front.hits.find(item => item.num_comments > 5)
  assert.ok(hit, "a front-page story with comments")
  const url = `https://news.ycombinator.com/item?id=${hit.objectID}`
  assertThread(await comments_provider_for(url).comments.load(url, io()))
})

test("live Lobsters thread reads from its JSON", async () => {
  const hottest = await json("https://lobste.rs/hottest.json")
  const story = hottest.find(item => item.comment_count > 3)
  assert.ok(story, "a hot story with comments")
  assertThread(await comments_provider_for(story.comments_url).comments.load(story.comments_url, io()))
})

test("live Reddit thread reads, or asks for a signed-in user", async (t) => {
  const url = "https://old.reddit.com/r/netsec/comments/1/"
  try {
    const thread = await comments_provider_for(url).comments.load(url, io())
    assert.equal(thread.provider, "redditjson")
  } catch (error) {
    // Anonymous readers are sent to the login page; without a session that is the expected answer.
    if (error.name === "CommentsAuthError" || error.name === "CommentsNotFoundError") {
      t.skip(`Reddit unavailable anonymously: ${error.message}`)
      return
    }
    throw error
  }
})
