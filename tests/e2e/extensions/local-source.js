const http = require("node:http")
const storyFixture = require("../shared/story-fixture")

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
    source: `json:§§${JSON.stringify({
      stories: { sel: "items", all: true },
      link: { sel: "href" },
      title: { sel: "title" },
      timestamp: { sel: "published" },
      tags: []
    })}§§${origin}/feed.json`,
    close: () => new Promise((resolve) => server.close(resolve))
  }
}

module.exports = { startLocalSource, startStoryFixture }
