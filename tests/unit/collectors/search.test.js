require("../../helpers/dom").installDomGlobals()
const test = require("node:test")
const assert = require("node:assert/strict")
const reddit = require("../../../packages/collectors/dist/collectors/redditJson")

const listing = {
  kind: "Listing",
  data: {
    children: [{
      data: {
        author: "someone", permalink: "/r/netsec/comments/abc/x/", url: "https://example.com/a",
        title: "A", id: "abc", created_utc: 1, subreddit: "netsec", subreddit_name_prefixed: "r/netsec", ups: 1
      }
    }]
  }
}

function recordingFetch(body) {
  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url, init })
    return new Response(body, { status: 200 })
  }
  return { calls, fetch }
}

test("Reddit search goes through the shell's fetch with the user's session", async () => {
  const io = recordingFetch(JSON.stringify(listing))
  const stories = await reddit.global_search("agent security", io)
  assert.equal(io.calls.length, 1)
  assert.equal(io.calls[0].url, "https://old.reddit.com/search.json?q=agent%20security")
  assert.equal(io.calls[0].init.credentials, "include")
  // Below the subreddit score threshold, but asked for by name.
  assert.deepEqual(stories.map(story => story.title), ["A"])
})

test("Reddit's signed-out page instead of JSON yields no results rather than a throw", async () => {
  const io = recordingFetch("<!DOCTYPE html><title>Welcome to Reddit</title>")
  const warn = console.warn
  console.warn = () => {}
  try {
    assert.deepEqual(await reddit.global_search("x", io), [])
  } finally {
    console.warn = warn
  }
})

test("Reddit domain search is a site: search with the same session", async () => {
  const io = recordingFetch(JSON.stringify(listing))
  await reddit.domain_search("example.com", io)
  assert.equal(io.calls[0].url, "https://old.reddit.com/search.json?q=site%3Aexample.com")
  assert.equal(io.calls[0].init.credentials, "include")
})
