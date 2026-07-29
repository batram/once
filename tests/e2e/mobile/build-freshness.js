const fs = require("fs")
const path = require("path")

const root = path.resolve(__dirname, "../../..")
const appRoot = path.join(root, "apps", "mobile")

// Generated during builds; changes here must not count as source changes.
const generatedNames = new Set([
  "node_modules", "dist", "build", ".gradle", "output", "DerivedData",
  "xcuserdata", "public", "capacitor.config.json", "capacitor.plugins.json",
  "config.xml"
])

function newestSourceTime(target) {
  const stat = fs.statSync(target, { throwIfNoEntry: false })
  if (!stat) return 0
  if (!stat.isDirectory()) return stat.mtimeMs
  let newest = 0
  for (const entry of fs.readdirSync(target)) {
    if (generatedNames.has(entry)) continue
    newest = Math.max(newest, newestSourceTime(path.join(target, entry)))
  }
  return newest
}

function packageSources() {
  return fs.readdirSync(path.join(root, "packages"))
    .map((name) => path.join(root, "packages", name, "src"))
}

function readStamp(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(appRoot, "dist", name), "utf8"))
  } catch {
    return null
  }
}

// Why the web bundle in apps/mobile/dist cannot be trusted for an e2e run, or
// null when it can. A non-e2e bundle starts a network story load that replaces
// rows mid-gesture, so it must be rebuilt rather than tested.
function webBundleStaleness(sources) {
  if (!fs.existsSync(path.join(appRoot, "dist", "mobile.js"))) {
    return "the web bundle is missing"
  }
  const stamp = readStamp(".once-web-build.json")
  if (!stamp) return "there is no build stamp from `mobile web`"
  if (!stamp.e2e) return "the last build was not an --e2e build (`npm run check` overwrites it)"
  if (stamp.channel !== "dev") return `the last build was for the ${stamp.channel} channel`
  if (sources.some((source) => newestSourceTime(source) > stamp.builtAt)) {
    return "sources changed since the last build"
  }
  return null
}

module.exports = { root, appRoot, newestSourceTime, packageSources, readStamp, webBundleStaleness }
