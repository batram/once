const fs = require("node:fs")
const path = require("node:path")
const crypto = require("node:crypto")
const directory = path.resolve(__dirname, "../../../examples/addons/what-wait-who-why")
const script = fs.readFileSync(path.join(directory, "main.js"), "utf8")
const integrity = `sha256-${crypto.createHash("sha256").update(script).digest("base64")}`
const calls = []

function manifest(origin) {
  const value = JSON.parse(fs.readFileSync(path.join(directory, "once-addon.json"), "utf8"))
  return { ...value, script: { url: `${origin}/ai-addon/main.js`, integrity }, options: {
    provider: "compatible", compatibleEndpoint: `${origin}/ai-addon/completions`, model: "fixture"
  } }
}

function handleRequest(request, response) {
  if (!request.url.startsWith("/ai-addon/")) return false
  response.setHeader("access-control-allow-origin", "*")
  response.setHeader("access-control-allow-headers", "content-type,authorization")
  if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return true }
  if (request.url === "/ai-addon/main.js") {
    response.writeHead(200, { "content-type": "text/javascript" }); response.end(script); return true
  }
  if (request.url === "/ai-addon/completions" && request.method === "POST") {
    let text = ""
    request.on("data", chunk => { text += chunk })
    request.on("end", () => {
      const body = JSON.parse(text)
      const call = { body, authorized: request.headers.authorization === "Bearer fixture-token", closed: false }
      calls.push(call)
      response.once("close", () => { call.closed = true })
      const last = body.messages.at(-1).content
      const answer = last.includes("Summarize") ? "• The article describes its main result.\n• Its qualifications are preserved." :
        last.includes("Who uses") ? "Developers use it. This follows our earlier explanation." : "ExampleApp is software for organizing projects."
      const send = () => {
        if (response.destroyed) return
        response.writeHead(call.authorized ? 200 : 401, { "content-type": "application/json" })
        response.end(JSON.stringify({ choices: [{ message: { content: answer } }] }))
      }
      if (last.includes("Wait")) setTimeout(send, 3000)
      else send()
    })
    return true
  }
  response.writeHead(404); response.end(); return true
}

module.exports = { manifest, handleRequest, calls }
