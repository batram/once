// The Once add-ons that ship inside every app: each package's files are
// read here at build time and inlined into the UI bundle as the
// `__ONCE_BUNDLED_ADDONS__` constant, so an install carries them with no
// extra files to serve. The UI installs them on first start; the user can
// remove one, and the import page offers it again. Adding a package here
// is how it starts shipping; bumping its version in its manifest is how an
// update reaches users who kept it.

const fs = require("node:fs")
const path = require("node:path")

const root = path.resolve(__dirname, "..")

const BUNDLED = [
  path.join(root, "examples", "addons", "what-wait-who-why")
]

function readPackage(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "once-addon.json"), "utf8"))
  const files = { "once-addon.json": fs.readFileSync(path.join(directory, "once-addon.json"), "utf8") }
  const script = typeof manifest.script === "string" ? manifest.script : manifest.script?.file ?? manifest.script?.url
  if (typeof script === "string") files[script] = fs.readFileSync(path.join(directory, script), "utf8")
  return { files }
}

/** What the UI receives: every bundled package's files by name. */
function bundledAddons() {
  return BUNDLED.map(readPackage)
}

module.exports = { bundledAddons }
