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
  const requests = [], updates = []
  let extracts = 0
  const settings = { ...defaults, provider: "compatible", model: "fixture-model", compatibleEndpoint: "http://localhost/v1/chat/completions", ...extra }
  addon.default({ settings, onTray: callback => { handler = callback }, onSettings: callback => { settingsChanged = callback } })
  const context = {
    signal: new AbortController().signal,
    update(view) { updates.push(view) },
    async getStoryContent() { extracts++; return { text: "Article evidence", title: "Article", sourceUrl: "https://story.test/", truncated: false } },
    async request(connection, request) {
      requests.push({ connection, request })
      return respond ? respond(connection, request) : { status: 200, text: JSON.stringify({ choices: [{ message: { content: "An explanation." } }] }) }
    }
  }
  const story = { href: "https://story.test/", title: "What is ExampleApp 2.0?" }
  return { requests, updates, context, story, addon, changed: () => settingsChanged(settings), extracts: () => extracts,
    run: event => handler("assistant", event, story, context) }
}

test("opening explains and summarizes once, follow-up includes history, clear resets", async () => {
  const f = await fixture()
  let result = await f.run({ type: "open" })
  assert.match(result.messages[0].text, /explanation/)
  assert.equal(result.messages[0].title, undefined)
  assert.deepEqual(result.messages[1], { role: "assistant", title: "Summary", collapsed: true, text: "An explanation.", sources: [] })
  assert.equal(f.requests.length, 2)
  const summary = JSON.parse(f.requests[1].request.body)
  assert.match(summary.messages[0].content, /three to five/)
  assert.equal(summary.messages.some(message => message.content === "An explanation."), false)
  // The opening turn already explained and summarized, so neither is offered again.
  assert.deepEqual(result.actions, [])
  await f.run({ type: "open" })
  assert.equal(f.requests.length, 2)
  await f.run({ type: "submit", text: "Who uses it?" })
  const chat = JSON.parse(f.requests.at(-1).request.body)
  assert.ok(chat.messages.some(message => message.content === "An explanation."))
  assert.equal(chat.messages.at(-1).content, "Who uses it?")
  assert.equal(f.extracts(), 1)
  result = await f.run({ type: "clear" })
  assert.equal(result.messages.length, 0)
  assert.deepEqual(result.actions.map(action => action.id), ["summarize"])
  await f.run({ type: "open" })
  assert.equal(f.extracts(), 2)
  f.changed()
  await f.run({ type: "open" })
  assert.equal(f.extracts(), 3)
})

test("opening asks for the explanation and summary at once and shows whichever lands first", async () => {
  const pending = []
  const reply = content => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content } }] }) })
  const f = await fixture({}, (_connection, request) => new Promise(resolve => pending.push({ summary: /Summarize/.test(request.body), resolve })))
  const opened = f.run({ type: "open" })
  await new Promise(resolve => setImmediate(resolve))
  // Both are in flight before either answers.
  assert.deepEqual(pending.map(request => request.summary), [false, true])
  pending[1].resolve(reply("The summary."))
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.updates.map(view => view.messages.map(message => message.title ?? message.text)), [["Summary"]])
  pending[0].resolve(reply("The explanation."))
  const result = await opened
  assert.deepEqual(result.messages.map(message => message.title ?? message.text), ["The explanation.", "Summary"])
  // The last answer is the returned view; no redundant update.
  assert.equal(f.updates.length, 1)
})

test("a failed explanation keeps the summary that did land, and Retry asks only for the explanation", async () => {
  let explanations = 0
  const summary = request => JSON.parse(request.body).messages.at(-1).content === "Summarize this article."
  const f = await fixture({}, (_connection, request) => summary(request) || ++explanations > 1
    ? { status: 200, text: JSON.stringify({ choices: [{ message: { content: summary(request) ? "The summary." : "The explanation." } }] }) }
    : { status: 503, text: JSON.stringify({ error: { message: "High demand" } }) })
  const failed = await f.run({ type: "open" })
  assert.match(failed.status, /HTTP 503/)
  assert.deepEqual(failed.messages.map(message => message.title ?? message.text), ["Summary"])
  assert.deepEqual(failed.actions.map(action => action.id), ["retry"])
  const retried = await f.run({ type: "action", action: "retry" })
  assert.equal(f.requests.length, 3)
  assert.match(retried.status, /Using story content/)
  assert.deepEqual(retried.messages.map(message => message.title ?? message.text), ["Summary", "The explanation."])
})

test("the explanation keeps its answer in view and folds the entity section behind its heading", async () => {
  const f = await fixture({}, () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content:
    "ExampleApp organizes projects.\n\n## Key entities\n\n- **ExampleApp**: project software.\n- **Projects**: units of work." } }] }) }))
  const result = await f.run({ type: "open" })
  assert.deepEqual(result.messages.map(message => [message.title, message.collapsed, message.text.split("\n")[0]]), [
    [undefined, undefined, "ExampleApp organizes projects."],
    ["Key entities", true, "- **ExampleApp**: project software."],
    ["Summary", true, "ExampleApp organizes projects."]
  ])
  const { explanation } = await modulePromise
  const whole = { text: "## Key entities\n\nOnly a heading first.", sources: [] }
  assert.deepEqual(explanation(whole), [{ role: "assistant", text: whole.text, sources: [] }])
  assert.equal(explanation({ text: "No heading at all.", sources: [] }).length, 1)
  assert.equal(explanation({ text: "Lead\n\n## Empty section\n\n", sources: [] }).length, 1)
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

test("an unconfigured addon gives directions without a Retry button or an error tone", async () => {
  const f = await fixture({ model: "" })
  const opened = await f.run({ type: "open" })
  assert.match(opened.status, /Set a model ID and connection/)
  assert.equal(opened.statusTone, "info")
  assert.ok(!opened.actions.some(action => action.id === "retry"))
  assert.equal(f.requests.length, 0)
})

test("missing article is labelled title-only, skips the automatic summary and refuses a requested one", async () => {
  const f = await fixture()
  f.context.getStoryContent = async () => { throw new Error("No readable content") }
  const opened = await f.run({ type: "open" })
  assert.match(opened.status, /Title only/)
  assert.equal(opened.statusTone, "info")
  assert.equal(opened.messages.length, 1)
  assert.deepEqual(opened.actions.map(action => action.id), ["summarize"])
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
    ? { status: 200, text: JSON.stringify({ results: [
      // One page under three spellings takes one id; the ids count only distinct pages.
      { title: "Dup", url: "https://Source.test/0/", content: "snippet" }, { title: "Dup", url: "https://source.test/0?utm=x#top", content: "snippet" },
      ...Array.from({ length: 7 }, (_, i) => ({ title: `Source ${i}`, url: `https://source.test/${i}`, content: "snippet" }))
    ] }) }
    : { status: 200, text: JSON.stringify({ choices: [{ message: { content: "Explanation [S1, S3]. More [S3][S10]. Not S2.\n\n## Key entities\n\n- **Thing**" } }] }) })
  const result = await f.run({ type: "open" })
  assert.equal(f.requests[0].request.query.format, "json")
  // The summary is asked alongside the search; the explanation waits for the search.
  const explained = f.requests.find(request => request.connection === "compatible" && request.request.body.includes("Search results"))
  assert.equal(JSON.parse(explained.request.body).messages[1].content.match(/"id":"S\d+"/g).length, 5)
  // Grouped and repeated citations still map to every id they name, once each,
  // and they follow the answer: the lead carries them, above the folded section.
  assert.deepEqual(result.messages[0].sources.map(source => source.url), ["https://Source.test/0/", "https://source.test/2"])
  assert.equal(result.messages[1].sources, undefined)
  assert.equal(explained.request.body.includes("Source 5"), false)
  await f.run({ type: "action", action: "summarize" })
  assert.equal(f.requests.filter(request => request.connection === "searxng").length, 1)
})

test("Tavily fallback posts a JSON query to its own connection and shares the citation mapping", async () => {
  const f = await fixture({ webSearch: true, searchProvider: "tavily" }, connection => connection === "tavily"
    ? { status: 200, text: JSON.stringify({ results: [{ title: "Source", url: "https://source.test/", content: "Evidence" }] }) }
    : { status: 200, text: JSON.stringify({ choices: [{ message: { content: "Explanation [S1]." } }] }) })
  const result = await f.run({ type: "open" })
  assert.deepEqual(f.requests.map(request => request.connection), ["tavily", "compatible", "compatible"])
  assert.equal(f.requests[0].request.method, "POST")
  assert.deepEqual(JSON.parse(f.requests[0].request.body), { query: "What is ExampleApp 2.0?", max_results: 5 })
  assert.deepEqual(result.messages[0].sources, [{ title: "[S1] Source", url: "https://source.test/" }])
  const missing = await fixture({ webSearch: true, searchProvider: "tavily", tavilyEndpoint: "" })
  assert.match((await missing.run({ type: "open" })).status, /Tavily/)
  // Only the summary, which never searches, goes out.
  assert.deepEqual(missing.requests.map(request => JSON.parse(request.request.body).messages.at(-1).content), ["Summarize this article."])
  const failed = await fixture({ webSearch: true, searchProvider: "tavily" }, () => ({ status: 401, text: "{}" }))
  const failure = await failed.run({ type: "open" })
  assert.match(failure.status, /API key/)
  assert.ok(failure.actions.some(action => action.id === "without-search"))
})

test("search failure offers an explicit no-search retry; auth errors never trigger fallback", async () => {
  const f = await fixture({ webSearch: true })
  const failure = await f.run({ type: "open" })
  assert.ok(failure.actions.some(action => action.id === "without-search"))
  // The summary never searches, so it arrives regardless.
  assert.equal(f.requests.length, 1)
  assert.deepEqual(failure.messages.map(message => message.title), ["Summary"])
  // The retry resumes the opening turn with only what failed: the explanation, without search.
  const resumed = await f.run({ type: "action", action: "without-search" })
  assert.equal(f.requests.length, 2)
  assert.deepEqual(resumed.messages.map(message => message.title), ["Summary", undefined])
  const native = await fixture({ provider: "openai", webSearch: true, searchEndpoint: "https://search.test/" }, () => ({ status: 401, text: "unauthorized" }))
  assert.match((await native.run({ type: "open" })).status, /401/)
  assert.ok(native.requests.every(request => request.connection === "openai"))
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
    assert.equal(f.requests.length, 2)
    assert.ok(f.requests.every(request => JSON.parse(request.request.body).tools === undefined))
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
  // The explanation falls back once; the summary beside it never searches.
  assert.deepEqual(f.requests.map(request => request.connection), ["openai", "openai", "searxng", "openai"])
  assert.deepEqual(f.requests.map(request => request.request.body && !!JSON.parse(request.request.body).tools), [true, false, undefined, false])
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
    // The explanation and the summary, asked at once, each fail on their own.
    assert.equal(f.requests.length, 2)
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
    // A native-search request that fails for another reason never falls back to SearXNG.
    assert.ok(f.requests.every(request => request.connection === "openai"))
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
