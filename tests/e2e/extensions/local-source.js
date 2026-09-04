const fs = require("node:fs")
const http = require("node:http")
const path = require("node:path")
const storyFixture = require("../shared/story-fixture")
const addonFixture = require("../shared/addon-fixture")

// Serves the shared story fixture (feed + story/comment/rewritten pages) for
// the richer story-list suites. startLocalSource below stays untouched for
// the original smoke tests.
async function startStoryFixture() {
  const requests = []
  let origin = ""
  const server = http.createServer((request, response) => {
    requests.push(request.url)
    if (storyFixture.handleRequest(request, response, origin)) {
      return
    }
    // The fixture Once add-on's script and its collector's feed.
    if (request.url === "/addon/main.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" })
      response.end(addonFixture.ADDON_SCRIPT)
      return
    }
    if (request.url === "/api/stories.json") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" })
      response.end(JSON.stringify(addonFixture.addonApiStories(origin)))
      return
    }
    // The self-contained sandbox page the Firefox build emits, hosted the way
    // a Firefox user would host it, so the sidebar can point at it.
    if (request.url === "/sandbox/addon-sandbox-hosted.html") {
      const page = path.resolve(__dirname, "../../../apps/firefox-extension/dist/release/static/addon-sandbox-hosted.html")
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      response.end(fs.readFileSync(page))
      return
    }
    response.writeHead(404, { "content-type": "text/plain" })
    response.end("not part of the story fixture")
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  return {
    origin,
    requests,
    source: storyFixture.sourceLine(origin),
    urls: storyFixture.storyUrls(origin),
    redirectRule: storyFixture.redirectRule(origin),
    close: () => new Promise((resolve) => server.close(resolve))
  }
}

async function startLocalSource() {
  const requests = []
  const server = http.createServer((request, response) => {
    requests.push(request.url)
    if (request.url === "/story") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      response.end("<!doctype html><title>Opened story</title><h1>Opened story</h1>")
      return
    }
    response.writeHead(200, {
      "content-type": "application/json",
      "access-control-allow-origin": "*"
    })
    response.end(JSON.stringify({
      items: [{
        href: `${origin}/story`,
        title: "Extension smoke story",
        published: "2024-01-02T03:04:05Z"
      }]
    }))
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  return {
    origin,
    requests,
    source: JSON.stringify({ version: 2, groups: [], sources: [{
      id: "src_smoketest1",
      url: `${origin}/feed.json`,
      collector: "jsonselect",
      select: {
        stories: { sel: "items", all: true },
        link: { sel: "href" },
        title: { sel: "title" },
        timestamp: { sel: "published" },
        tags: []
      }
    }] }),
    close: () => new Promise((resolve) => server.close(resolve))
  }
}

module.exports = { startLocalSource, startStoryFixture }
