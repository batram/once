const sources = {
  hackernews: { url: "https://news.ycombinator.com/", extension: "html", type: "HN" },
  lobsters: { url: "https://lobste.rs/", extension: "html", type: "LO" },
  reddit_json: { url: "https://old.reddit.com/r/netsec/.json", extension: "json", type: "re" },
  reddit_rss: { url: "https://old.reddit.com/r/netsec/.rss", extension: "xml", type: "re" },
  nitter: { url: "https://nitter.net/jack", extension: "html", type: "tw" }
}

const MAX_RESPONSE_BYTES = 1_000_000
const TIMEOUT_MS = 15_000

async function fetchSource(source) {
  const response = await fetch(source.url, {
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      accept: "application/json, application/atom+xml, application/rss+xml, text/html;q=0.9, */*;q=0.1",
      "user-agent": "once-collector-compatibility-check/1.0 (manual single-request probe)"
    }
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
  const declaredSize = Number(response.headers.get("content-length") || 0)
  if (declaredSize > MAX_RESPONSE_BYTES) throw new Error(`response declares ${declaredSize} bytes`)
  const reader = response.body?.getReader()
  if (!reader) throw new Error("response has no body")
  const chunks = []
  let received = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > MAX_RESPONSE_BYTES) {
      await reader.cancel("response too large")
      throw new Error(`response exceeds ${MAX_RESPONSE_BYTES} bytes`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks, received)
}

module.exports = { sources, fetchSource }
