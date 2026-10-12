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
  if (request.url === "/ai-addon/v1/models") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ data: [{ id: "fixture" }, { id: "fixture-vision" }] })); return true }
  if (["/ai-addon/completions", "/ai-addon/v1/chat/completions"].includes(request.url) && request.method === "POST") {
    let text = ""
    request.on("data", chunk => { text += chunk })
    request.on("end", () => {
      const body = JSON.parse(text)
      const call = { body, authorized: request.headers.authorization === "Bearer fixture-token", closed: false }
      calls.push(call)
      response.once("close", () => { call.closed = true })
      const content = body.messages.at(-1).content
      const last = typeof content === "string" ? content : "Image transcription"
      const formatting = body.messages[0]?.content?.includes("Classify the supplied document blocks")
      const answer = formatting ? JSON.stringify(JSON.parse(last).map((block, index) => ({ id: block.id, kind: index === 0 && block.text.length < 100 ? "h2" : block.kind }))) : Array.isArray(content) ? "Scanned heading\n\nFirst paragraph.\n\nSecond paragraph." : last.includes("Summarize") ? "- The article describes its main result.\n- Its qualifications are preserved." :
        // The follow-up carries a link, so hosts can show that a tray link opens where their tabs are.
        last.includes("Who uses") ? `Developers use it. This follows our earlier explanation. See [the beta story](http://${request.headers.host}/story/beta).` :
          "**ExampleApp is software** for organizing projects.\n\n## Key entities\n\n**ExampleApp**: a project organizer. Use `projects` to group related work."
      const send = () => {
        if (response.destroyed) return
        // The addon catches a provider failure itself and reports it through the
        // view's status, which is the statusTone: "error" path.
        if (last.includes("Break")) { response.writeHead(500); response.end("{}"); return }
        response.writeHead(call.authorized ? 200 : 401, { "content-type": "application/json" })
        response.end(JSON.stringify({ choices: [{ message: { content: answer } }] }))
      }
      // "Wait" is the request the reader cancels. Holding it until the client
      // hangs up (never answering) keeps the Stop click from racing a timer;
      // a 3s delay used to lose that race on a slow runner and report the
      // answer instead of the cancellation.
      if (last.includes("Wait")) return
      send()
    })
    return true
  }
  response.writeHead(404); response.end(); return true
}

module.exports = { manifest, handleRequest, calls }
