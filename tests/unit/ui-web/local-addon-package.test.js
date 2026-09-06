const test = require("node:test")
const assert = require("node:assert/strict")
const { ZipWriter, BlobWriter, TextReader } = require("@zip.js/zip.js")
const { readAddonZip, readAddonFolder } = require("../../../packages/ui-web/dist/addons/localAddonPackage")
const manifest = { protocol: 1, id: "local-example", name: "Local example", version: "1", script: "main.js", contributions: [] }
const code = "export default function activate(once) { once.onAction(() => {}); }"
async function zip(files) {
  const writer = new ZipWriter(new BlobWriter(), { useWebWorkers: false })
  for (const [name, content] of Object.entries(files)) await writer.add(name, new TextReader(content))
  return writer.close()
}

test("ZIP import finds a wrapped manifest, computes integrity and uses the local script cache", async () => {
  const pack = await readAddonZip(await zip({ "example/once-addon.json": JSON.stringify(manifest), "example/main.js": code }))
  assert.equal(pack.entry.manifest.id, manifest.id)
  assert.equal(pack.code, code)
  assert.match(pack.entry.manifest.script.url, /^once-addon:\/\/local\//)
  assert.match(pack.entry.manifest.script.integrity, /^sha256-/)
  assert.equal(pack.entry.source, undefined)
})

test("folder import accepts package manifests and refuses mismatched hashes", async () => {
  const files = [new File([JSON.stringify(manifest)], "once-addon.json"), new File([code], "main.js")]
  const pack = await readAddonFolder(files)
  assert.equal(pack.code, code)
  const mismatched = { ...manifest, script: { url: "main.js", integrity: "sha256-wrong" } }
  await assert.rejects(readAddonFolder([new File([JSON.stringify(mismatched)], "once-addon.json"), files[1]]), /integrity/)
})

test("invalid archives and packages fail before installation", async () => {
  await assert.rejects(readAddonZip(new Blob(["not a zip"])))
  await assert.rejects(readAddonZip(new Blob([new Uint8Array(8 * 1024 * 1024 + 1)])), /too large/)
  await assert.rejects(readAddonZip(await zip({ "once-addon.json": JSON.stringify(manifest) })), /missing its script/)
  await assert.rejects(readAddonZip(await zip({ "once-addon.json": "{}", "second/once-addon.json": "{}" })), /exactly one/)
  await assert.rejects(readAddonFolder([new File(["{}"], "../once-addon.json")]), /unsafe/)
})

test("local packages cannot resolve their scripts outside the selected folder or over the network", async () => {
  for (const script of ["../main.js", "/main.js", "https://example.test/main.js", "C:\\main.js"]) {
    await assert.rejects(readAddonFolder([new File([JSON.stringify({ ...manifest, script })], "once-addon.json")]), /unsafe/)
  }
})
