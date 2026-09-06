const fs = require("node:fs/promises")
const path = require("node:path")
const crypto = require("node:crypto")
const AdmZip = require("adm-zip")
async function main() {
  for (const slug of ["sponsorblock", "darkreader"]) {
    const response = await fetch(`https://addons.mozilla.org/api/v5/addons/addon/${slug}/`)
    if (!response.ok) throw new Error(`AMO ${response.status}`)
    const meta = await response.json()
    const file = meta.current_version.file
    const data = Buffer.from(await (await fetch(file.url)).arrayBuffer())
    const hash = `sha256:${crypto.createHash("sha256").update(data).digest("hex")}`
    if (hash !== file.hash) throw new Error("Hash mismatch")
    const directory = path.resolve("artifacts/extension-support", slug)
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(path.join(directory, "package.xpi"), data)
    const zip = new AdmZip(data)
    const manifest = JSON.parse(zip.readAsText("manifest.json"))
    await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest, null, 2))
    const apis = new Set()
    for (const entry of zip.getEntries()) {
      if (!entry.entryName.endsWith(".js")) continue
      for (const match of entry.getData().toString().matchAll(/(?:chrome|browser)\.([A-Za-z]+)\.([A-Za-z]+)/g)) apis.add(`${match[1]}.${match[2]}`)
    }
    console.log(JSON.stringify({ slug, id: meta.guid, version: meta.current_version.version, url: file.url, hash, manifest, apis: [...apis].sort() }, null, 2))
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
