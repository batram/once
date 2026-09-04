const test = require("node:test")
const fs = require("node:fs/promises")
const path = require("node:path")
const { installDomGlobals } = require("../../helpers/dom")
const { assertStories } = require("../../helpers/collector-contract")
const { parse_response, resolveStorySource } = require("../../../packages/collectors/dist")
const { sources, fetchSource, SourceUnavailableError } = require("../source-cases")

installDomGlobals()

// parse_response no longer looks a collector up itself: resolution does that,
// and validates the configuration at the same time.
function resolve(url) {
  const resolved = resolveStorySource({ url })
  if (resolved.problem) throw new Error(resolved.problem)
  return resolved
}

for (const [name, source] of Object.entries(sources)) {
  test(`live ${name} source still satisfies its collector contract`, async (t) => {
    let bytes
    try {
      try {
        bytes = await fetchSource(source)
      } catch (error) {
        if (error instanceof SourceUnavailableError) {
          t.skip(`${source.url} unavailable: ${error.message}`)
          return
        }
        throw error
      }
      const stories = await parse_response(
        new Response(bytes),
        resolve(source.url)
      )
      assertStories(stories, source.type)
    } catch (error) {
      console.log(error)
      if (bytes) {
        const artifactDir = path.resolve(
          __dirname,
          "../../../test-results/live-collectors"
        )
        await fs.mkdir(artifactDir, { recursive: true })
        await fs.writeFile(
          path.join(artifactDir, `${name}.${source.extension}`),
          bytes
        )
      }
      throw new Error(
        `${name} (${source.url}) failed compatibility: ${error instanceof Error ? error.message : error}`
      )
    }
  })
}
