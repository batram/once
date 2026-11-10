const fs = require("node:fs")
const path = require("node:path")

const iosSources = path.resolve(__dirname, "../../../apps/mobile/ios/App/App")

function readSwift(name) {
  return fs.readFileSync(path.join(iosSources, name), "utf8")
}

/**
 * The text of `source` from `start` up to `end`, for pasting production Swift
 * into a harness. A renamed anchor fails here by name: String#slice would take
 * a -1 index and hand the compiler an empty or far too large excerpt.
 */
function swiftSlice(source, start, end) {
  const from = source.indexOf(start)
  if (from < 0) throw new Error(`Swift anchor not found: ${JSON.stringify(start)}`)
  if (end === undefined) return source.slice(from)
  const to = source.indexOf(end, from + start.length)
  if (to < 0) throw new Error(`Swift anchor not found after ${JSON.stringify(start)}: ${JSON.stringify(end)}`)
  return source.slice(from, to)
}

module.exports = { readSwift, swiftSlice }
