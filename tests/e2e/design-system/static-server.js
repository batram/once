"use strict"

const fs = require("node:fs")
const http = require("node:http")
const path = require("node:path")

const root = path.resolve(__dirname, "../../..")
const uiPublic = path.join(root, "packages", "ui-web", "public")
const mobileCss = path.join(root, "apps", "mobile", "src", "mobile.css")
const electronCss = path.join(root, "apps", "electron", "src", "electron.css")

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"]
])

function shell(target) {
  let html = fs.readFileSync(path.join(uiPublic, "shell.html"), "utf8")
    .replace('<div id="left_panel">', '<div id="left_panel" active_panel="stories">')
  if (target === "mobile") {
    html = html
      .replace(
        '<link rel="stylesheet" href="css/style.css" />',
        '<link rel="stylesheet" href="css/style.css" />\n' +
        '    <link rel="stylesheet" href="/mobile.css" />'
      )
      .replace("<body ", '<body data-platform="mobile" ')
  } else if (target === "electron") {
    html = html
      .replace(
        '<link rel="stylesheet" href="css/style.css" />',
        '<link rel="stylesheet" href="css/style.css" />\n' +
        '    <link rel="stylesheet" href="/electron.css" />'
      )
      .replace("<body ", '<body class="electron-platform-win32" ')
  }
  return html
}

function resolvedAsset(urlPath) {
  if (urlPath === "/mobile.css") return mobileCss
  if (urlPath === "/electron.css") return electronCss
  if (urlPath.startsWith("/imgs/")) {
    return path.join(uiPublic, "static", urlPath.slice(1))
  }
  if (!urlPath.startsWith("/static/")) return null
  const relative = urlPath.slice("/static/".length)
  const resolved = path.resolve(uiPublic, "static", relative)
  const staticRoot = path.resolve(uiPublic, "static") + path.sep
  return resolved.startsWith(staticRoot) ? resolved : null
}

function createServer() {
  return http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1")
    if (url.pathname === "/static/sidepanel.html") {
      response.setHeader("Content-Type", "text/html; charset=utf-8")
      response.end(shell(url.searchParams.get("target")))
      return
    }
    const file = resolvedAsset(url.pathname)
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      response.statusCode = 404
      response.end("Not found")
      return
    }
    response.setHeader(
      "Content-Type",
      contentTypes.get(path.extname(file)) || "application/octet-stream"
    )
    fs.createReadStream(file).pipe(response)
  })
}

if (require.main === module) {
  const port = Number.parseInt(process.env.ONCE_DESIGN_SYSTEM_PORT || "4399", 10)
  createServer().listen(port, "127.0.0.1", () => {
    console.log(`Design-system fixture listening on http://127.0.0.1:${port}`)
  })
}

module.exports = { createServer, root, shell }
