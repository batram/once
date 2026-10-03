// Official Safari build, pinned independently of Android's full uBlock Origin.
const fs = require("node:fs")
const path = require("node:path")
const crypto = require("node:crypto")
const AdmZip = require("adm-zip")
const { downloadExtension } = require("./download-extension")

const version = "2026.930.1227"
const sha256 = "bd280a82b74e38049fa0644e42c1d9a668516cd00e4bac26bf6991263746b9cb"
const url = `https://github.com/uBlockOrigin/uBOL-home/releases/download/${version}/uBOLite_${version}.safari.zip`
const target = path.resolve(__dirname, "../vendor/extensions/ublock-origin-lite")

async function fetchBlocker() {
  const stamp = path.join(target, ".once-bundle.json")
  if (fs.existsSync(stamp) && JSON.parse(fs.readFileSync(stamp)).sha256 === sha256) return
  const archive = await downloadExtension(url)
  if (crypto.createHash("sha256").update(archive).digest("hex") !== sha256) throw new Error("uBO Lite checksum mismatch")
  const zip = new AdmZip(archive)
  const manifest = JSON.parse(zip.readAsText("manifest.json"))
  if (manifest.version !== version || manifest.manifest_version !== 3) throw new Error("Unexpected uBO Lite manifest")
  fs.mkdirSync(target, { recursive: true })
  zip.extractAllTo(target, true)
  fs.writeFileSync(stamp, JSON.stringify({ version, sha256, url }, null, 2))
  console.log(`Bundled uBO Lite ${version} for iOS`)
}
async function main() {
  await fetchBlocker()
  // WKWebExtension hosts reserve Safari's scheme; the official Safari package
  // must still select its upstream Safari adapters under webkit-extension:.
  const flavorFile = path.join(target, "js/ext.js")
  const flavor = fs.readFileSync(flavorFile, "utf8")
  const original = "extURL.startsWith('safari-web-extension:')"
  const adapted = "(extURL.startsWith('safari-web-extension:') || extURL.startsWith('webkit-extension:'))"
  if (!flavor.includes(adapted)) {
    if (!flavor.includes(original)) throw new Error("uBO Lite platform adapter needs review")
    fs.writeFileSync(flavorFile, flavor.replace(original, adapted))
  }
  const { adaptIOSExtension } = require("./adapt-ios-extension")
  for (const item of require("./ios-extension-packages")) {
    const destination = path.resolve(__dirname, "../vendor/extensions/ios", item.directory)
    const marker = path.join(destination, ".once-bundle.json")
    const adapterHash = crypto.createHash("sha256")
      .update(fs.readFileSync(require.resolve("./adapt-ios-extension")))
      .update(fs.readFileSync(require.resolve("./ios-violentmonkey-compat")))
      .update(JSON.stringify(item)).digest("hex")
    if (fs.existsSync(marker)) {
      const previous = JSON.parse(fs.readFileSync(marker))
      if (previous.sha256 === item.sha256 && previous.adapterHash === adapterHash) continue
    }
    const data = await downloadExtension(item.url)
    if (crypto.createHash("sha256").update(data).digest("hex") !== item.sha256) throw new Error(`${item.name} checksum mismatch`)
    // Build next to the installed package; a failed adaptation leaves it intact.
    const staging = path.join(path.dirname(destination), `.${item.directory}.staging`)
    fs.rmSync(staging, { recursive: true, force: true })
    fs.mkdirSync(staging, { recursive: true })
    new AdmZip(data).extractAllTo(staging, true)
    adaptIOSExtension(staging, item)
    fs.writeFileSync(path.join(staging, ".once-bundle.json"), JSON.stringify({ ...item, adapterHash }, null, 2))
    fs.rmSync(destination, { recursive: true, force: true })
    fs.renameSync(staging, destination)
    console.log(`Bundled ${item.name} ${item.version} for iOS`)
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
