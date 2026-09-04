const sources = {
  hackernews: { url: "https://news.ycombinator.com/", extension: "html", type: "HN" },
  lobsters: { url: "https://lobste.rs/", extension: "html", type: "LO" },
  reddit_json: { url: "https://old.reddit.com/r/netsec/.json", extension: "json", type: "re" },
  reddit_rss: { url: "https://old.reddit.com/r/netsec/.rss", extension: "xml", type: "re" }
}

const MAX_RESPONSE_BYTES = 1_000_000
const TIMEOUT_MS = 15_000

// The upstream refuses anonymous readers. That is not a collector regression,
// so callers skip rather than fail on it.
class SourceUnavailableError extends Error {}

async function fetchSource(source) {
  const response = await fetch(source.url, {
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      accept: "application/json, application/atom+xml, application/rss+xml, text/html;q=0.9, */*;q=0.1",
      "user-agent": "once-collector-compatibility-check/1.0 (manual single-request probe)"
    }
  })
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location") || ""
    // Reddit answers logged-out readers with a redirect to /login/?reason=lor2.
    if (/\/login\b/.test(location)) {
      throw new SourceUnavailableError(`requires login: redirects to ${location}`)
    }
    throw new Error(`unexpected redirect to ${location}`)
  }
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

module.exports = { sources, fetchSource, SourceUnavailableError }
