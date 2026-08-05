const http = require("node:http")

const DESCRIPTION = "The open-source CapCut alternative"
const STORY_PATH = "/OpenCut-app/OpenCut"
const STORY_TITLE = `[OpenCut-app/OpenCut] ${DESCRIPTION}`

function sourceLine(origin) {
  return JSON.stringify({ version: 2, groups: [], sources: [{
    id: "src_genytest1",
    url: `${origin}/trending`,
    collector: "geny",
    select: {
      stories: { sel: "article", all: true },
      link: { sel: "h2 a", component: "href" },
      title: {
        sel: "p",
        component: "innerText",
        processors: ["trim", "show_path"],
        fallback: " "
      },
      tags: [{
        elements: {
          text: {
            sel: "span[itemprop=programmingLanguage]",
            component: "innerText"
          }
        }
      }]
    }
  }] })
}

async function startGenyFixture() {
  let origin = ""
  const requests = []
  const userAgents = []
  const server = http.createServer((request, response) => {
    requests.push(request.url)
    userAgents.push(request.headers["user-agent"] || "")
    const path = (request.url || "").split("?")[0]
    if (path === "/trending") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "access-control-allow-origin": "*"
      })
      response.end(`<!doctype html>
        <html>
          <head><title>Trending</title></head>
          <body>
            <article class="Box-row">
              <h2><a href="${STORY_PATH}">OpenCut-app / OpenCut</a></h2>
              <p>${DESCRIPTION}</p>
              <span itemprop="programmingLanguage">TypeScript</span>
            </article>
          </body>
        </html>`)
      return
    }
    if (path === STORY_PATH) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      response.end("<!doctype html><title>OpenCut</title><h1>OpenCut</h1>")
      return
    }
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
    response.end("not found")
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  return {
    origin,
    requests,
    userAgents,
    source: sourceLine(origin),
    storyUrl: `${origin}${STORY_PATH}`,
    close: () => new Promise((resolve) => server.close(resolve))
  }
}

module.exports = { DESCRIPTION, STORY_TITLE, startGenyFixture }
