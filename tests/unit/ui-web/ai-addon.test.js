const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const directory = path.resolve(__dirname, "../../../examples/addons/what-wait-who-why")
const modulePromise = import(`data:text/javascript;base64,${fs.readFileSync(path.join(directory, "main.js")).toString("base64")}`)
const schema = JSON.parse(fs.readFileSync(path.join(directory, "once-addon.json"))).settings
const defaults = Object.fromEntries(Object.entries(schema.properties).filter(([, value]) => "default" in value).map(([key, value]) => [key, value.default]))

async function fixture(extra = {}, respond, fetch = async url => { throw new Error("no fetch: grant covers " + url) }) {
  const addon = await modulePromise
  let handler, settingsChanged
  const requests = [], updates = []
  let extracts = 0
  const settings = { ...defaults, provider: "compatible", model: "fixture-model", compatibleEndpoint: "http://localhost/v1/chat/completions", ...extra }
  addon.default({ settings, fetch, onTray: callback => { handler = callback }, onSettings: callback => { settingsChanged = callback } })
  const context = {
    signal: new AbortController().signal,
    update(view) { updates.push(view) },
    async getStoryContent() { extracts++; return { text: "Article evidence", title: "Article", sourceUrl: "https://story.test/", truncated: false } },
    async request(connection, request, options) {
      requests.push({ connection, request })
      return respond ? respond(connection, request, options) :{ status: 200, text: JSON.stringify({ choices: [{ message: { content: "An explanation." } }] }) }
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

test("a streamed explanation shows as it is written, and its finished text is the answer", async () => {
  const pause = () => new Promise(resolve => setTimeout(resolve, 120))
  const event = content => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
  const f = await fixture({}, async (_connection, request, options) => {
    const body = JSON.parse(request.body)
    assert.equal(body.stream, true)
    if (body.messages.at(-1).content === "Summarize this article.") {
      await pause(); await pause(); await pause()
      return { status: 200, text: JSON.stringify({ choices: [{ message: { content: "The summary." } }] }) }
    }
    const stream = [event("ExampleApp "), event("organizes"), event(" projects."), `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`].join("")
    // Pieces need not end on an event boundary.
    const cut = stream.indexOf("organizes") + 3
    options.onChunk(stream.slice(0, cut))
    await pause()
    options.onChunk(stream.slice(cut))
    await pause()
    return { status: 200, headers: { "content-type": "text/event-stream" }, text: stream }
  })
  const result = await f.run({ type: "open" })
  const shown = f.updates.map(view => view.messages.map(message => message.title ?? message.text))
  assert.deepEqual(shown[0], ["ExampleApp "])
  assert.ok(shown.some(messages => messages[0] === "ExampleApp organizes projects." && messages.length === 1))
  assert.deepEqual(result.messages.map(message => message.title ?? message.text), ["ExampleApp organizes projects.", "Summary"])
})

test("finished streams rebuild each provider's answer, citations and failures", async () => {
  const { streamedResponse, providerResult } = await modulePromise
  const sse = events => events.map(event => `event: x\ndata: ${JSON.stringify(event)}\n\n`).join("")
  const openai = streamedResponse("openai", sse([
    { type: "response.output_text.delta", delta: "Hi" },
    { type: "response.completed", response: { status: "completed", output: [{ content: [{ type: "output_text", text: "Hi",
      annotations: [{ type: "url_citation", title: "Source", url: "https://source.test/" }] }] }] } }
  ]))
  assert.deepEqual(providerResult("openai", openai), { text: "Hi", sources: [{ title: "Source", url: "https://source.test/" }] })
  assert.throws(() => streamedResponse("openai", sse([{ type: "response.output_text.delta", delta: "Hi" }])), /ended before/)
  const anthropic = streamedResponse("anthropic", sse([
    { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "tool" } },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Cited " } },
    { type: "content_block_delta", index: 1, delta: { type: "citations_delta", citation: { type: "web_search_result_location", title: "Source", url: "https://source.test/" } } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "answer" } },
    { type: "message_delta", delta: { stop_reason: "end_turn" } }
  ]))
  assert.deepEqual(providerResult("anthropic", anthropic), { text: "Cited answer", sources: [{ title: "Source", url: "https://source.test/" }] })
  assert.throws(() => providerResult("anthropic", streamedResponse("anthropic", sse([{ type: "message_delta", delta: { stop_reason: "max_tokens" } }]))), /did not complete/)
  assert.throws(() => streamedResponse("compatible", sse([[{ error: { message: "High\ndemand" } }]])), /Provider: High demand/)
  assert.throws(() => streamedResponse("anthropic", sse([{ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }])), /Overloaded/)
  assert.throws(() => providerResult("compatible", streamedResponse("compatible", sse([{ choices: [{ delta: { content: "Cut" }, finish_reason: "length" }] }]))), /did not complete/)
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
  // The explanation never waits for the search: it is asked first, without results.
  assert.deepEqual(f.requests.map(request => request.connection), ["compatible", "searxng", "compatible", "compatible"])
  assert.equal(f.requests[0].request.body.includes("Search results"), false)
  assert.equal(f.requests[1].request.query.format, "json")
  const grounded = f.requests.find(request => request.connection === "compatible" && request.request.body.includes("Search results"))
  assert.equal(JSON.parse(grounded.request.body).messages.at(-1).content, "What does the web add to this story?")
  assert.equal(JSON.parse(grounded.request.body).messages[1].content.match(/"id":"S\d+"/g).length, 5)
  assert.equal(grounded.request.body.includes("Source 5"), false)
  // The web section sits between the explanation and the summary, and carries the
  // citations: grouped and repeated ones map to every id they name, once each.
  assert.deepEqual(result.messages.map(message => message.title), [undefined, "Key entities", "From the web", "Summary"])
  assert.deepEqual(result.messages[0].sources, [])
  assert.deepEqual(result.messages[2].sources.map(source => source.url), ["https://Source.test/0/", "https://source.test/2"])
  assert.match(result.status, /Web sources used/)
  await f.run({ type: "action", action: "summarize" })
  assert.equal(f.requests.filter(request => request.connection === "searxng").length, 1)
})

test("Tavily fallback posts a JSON query to its own connection and shares the citation mapping", async () => {
  const f = await fixture({ webSearch: true, searchProvider: "tavily" }, connection => connection === "tavily"
    ? { status: 200, text: JSON.stringify({ results: [{ title: "Source", url: "https://source.test/", content: "Evidence" }] }) }
    : { status: 200, text: JSON.stringify({ choices: [{ message: { content: "Explanation [S1]." } }] }) })
  const result = await f.run({ type: "open" })
  assert.deepEqual(f.requests.map(request => request.connection), ["compatible", "tavily", "compatible", "compatible"])
  assert.equal(f.requests[1].request.method, "POST")
  assert.deepEqual(JSON.parse(f.requests[1].request.body), { query: "What is ExampleApp 2.0?", max_results: 5 })
  assert.deepEqual(result.messages.find(message => message.title === "From the web").sources, [{ title: "[S1] Source", url: "https://source.test/" }])
  const missing = await fixture({ webSearch: true, searchProvider: "tavily", tavilyEndpoint: "" })
  const unconfigured = await missing.run({ type: "open" })
  assert.match(unconfigured.status, /Tavily/)
  // The explanation and summary, which never search, still arrive; only the web section is missing.
  assert.deepEqual(missing.requests.map(request => JSON.parse(request.request.body).messages.at(-1).content.slice(0, 20)), ["Answer the title if ", "Summarize this artic"])
  assert.deepEqual(unconfigured.messages.map(message => message.title), [undefined, "Summary"])
  const failed = await fixture({ webSearch: true, searchProvider: "tavily" }, connection => connection === "tavily"
    ? { status: 401, text: "{}" } : { status: 200, text: JSON.stringify({ choices: [{ message: { content: "Answer." } }] }) })
  const failure = await failed.run({ type: "open" })
  assert.match(failure.status, /API key/)
  assert.deepEqual(failure.actions.map(action => action.id), ["retry"])
})

test("search failure offers an explicit no-search retry; auth errors never trigger fallback", async () => {
  const f = await fixture({ webSearch: true })
  const failure = await f.run({ type: "open" })
  // Only the web section searches; the explanation and summary arrive regardless.
  assert.equal(f.requests.length, 2)
  assert.deepEqual(failure.messages.map(message => message.title), [undefined, "Summary"])
  // The web section is nothing but search: Retry asks for it again, and nothing else.
  assert.deepEqual(failure.actions.map(action => action.id), ["retry"])
  await f.run({ type: "action", action: "retry" })
  assert.equal(f.requests.length, 2)
  // A follow-up question searches inline, so it can be answered without search.
  const asked = await f.run({ type: "submit", text: "Who uses it?" })
  assert.ok(asked.actions.some(action => action.id === "without-search"))
  const resumed = await f.run({ type: "action", action: "without-search" })
  assert.equal(f.requests.length, 3)
  assert.equal(resumed.messages.at(-2).text, "Who uses it?")
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
  const f = await fixture({ provider: "openai", webSearch: true, searchEndpoint: "https://search.test/search" }, (connection, request) => {
    if (connection === "searxng") return { status: 200, text: JSON.stringify({ results: [{ title: "Source", url: "https://source.test/", content: "Evidence" }] }) }
    return JSON.parse(request.body).tools ? { status: 400, text: "web_search not supported" } :
      { status: 200, text: JSON.stringify({ output: [{ content: [{ type: "output_text", text: "Answer [S1]" }] }] }) }
  })
  const result = await f.run({ type: "open" })
  // Only the web section asks for native search, and falls back once; the explanation and summary never search.
  assert.deepEqual(f.requests.map(request => request.connection), ["openai", "openai", "openai", "searxng", "openai"])
  assert.deepEqual(f.requests.map(request => request.request.body && !!JSON.parse(request.request.body).tools), [false, true, false, undefined, false])
  assert.match(result.status, /Web sources used/)
  assert.equal(result.messages.find(message => message.title === "From the web").sources[0].url, "https://source.test/")
})

test("Anthropic native citations and tool failures normalize into tray results", async () => {
  const f = await fixture({ provider: "anthropic", webSearch: true }, () => ({ status: 200, text: JSON.stringify({ content: [
    { type: "text", text: "Answer", citations: [{ type: "web_search_result_location", title: "Source", url: "https://source.test/" }] }
  ] }) }))
  const answer = await f.run({ type: "open" })
  assert.equal(answer.messages.find(message => message.title === "From the web").sources.length, 1)
  assert.match(answer.status, /Web sources used/)
  const failed = await fixture({ provider: "anthropic", webSearch: true }, (_connection, request) => ({ status: 200, text: JSON.stringify({ content: JSON.parse(request.body).tools
    ? [{ type: "web_search_tool_result", content: { type: "web_search_tool_result_error" } }] : [{ type: "text", text: "Answer" }] }) }))
  const failure = await failed.run({ type: "open" })
  assert.match(failure.status, /web search failed/)
  assert.deepEqual(failure.actions.map(action => action.id), ["retry"])
  // A follow-up whose own search fails can still be answered without it.
  assert.ok((await failed.run({ type: "submit", text: "Why?" })).actions.some(action => action.id === "without-search"))
})

test("malformed JSON, rate limits and missing SearXNG JSON remain recoverable", async () => {
  for (const [status, text, expected] of [[200, "null", /response format/], [200, "{bad", /invalid JSON/], [429, "limited", /Rate limited/]]) {
    const f = await fixture({ provider: "openai", webSearch: true, searchEndpoint: "https://search.test/" }, () => ({ status, text }))
    const result = await f.run({ type: "open" })
    assert.match(result.status, expected)
    // The explanation, web section and summary, asked at once, each fail on their own.
    assert.equal(f.requests.length, 3)
    assert.ok(result.actions.some(action => action.id === "retry"))
  }
  const search = await fixture({ webSearch: true, searchEndpoint: "https://search.test/" }, connection => connection === "searxng"
    ? { status: 200, text: "<html>JSON disabled</html>" } : { status: 200, text: JSON.stringify({ choices: [{ message: { content: "Answer." } }] }) })
  const result = await search.run({ type: "open" })
  assert.match(result.status, /JSON output/)
  assert.deepEqual(result.actions.map(action => action.id), ["retry"])
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

const VIDEO = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
const CAPTIONS = "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en"
const PLAYER = {
  playabilityStatus: { status: "OK" },
  videoDetails: { title: "Never Gonna Give You Up", author: "Rick Astley", lengthSeconds: "213", shortDescription: "The official video." },
  captions: { playerCaptionsTracklistRenderer: {
    captionTracks: [
      { baseUrl: CAPTIONS + "&kind=asr", languageCode: "en", kind: "asr", name: { simpleText: "English (auto-generated)" } },
      { baseUrl: CAPTIONS, languageCode: "en", name: { runs: [{ text: "English" }] } },
      { baseUrl: CAPTIONS.replace("lang=en", "lang=de"), languageCode: "de", name: { simpleText: "German" } }
    ],
    audioTracks: [{ captionTrackIndices: [0, 1, 2], defaultCaptionTrackIndex: 1 }], defaultAudioTrackIndex: 0
  } }
}
const XML = `<?xml version="1.0" encoding="utf-8" ?><timedtext format="3"><body><w t="0" id="1"/>
<p t="1360" d="1680" w="1">[♪♪♪]</p><p t="18790" w="1" a="1">
</p><p t="18800" d="3240"><s ac="0">We&#39;re</s><s t="239" ac="0"> no</s><s t="559"> strangers</s></p>
<p t="31000" d="4000">Second &amp;#39;paragraph&amp;#39; &lt;3</p></body></timedtext>`

/** A YouTube story: the player connection lists the tracks and `once.fetch` serves the chosen one. */
async function videoFixture(extra = {}, player = PLAYER, captions = XML) {
  const fetched = []
  const f = await fixture(extra, (connection, request) => connection === "youtube"
    ? (fetched.push(JSON.parse(request.body)), { status: 200, headers: {}, text: typeof player === "string" ? player : JSON.stringify(player) })
    : { status: 200, text: JSON.stringify({ choices: [{ message: { content: "An explanation." } }] }) },
  async url => { fetched.push(url); return { status: 200, text: captions } })
  f.story.href = VIDEO
  f.story.title = "Rick Astley - Never Gonna Give You Up"
  return { ...f, fetched }
}

test("a YouTube story is read from its captions, timestamped and headed by its details", async () => {
  const f = await videoFixture()
  const result = await f.run({ type: "open" })
  // The player is asked once, as the Android app; the manual English track wins over the auto-generated one.
  assert.equal(f.fetched.length, 2)
  assert.equal(f.fetched[0].videoId, "dQw4w9WgXcQ")
  assert.equal(f.fetched[0].context.client.clientName, "ANDROID")
  assert.equal(f.fetched[1], CAPTIONS)
  assert.equal(f.extracts(), 0)
  const ai = f.requests.filter(request => request.connection !== "youtube")
  assert.equal(ai.length, 2)
  const source = JSON.parse(JSON.parse(ai[0].request.body).messages[1].content.split("\n").slice(1).join("\n"))
  assert.equal(source.article.kind, "video transcript")
  assert.equal(source.article.title, "Never Gonna Give You Up")
  assert.equal(source.article.sourceUrl, VIDEO)
  assert.match(source.note, /transcript of a YouTube video/)
  assert.equal(source.article.text,
    "Channel: Rick Astley\n\nDuration: 3:33\n\nDescription:\nThe official video.\n\nTranscript (English):\n[0:01] [♪♪♪] We're no strangers\n[0:31] Second 'paragraph' <3")
  assert.equal(JSON.parse(ai[1].request.body).messages.at(-1).content, "Summarize this video transcript.")
  assert.equal(result.status, "Using the video transcript (English). No web sources used.")
  // The transcript is kept for the follow-up; the story is not asked again.
  await f.run({ type: "submit", text: "Who sings?" })
  assert.equal(f.fetched.length, 2)
})

test("without captions, or with transcripts off, a YouTube story falls back to the story content", async () => {
  const silent = await videoFixture({}, { playabilityStatus: { status: "OK" }, videoDetails: {} })
  let result = await silent.run({ type: "open" })
  assert.equal(silent.extracts(), 1)
  assert.equal(result.status, "Using story content. No transcript: this video has no captions. No web sources used.")
  assert.equal(result.statusTone, "info")
  const blocked = await videoFixture({}, { playabilityStatus: { status: "LOGIN_REQUIRED", reason: "Sign in to confirm your age" } })
  result = await blocked.run({ type: "open" })
  assert.match(result.status, /No transcript: YouTube: Sign in to confirm your age/)
  // A track anywhere but YouTube's caption endpoint is never fetched.
  const elsewhere = await videoFixture({}, { ...PLAYER, captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: "https://evil.test/captions", languageCode: "en" }] } } })
  result = await elsewhere.run({ type: "open" })
  assert.equal(elsewhere.fetched.length, 1)
  assert.match(result.status, /unusable caption track/)
  const off = await videoFixture({ youtubeTranscripts: false })
  result = await off.run({ type: "open" })
  assert.equal(off.fetched.length, 0)
  assert.equal(off.extracts(), 1)
  assert.equal(result.status, "Using story content. No web sources used.")
  // Any other page never asks YouTube.
  const page = await fixture()
  await page.run({ type: "open" })
  assert.ok(page.requests.every(request => request.connection !== "youtube"))
})

test("video URLs are recognised in their usual shapes; caption XML of either shape becomes paragraphs", async () => {
  const { youtubeVideoId, transcriptText, captionTrack } = await modulePromise
  for (const href of [VIDEO + "&t=42s", "https://youtu.be/dQw4w9WgXcQ?si=share", "https://m.youtube.com/shorts/dQw4w9WgXcQ",
    "https://www.youtube.com/live/dQw4w9WgXcQ", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", "https://music.youtube.com/watch?v=dQw4w9WgXcQ"]) {
    assert.equal(youtubeVideoId(href), "dQw4w9WgXcQ", href)
  }
  for (const href of ["https://www.youtube.com/@rick", "https://www.youtube.com/watch?v=short", "https://example.com/watch?v=dQw4w9WgXcQ", "not a url"]) {
    assert.equal(youtubeVideoId(href), "", href)
  }
  const legacy = "<transcript><text start=\"1.36\" dur=\"1.68\">[♪♪♪]</text><text start=\"18.64\" dur=\"3.24\">We&amp;#39;re no strangers</text><text start=\"3661\" dur=\"1\">Late</text></transcript>"
  assert.equal(transcriptText(legacy), "[0:01] [♪♪♪] We're no strangers\n[1:01:01] Late")
  assert.equal(transcriptText("<timedtext/>"), "")
  // Auto-generated captions are the last resort; the default audio track's own captions come first.
  const tracks = PLAYER.captions.playerCaptionsTracklistRenderer
  assert.equal(captionTrack(PLAYER).baseUrl, CAPTIONS)
  assert.equal(captionTrack({ captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks.captionTracks.slice(0, 1) } } }).kind, "asr")
  assert.equal(captionTrack({ captions: { playerCaptionsTracklistRenderer: { captionTracks: [tracks.captionTracks[0], tracks.captionTracks[2]] } } }).languageCode, "de")
  assert.equal(captionTrack({}), null)
})
