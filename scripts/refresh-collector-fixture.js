const fs = require("node:fs/promises")
const path = require("node:path")
const { sources, fetchSource, SourceUnavailableError } = require("../tests/live/source-cases")
const { installDomGlobals } = require("../tests/helpers/dom")
const { assertStories } = require("../tests/helpers/collector-contract")
const { parse_response, resolveStorySource } = require("../packages/collectors/dist")

// parse_response no longer looks a collector up itself: resolution does that,
// and validates the configuration at the same time.
function resolve(url) {
  const resolved = resolveStorySource({ url })
  if (resolved.problem) throw new Error(resolved.problem)
  return resolved
}

async function main() {
  const name = process.argv[2]
  if (!name || !sources[name]) {
    throw new Error(`Choose exactly one source: ${Object.keys(sources).join(", ")}`)
  }
  installDomGlobals()
  const source = sources[name]
  const bytes = await fetchSource(source)
  const stories = await parse_response(new Response(bytes), resolve(source.url))
  assertStories(stories, source.type)
  const directory = path.resolve(__dirname, "../tests/fixtures/collectors/live")
  await fs.mkdir(directory, { recursive: true })
  const destination = path.join(directory, `${name}.${source.extension}`)
  const output = source.extension === "json"
    ? `${JSON.stringify(JSON.parse(bytes.toString("utf8")), null, 2)}\n`
    : bytes
  await fs.writeFile(destination, output)
  process.stdout.write(`Refreshed ${destination}; review the diff before committing.\n`)
}

main().catch((error) => {
  if (error instanceof SourceUnavailableError) {
    console.error(`Source unavailable, fixture left untouched: ${error.message}`)
  } else {
    console.error(error instanceof Error ? error.message : error)
  }
  process.exitCode = 1
})
