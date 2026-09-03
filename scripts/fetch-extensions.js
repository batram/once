// Downloads the pinned extension bundles the Android app builds in as
// GeckoView built-ins, verifies them against their recorded hashes, and
// unpacks them under apps/mobile/extensions/vendor. The bundles are
// third-party code and stay out of the repository; this script is the
// record of exactly which builds the app ships.

const crypto = require("node:crypto")
const fs = require("node:fs")
const path = require("node:path")
const AdmZip = require("adm-zip")

const root = path.resolve(__dirname, "..")
const vendorRoot = path.join(root, "apps", "mobile", "extensions", "vendor")

const BUNDLES = [
  {
    name: "ublock-origin",
    id: "uBlock0@raymondhill.net",
    version: "1.74.0",
    url: "https://github.com/gorhill/uBlock/releases/download/1.74.0/uBlock0_1.74.0.firefox.signed.xpi",
    sha256: "175756d74468c9ba45863f7fc333d3be670f82d5b066314e915814dd547d1652"
  },
  {
    name: "violentmonkey",
    id: "{aecec67f-0d10-4fa7-b7c7-609a2db280cf}",
    version: "2.48.0",
    url: "https://github.com/violentmonkey/violentmonkey/releases/download/v2.48.0/Violentmonkey-webext-v2.48.0.zip",
    sha256: "e45efc89f485185e1f07b6e68050692bc241cbdf6058230b5f134e27ecdd083a"
  }
]

function stampPath(bundle) {
  return path.join(vendorRoot, bundle.name, ".once-bundle.json")
}

function isCurrent(bundle) {
  try {
    const stamp = JSON.parse(fs.readFileSync(stampPath(bundle), "utf8"))
    return stamp.sha256 === bundle.sha256
  } catch {
    return false
  }
}

async function download(url) {
  const response = await fetch(url, { redirect: "follow" })
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

async function fetchBundle(bundle) {
  if (isCurrent(bundle)) {
    console.log(`${bundle.name} ${bundle.version} is present`)
    return
  }
  console.log(`Downloading ${bundle.name} ${bundle.version}`)
  const archive = await download(bundle.url)
  const digest = crypto.createHash("sha256").update(archive).digest("hex")
  if (digest !== bundle.sha256) {
    throw new Error(`${bundle.name}: hash ${digest} does not match the pinned ${bundle.sha256}`)
  }
  const target = path.join(vendorRoot, bundle.name)
  fs.rmSync(target, { recursive: true, force: true })
  fs.mkdirSync(target, { recursive: true })
  new AdmZip(archive).extractAllTo(target, true)
  const manifest = JSON.parse(fs.readFileSync(path.join(target, "manifest.json"), "utf8"))
  const id = manifest.browser_specific_settings?.gecko?.id ?? manifest.applications?.gecko?.id
  if (id !== bundle.id) throw new Error(`${bundle.name}: manifest id ${id} is not ${bundle.id}`)
  fs.writeFileSync(stampPath(bundle), JSON.stringify({
    id: bundle.id, version: manifest.version, sha256: bundle.sha256, url: bundle.url
  }, null, 2))
  console.log(`Unpacked ${bundle.name} ${manifest.version}`)
}

async function main() {
  fs.mkdirSync(vendorRoot, { recursive: true })
  for (const bundle of BUNDLES) await fetchBundle(bundle)
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
