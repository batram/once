require("../../helpers/dom").installDomGlobals()
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const collectors = require("../../../packages/collectors/dist")
const hn = require("../../../packages/collectors/dist/collectors/comments/hackerNewsComments")
const lobsters = require("../../../packages/collectors/dist/collectors/comments/lobstersComments")
const reddit = require("../../../packages/collectors/dist/collectors/comments/redditComments")

const fixtures = path.join(__dirname, "../../fixtures/collectors/comments")
const readJson = name => JSON.parse(fs.readFileSync(path.join(fixtures, name), "utf8"))
const readText = name => fs.readFileSync(path.join(fixtures, name), "utf8")

const flatten = nodes => nodes.flatMap(node => [node, ...flatten(node.children)])
const depths = (nodes, depth = 0) => nodes.flatMap(node => [depth, ...depths(node.children, depth + 1)])

function stubFetch(routes) {
  const calls = []
  const fetch = async (url, init = {}) => {
    calls.push({ url, init })
    for (const [match, respond] of routes) {
      if (url.startsWith(match)) return respond(url)
    }
    return new Response("missing", { status: 404 })
  }
  return { fetch, calls }
}

const json = body => () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
const html = body => () => new Response(body, { status: 200, headers: { "content-type": "text/html" } })

test("finds the collector that reads a comment URL", () => {
  assert.equal(collectors.comments_provider_for("https://news.ycombinator.com/item?id=50019911")?.options.id, "hackernews")
  assert.equal(collectors.comments_provider_for("https://lobste.rs/s/rb2ulg/some_title")?.options.id, "lobsters")
  assert.equal(collectors.comments_provider_for("https://old.reddit.com/r/commandline/comments/1abcde/x/")?.options.id, "redditjson")
  assert.equal(collectors.comments_provider_for("https://www.reddit.com/comments/1abcde")?.options.id, "redditjson")
  assert.equal(collectors.comments_provider_for("https://news.ycombinator.com/news"), undefined)
  assert.equal(collectors.comments_provider_for("https://example.com/s/abc"), undefined)
})

test("reads a Hacker News tree from Algolia", async () => {
  const item = readJson("hn-item.json")
  const { fetch, calls } = stubFetch([["https://hn.algolia.com/api/v1/items/50019911", json(item)]])
  const thread = await hn.load("https://news.ycombinator.com/item?id=50019911", { fetch })
  assert.equal(calls.length, 1)
  assert.equal(thread.provider, "hackernews")
  assert.equal(thread.title, item.title)
  assert.equal(thread.comments.length, 2)
  assert.equal(thread.total, flatten(thread.comments).length)
  const first = thread.comments[0]
  assert.equal(first.author, item.children[0].author)
  assert.equal(first.permalink, `https://news.ycombinator.com/item?id=${item.children[0].id}`)
  assert.equal(first.time, item.children[0].created_at_i * 1000)
  assert.ok(first.children.length > 0)
})

test("falls back to the Hacker News item page when Algolia has nothing", async () => {
  const { fetch, calls } = stubFetch([
    ["https://hn.algolia.com/", () => new Response("{}", { status: 404 })],
    ["https://news.ycombinator.com/item?id=50019911", html(readText("hn-item.html"))]
  ])
  const thread = await hn.load("https://news.ycombinator.com/item?id=50019911", { fetch })
  assert.equal(calls.length, 2)
  assert.equal(thread.total, 8)
  // The fixture's eight rows are one chain, indent 0 to 7.
  assert.deepEqual(depths(thread.comments), [0, 1, 2, 3, 4, 5, 6, 7])
  const [first] = thread.comments
  assert.equal(first.id, "50020072")
  assert.equal(first.author, "theodorejb")
  assert.equal(first.time, Date.parse("2026-10-09T13:16:33Z"))
  assert.match(first.html, /support the Deno runtime/)
  assert.equal(thread.title, "Cloudflare acquires Deno")
})

test("reads a Lobsters story's flat comments into a tree", async () => {
  const story = readJson("lobsters-story.json")
  const { fetch, calls } = stubFetch([["https://lobste.rs/s/rb2ulg.json", json(story)]])
  const thread = await lobsters.load("https://lobste.rs/s/rb2ulg/oh_apparently", { fetch })
  assert.equal(calls[0].url, "https://lobste.rs/s/rb2ulg.json")
  assert.equal(thread.url, story.comments_url)
  assert.equal(thread.total, story.comments.length)
  assert.deepEqual(depths(thread.comments), story.comments.map(comment => comment.depth))
  const first = thread.comments[0]
  assert.equal(first.author, story.comments[0].commenting_user)
  assert.equal(first.permalink, story.comments[0].short_id_url)
  assert.equal(first.avatarUrl, `https://lobste.rs/avatars/${story.comments[0].commenting_user}-32.png`)
  assert.equal(first.score, story.comments[0].score)
})

test("accepts Lobsters' older user objects", () => {
  const thread = lobsters.threadFromStory("https://lobste.rs/s/x", {
    title: "t",
    comments: [{ short_id: "a", parent_comment: null, comment: "<p>hi</p>", commenting_user: { username: "eve" }, created_at: "2020-01-01T00:00:00Z" }]
  })
  assert.equal(thread.comments[0].author, "eve")
})

test("reads a Reddit thread with cookies, removed comments and held-back replies", async () => {
  const { fetch, calls } = stubFetch([["https://old.reddit.com/comments/1abcde.json", json(readJson("reddit-comments.json"))]])
  const thread = await reddit.load("https://old.reddit.com/r/commandline/comments/1abcde/show_me/", { fetch })
  assert.equal(calls[0].init.credentials, "include")
  assert.match(calls[0].url, /raw_json=1/)
  assert.equal(thread.title, "Show me your terminal setup")
  assert.equal(thread.storyAuthor, "alice")
  assert.equal(thread.total, 4)
  assert.deepEqual(depths(thread.comments), [0, 1, 2, 0])
  const [bob, dave] = thread.comments
  const removed = bob.children[0]
  assert.equal(removed.author, null)
  assert.equal(removed.removed, true)
  const carol = removed.children[0]
  assert.equal(carol.score, undefined, "a hidden score is not shown")
  assert.deepEqual(carol.more, { count: 1, url: carol.permalink })
  assert.equal(dave.children.length, 0)
  assert.deepEqual(thread.more, { count: 4, url: "https://old.reddit.com/comments/1abcde/" })
  assert.equal(thread.partial, true)
})

test("a Reddit login redirect is an auth failure, not a parse error", async () => {
  const fetch = async () => {
    const response = new Response("<!doctype html><title>login</title>", { status: 200, headers: { "content-type": "text/html" } })
    Object.defineProperty(response, "url", { value: "https://old.reddit.com/login/?reason=lor2" })
    return response
  }
  await assert.rejects(reddit.load("https://old.reddit.com/comments/1abcde/", { fetch }), error => error.name === "CommentsAuthError")
})

test("a missing thread is reported as not found", async () => {
  const { fetch } = stubFetch([])
  await assert.rejects(lobsters.load("https://lobste.rs/s/zzzzzz", { fetch }), error => error.name === "CommentsNotFoundError")
})
