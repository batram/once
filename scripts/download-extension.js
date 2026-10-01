const { setTimeout: delay } = require("node:timers/promises")

const transientStatuses = new Set([408, 429, 500, 502, 503, 504])
const transientCodes = new Set([
  "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET"
])

// Retry transport failures only. The caller still verifies the pinned hash
// before unpacking; invalid archives, certificates and permanent HTTP errors
// remain failures, rather than being hidden by a retry of the whole build.
async function downloadExtension(url, { request = fetch, wait = delay, warn = console.warn } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await request(url, { redirect: "follow" })
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        throw Object.assign(new Error(`${url}: HTTP ${response.status}`), { status: response.status })
      }
      return Buffer.from(await response.arrayBuffer())
    } catch (error) {
      const transient = transientStatuses.has(error.status) ||
        transientCodes.has(error.cause?.code ?? error.code)
      if (!transient || attempt === 2) throw error
      warn(`Retrying extension download (${attempt + 2}/3): ${url}: ${error.message}`)
      await wait((attempt + 1) * 1000)
    }
  }
}

module.exports = { downloadExtension }
