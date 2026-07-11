const test = require("node:test")
const fs = require("node:fs/promises")
const path = require("node:path")
const { installDomGlobals } = require("../../helpers/dom")
const { assertStories } = require("../../helpers/collector-contract")
const { parse_response } = require("../../../packages/collectors/dist")
const { sources, fetchSource } = require("../source-cases")

installDomGlobals()

for (const [name, source] of Object.entries(sources)) {
  test(`live ${name} source still satisfies its collector contract`, async () => {
    let bytes
    try {
      bytes = await fetchSource(source)
      const stories = await parse_response(
        new Response(bytes),
        source.url,
        source.url,
      )
      assertStories(stories, source.type)
    } catch (error) {
      console.log(error)
      if (bytes) {
        const artifactDir = path.resolve(
          __dirname,
          "../../../test-results/live-collectors",
        )
        await fs.mkdir(artifactDir, { recursive: true })
        await fs.writeFile(
          path.join(artifactDir, `${name}.${source.extension}`),
          bytes,
        )
      }
      throw new Error(
        `${name} (${source.url}) failed compatibility: ${error instanceof Error ? error.message : error}`,
      )
    }
  })
}
