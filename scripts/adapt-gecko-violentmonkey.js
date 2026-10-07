// Builds the Android copy of the pinned Violentmonkey bundle: upstream's code
// unchanged, plus the relay through which the app hands it synced userscripts
// (scripts/gecko-violentmonkey-relay.js). Electron loads the untouched bundle;
// this copy lives under vendor/extensions/android, which only Android packages.

const crypto = require("node:crypto")
const fs = require("node:fs")
const path = require("node:path")

const RELAY = path.join(__dirname, "gecko-violentmonkey-relay.js")

/** Changes whenever the adaptation would produce a different copy. */
function adapterHash(upstreamSha256) {
  return crypto.createHash("sha256")
    .update(upstreamSha256)
    .update(fs.readFileSync(__filename))
    .update(fs.readFileSync(RELAY))
    .digest("hex")
}

function adaptManifest(manifest, hash) {
  if (manifest.manifest_version !== 2 || manifest.background?.scripts?.join() !== "background/index.js") {
    throw new Error("Expected the pinned Violentmonkey MV2 background; the Android relay needs review")
  }
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error(`Unexpected Violentmonkey version ${manifest.version}`)
  // After upstream's background, so the command handler it exports exists.
  manifest.background = { ...manifest.background, scripts: [...manifest.background.scripts, "once-relay.js"] }
  // Native messaging is what the relay talks over; GeckoView grants it only to
  // built-in extensions that also hold geckoViewAddons.
  manifest.permissions = [...new Set([...manifest.permissions, "nativeMessaging", "geckoViewAddons"])]
  // GeckoView reinstalls a built-in only when its version changes, so a new
  // relay over the same upstream release has to read as a new version.
  manifest.version = `${manifest.version}.${parseInt(hash.slice(0, 6), 16)}`
  return manifest
}

/** Writes the adapted copy of `source` to `target`, replacing what was there. */
function adaptGeckoViolentmonkey(source, target, upstreamSha256) {
  const hash = adapterHash(upstreamSha256)
  try {
    if (JSON.parse(fs.readFileSync(path.join(target, ".once-bundle.json"), "utf8")).adapterHash === hash) return false
  } catch {
    // Not built yet.
  }
  const background = fs.readFileSync(path.join(source, "background/index.js"), "utf8")
  if (!background.includes("a.handleCommandMessage=Vm") || !background.includes("a=this")) {
    throw new Error("Violentmonkey no longer exports handleCommandMessage; the Android relay needs review")
  }
  // The relay turns on synchronous page mode through the dashboard's command.
  if (!background.includes("SetOptions(e){") || !background.includes("xhrInject:")) {
    throw new Error("Violentmonkey no longer offers synchronous page mode; the Android relay needs review")
  }
  // Build beside the installed copy; a failed adaptation leaves it intact.
  const staging = path.join(path.dirname(target), `.${path.basename(target)}.staging`)
  fs.rmSync(staging, { recursive: true, force: true })
  fs.cpSync(source, staging, { recursive: true, filter: file => path.basename(file) !== ".once-bundle.json" })
  const manifestFile = path.join(staging, "manifest.json")
  const manifest = adaptManifest(JSON.parse(fs.readFileSync(manifestFile, "utf8")), hash)
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n")
  fs.copyFileSync(RELAY, path.join(staging, "once-relay.js"))
  fs.writeFileSync(path.join(staging, ".once-bundle.json"), JSON.stringify({
    upstreamSha256, adapterHash: hash, version: manifest.version
  }, null, 2))
  fs.rmSync(target, { recursive: true, force: true })
  fs.renameSync(staging, target)
  return true
}

module.exports = { adaptGeckoViolentmonkey, adaptManifest }
