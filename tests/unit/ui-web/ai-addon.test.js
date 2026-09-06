const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const directory = path.resolve(__dirname, "../../../examples/addons/what-wait-who-why")
const modulePromise = import(`data:text/javascript;base64,${fs.readFileSync(path.join(directory, "main.js")).toString("base64")}`)
const schema = JSON.parse(fs.readFileSync(path.join(directory, "once-addon.json"))).settings
const defaults = Object.fromEntries(Object.entries(schema.properties).filter(([, value]) => "default" in value).map(([key, value]) => [key, value.default]))

async function fixture(extra = {}, respond) {
  const addon = await modulePromise
  let handler, settingsChanged
  const requests = []
  let extracts = 0
  const settings = { ...defaults, provider: "compatible", model: "fixture-model", compatibleEndpoint: "http://localhost/v1/chat/completions", ...extra }
  addon.default({ settings, onTray: callback => { handler = callback }, onSettings: callback => { settingsChanged = callback } })
  const context = {
    signal: new AbortController().signal,
    async getStoryContent() { extracts++; return { text: "Article evidence", title: "Article", sourceUrl: "https://story.test/", truncated: false } },
    async request(connection, request) {
      requests.push({ connection, request })
      return respond ? respond(connection, request) : { status: 200, text: JSON.stringify({ choices: [{ message: { content: "An explanation." } }] }) }
    }
  }
  const story = { href: "https://story.test/", title: "What is ExampleApp 2.0?" }
  return { requests, context, story, addon, changed: () => settingsChanged(settings), extracts: () => extracts,
    run: event => handler("assistant", event, story, context) }
}

test("opening explains once, summarizing is separate, follow-up includes history, clear resets", async () => {
  const f = await fixture()
  let result = await f.run({ type: "open" })
  assert.match(result.messages[0].text, /explanation/)
  await f.run({ type: "open" })
  assert.equal(f.requests.length, 1)
  await f.run({ type: "submit", text: "Who uses it?" })
  const chat = JSON.parse(f.requests.at(-1).request.body)
  assert.ok(chat.messages.some(message => message.content === "An explanation."))
  assert.equal(chat.messages.at(-1).content, "Who uses it?")
  await f.run({ type: "action", action: "summarize" })
  const summary = JSON.parse(f.requests.at(-1).request.body)
  assert.match(summary.messages[0].content, /three to five/)
  assert.equal(summary.messages.some(message => message.content === "An explanation."), false)
  assert.equal(f.extracts(), 1)
  result = await f.run({ type: "clear" })
  assert.equal(result.messages.length, 0)
  await f.run({ type: "open" })
  assert.equal(f.extracts(), 2)
  f.changed()
  await f.run({ type: "open" })
  assert.equal(f.extracts(), 3)
})

test("question, release, ambiguous person and ordinary titles reach the explanation prompt", async () => {
  for (const title of ["Why is the sky blue", "ExampleApp 2.0 released", "Alex joins the project", "A quiet afternoon"]) {
    const f = await fixture()
    f.story.title = title
    await f.run({ type: "open" })
    const body = JSON.parse(f.requests[0].request.body)
    assert.match(body.messages[0].content, /acknowledge ambiguity/)
    assert.ok(body.messages[1].content.includes(title))
  }
})

test("missing article is labelled title-only and cannot be summarized", async () => {
  const f = await fixture()
  f.context.getStoryContent = async () => { throw new Error("No readable content") }
  assert.match((await f.run({ type: "open" })).status, /Title only/)
  assert.match((await f.run({ type: "action", action: "summarize" })).status, /Cannot summarize/)
  assert.equal(f.requests.length, 1)
})

test("native provider payloads and source metadata normalize without arbitrary links", async () => {
  const { providerRequest, providerResult } = await modulePromise
  const openai = JSON.parse(providerRequest({ provider: "openai", model: "fixture" }, "prompt", "article", [], true).body)
  assert.equal(openai.store, false)
  assert.equal(openai.tools[0].type, "web_search")
  const anthropic = providerRequest({ provider: "anthropic", model: "fixture" }, "prompt", "article", [], true)
  assert.equal(anthropic.headers["anthropic-version"], "2023-06-01")
  assert.equal(JSON.parse(anthropic.body).tools[0].max_uses, 3)
  const result = providerResult("openai", { output: [{ content: [{ type: "output_text", text: "Answer", annotations: [
    { type: "url_citation", title: "Source", url: "https://source.test/" }, { type: "url_citation", url: "javascript:bad" }
  ] }] }] })
  assert.deepEqual(result.sources, [{ title: "Source", url: "https://source.test/" }])
  assert.throws(() => providerResult("compatible", {}), /no answer/)
})

test("SearXNG is opt-in, limited to five results and emits only referenced citations", async () => {
  const f = await fixture({ webSearch: true, searchEndpoint: "https://search.test/search" }, connection => connection === "searxng"
    ? { status: 200, text: JSON.stringify({ results: Array.from({ length: 7 }, (_, i) => ({ title: `Source ${i}`, url: `https://source.test/${i}`, content: "snippet" })) }) }
    : { status: 200, text: JSON.stringify({ choices: [{ message: { content: "Explanation [S1]." } }] }) })
  const result = await f.run({ type: "open" })
  assert.equal(f.requests[0].request.query.format, "json")
  assert.equal(result.messages[0].sources.length, 1)
  assert.equal(result.messages[0].sources[0].url, "https://source.test/0")
  assert.equal(f.requests[1].request.body.includes("Source 5"), false)
  await f.run({ type: "action", action: "summarize" })
  assert.equal(f.requests.filter(request => request.connection === "searxng").length, 1)
})

test("search failure offers an explicit no-search retry; auth errors never trigger fallback", async () => {
  const f = await fixture({ webSearch: true })
  const failure = await f.run({ type: "open" })
  assert.ok(failure.actions.some(action => action.id === "without-search"))
  await f.run({ type: "action", action: "without-search" })
  assert.equal(f.requests.length, 1)
  const native = await fixture({ provider: "openai", webSearch: true, searchEndpoint: "https://search.test/" }, () => ({ status: 401, text: "unauthorized" }))
  assert.match((await native.run({ type: "open" })).status, /401/)
  assert.equal(native.requests.length, 1)
})

test("history trimming retains complete recent exchanges within the limit", async () => {
  const { recentHistory } = await modulePromise
  const pair = [{ role: "user", content: "q".repeat(8000) }, { role: "assistant", content: "a".repeat(8000) }]
  const result = recentHistory([...pair, ...pair, ...pair])
  assert.equal(result.messages.length, 4)
  assert.equal(result.shortened, true)
})

test("search-disabled requests never include tools or contact SearXNG for any provider", async () => {
  for (const provider of ["openai", "anthropic", "compatible"]) {
    const f = await fixture({ provider, webSearch: false, searchEndpoint: "https://search.test/" }, () => ({ status: 200, text: JSON.stringify(
      provider === "openai" ? { output: [{ content: [{ type: "output_text", text: "Answer" }] }] } :
        provider === "anthropic" ? { content: [{ type: "text", text: "Answer" }] } : { choices: [{ message: { content: "Answer" } }] }
    ) }))
    const result = await f.run({ type: "open" })
    assert.equal(f.requests.length, 1)
    assert.equal(JSON.parse(f.requests[0].request.body).tools, undefined)
    assert.match(result.status, /No web sources used/)
  }
})

test("explicit native-search unavailability falls back once and maps supplied sources", async () => {
  let generation = 0
  const f = await fixture({ provider: "openai", webSearch: true, searchEndpoint: "https://search.test/search" }, connection => {
    if (connection === "searxng") return { status: 200, text: JSON.stringify({ results: [{ title: "Source", url: "https://source.test/", content: "Evidence" }] }) }
    generation++
    return generation === 1 ? { status: 400, text: "web_search not supported" } :
      { status: 200, text: JSON.stringify({ output: [{ content: [{ type: "output_text", text: "Answer [S1]" }] }] }) }
  })
  const result = await f.run({ type: "open" })
  assert.deepEqual(f.requests.map(request => request.connection), ["openai", "searxng", "openai"])
  assert.equal(JSON.parse(f.requests[2].request.body).tools, undefined)
  assert.match(result.status, /Web sources used/)
  assert.equal(result.messages[0].sources[0].url, "https://source.test/")
})

test("Anthropic native citations and tool failures normalize into tray results", async () => {
  const f = await fixture({ provider: "anthropic", webSearch: true }, () => ({ status: 200, text: JSON.stringify({ content: [
    { type: "text", text: "Answer", citations: [{ type: "web_search_result_location", title: "Source", url: "https://source.test/" }] }
  ] }) }))
  const answer = await f.run({ type: "open" })
  assert.equal(answer.messages[0].sources.length, 1)
  assert.match(answer.status, /Web sources used/)
  const failed = await fixture({ provider: "anthropic", webSearch: true }, () => ({ status: 200, text: JSON.stringify({ content: [
    { type: "web_search_tool_result", content: { type: "web_search_tool_result_error" } }
  ] }) }))
  assert.ok((await failed.run({ type: "open" })).actions.some(action => action.id === "without-search"))
})

test("malformed JSON, rate limits and missing SearXNG JSON remain recoverable", async () => {
  for (const [status, text, expected] of [[200, "null", /response format/], [200, "{bad", /invalid JSON/], [429, "limited", /Rate limited/]]) {
    const f = await fixture({ provider: "openai", webSearch: true, searchEndpoint: "https://search.test/" }, () => ({ status, text }))
    const result = await f.run({ type: "open" })
    assert.match(result.status, expected)
    assert.equal(f.requests.length, 1)
    assert.ok(result.actions.some(action => action.id === "retry"))
  }
  const search = await fixture({ webSearch: true, searchEndpoint: "https://search.test/" }, () => ({ status: 200, text: "<html>JSON disabled</html>" }))
  const result = await search.run({ type: "open" })
  assert.match(result.status, /JSON output/)
  assert.ok(result.actions.some(action => action.id === "without-search"))
})

test("long articles are capped in outgoing context and reported as shortened", async () => {
  const f = await fixture()
  f.context.getStoryContent = async () => ({ text: "x".repeat(80000), title: "Long article", sourceUrl: f.story.href, truncated: true })
  const result = await f.run({ type: "open" })
  const source = JSON.parse(JSON.parse(f.requests[0].request.body).messages[1].content.split("\n").slice(1).join("\n"))
  assert.equal(source.article.text.length, 64000)
  assert.match(result.status, /64,000/)
})

test("provider errors expose structured model-access details without triggering search fallback", async () => {
  const message = "models/gemini-2.5-flash-lite is not found for API version v1beta, or is not supported for generateContent."
  for (const body of [{ error: { code: 404, message, status: "NOT_FOUND" } }, [{ error: { message } }]]) {
    const f = await fixture({ provider: "openai", webSearch: true, searchEndpoint: "https://search.test/" },
      () => ({ status: 404, text: JSON.stringify(body) }))
    const result = await f.run({ type: "open" })
    assert.equal(result.status, `AI request failed (HTTP 404). Check the endpoint and model ID. Provider: ${message}`)
    assert.equal(result.statusTone, "error")
    assert.ok(result.actions.some(action => action.id === "retry"))
    assert.equal(f.requests.length, 1)
  }
})

test("provider error details fit the tray limit and non-JSON bodies remain hidden", async () => {
  const long = await fixture({}, () => ({ status: 404, text: JSON.stringify({ error: { message: "Detail\n".repeat(1000) } }) }))
  const result = await long.run({ type: "open" })
  assert.match(result.status, /Provider: Detail Detail/)
  assert.ok(result.status.length <= 1000)
  assert.equal(result.status.includes("\n"), false)
  for (const text of ["<html>Proxy failure</html>", "null", JSON.stringify({ error: { message: { unexpected: true } } })]) {
    const f = await fixture({}, () => ({ status: 502, text }))
    assert.equal((await f.run({ type: "open" })).status, "AI request failed (HTTP 502). Check the endpoint and model ID.")
  }
})
