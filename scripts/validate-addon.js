// Validate a local package without evaluating its code or making network requests.
const fs = require("node:fs")
const path = require("node:path")
const crypto = require("node:crypto")
const { readAddonManifest, SANDBOX_LIMITS } = require("../packages/core/dist")

function main() {
  const directory = path.resolve(process.argv[2] || ".")
  const file = path.join(directory, "once-addon.json")
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"))
  if (manifest.script) {
    const relative = typeof manifest.script === "string" ? manifest.script : manifest.script.url
    if (typeof relative !== "string" || /^[a-z]+:/i.test(relative)) throw new Error("Use a package-relative script URL for local validation")
    const script = path.resolve(directory, relative)
    if (!script.startsWith(directory + path.sep)) throw new Error("The script must stay inside the package")
    const bytes = fs.readFileSync(script)
    if (bytes.length > SANDBOX_LIMITS.code) throw new Error("The script exceeds the size limit")
    const integrity = `sha256-${crypto.createHash("sha256").update(bytes).digest("base64")}`
    if (typeof manifest.script === "object" && manifest.script.integrity !== integrity) {
      throw new Error(`Script integrity mismatch; expected ${integrity}`)
    }
    manifest.script = { url: new URL(relative.replace(/\\/g, "/"), "https://package.invalid/").href, integrity }
    console.log(`Script: ${bytes.length} bytes; ${integrity}`)
  }
  const result = readAddonManifest(manifest)
  if (!result.ok) throw new Error(result.reports.map(report => `${report.path}: ${report.message}`).join("\n"))
  console.log(`Valid add-on: ${result.manifest.name} ${result.manifest.version}`)
}

try { main() } catch (error) { console.error(error.message); process.exitCode = 1 }
