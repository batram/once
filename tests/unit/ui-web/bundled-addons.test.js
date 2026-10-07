const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const { readAddonsDocument } = require("../../../packages/core/dist/addons")
const { bundledAddons } = require("../../../scripts/bundled-addons")
const {
  configureBundledAddons, listBundledAddons, seedBundledAddons, bundledAddonScript, isBundledAddon
} = require("../../../packages/ui-web/dist/addons/bundledAddons")
const { verifiedAddonScript } = require("../../../packages/ui-web/dist/addons/addonPackage")

const directory = path.resolve(__dirname, "../../../examples/addons/what-wait-who-why")
const shipped = JSON.parse(fs.readFileSync(path.join(directory, "once-addon.json"), "utf8"))

/** A client over an in-memory document and script cache, counting writes. */
function fakeClient(initial = { version: 1, addons: [] }, vault = "disabled") {
  const state = { doc: readAddonsDocument(initial), scripts: new Map(), writes: 0 }
  const client = {
    getAddonVaultStatus: async () => ({ state: vault, message: "", protectedStorage: false }),
    getAddons: async () => structuredClone(state.doc),
    updateAddons: async change => {
      const next = readAddonsDocument(change(structuredClone(state.doc)))
      if (JSON.stringify(next) !== JSON.stringify(state.doc)) state.writes++
      state.doc = next
    },
    getAddonScript: async integrity => state.scripts.get(integrity) ?? null,
    storeAddonScript: async (integrity, code) => { state.scripts.set(integrity, code) },
    fetchText: async () => { throw new Error("nothing is fetched for a bundled package") }
  }
  return { client, state }
}

test("the build inlines the shipped package, which reads as a bundled local package", async () => {
  const packages = bundledAddons()
  assert.equal(packages.length, 1)
  assert.deepEqual(Object.keys(packages[0].files).sort(), ["main.js", "once-addon.json"])
  configureBundledAddons(packages)
  const [pack] = await listBundledAddons()
  assert.equal(pack.entry.manifest.id, shipped.id)
  assert.equal(pack.entry.manifest.version, shipped.version)
  assert.equal(pack.entry.manifest.script.url, `once-addon://bundled/${shipped.id}/main.js`)
  assert.equal(pack.code, packages[0].files["main.js"])
  assert.equal(await bundledAddonScript(pack.entry.manifest.script.integrity), pack.code)
  assert.equal(await bundledAddonScript("sha256-other"), null)
  assert.equal(isBundledAddon(pack.entry), true)
})

test("a fresh document takes the package in once; removing it keeps it out", async () => {
  configureBundledAddons(bundledAddons())
  const { client, state } = fakeClient()
  await seedBundledAddons(client)
  assert.equal(state.writes, 1)
  assert.equal(state.doc.addons.length, 1)
  assert.equal(state.doc.addons[0].enabled, true)
  assert.deepEqual(state.doc.bundled, { [shipped.id]: shipped.version })
  const { integrity } = state.doc.addons[0].manifest.script
  assert.equal(typeof state.scripts.get(integrity), "string", "the script is cached before the entry is written")
  await seedBundledAddons(client)
  assert.equal(state.writes, 1, "a second pass writes nothing")
  state.doc = readAddonsDocument({ ...state.doc, addons: [] })
  await seedBundledAddons(client)
  assert.equal(state.doc.addons.length, 0, "a removed package is not offered again")
  assert.equal(state.writes, 1)
})

test("a newer shipped version replaces a still-installed bundled copy but not the user's own install", async () => {
  const older = bundledAddons().map(({ files }) => ({ files: { ...files,
    "once-addon.json": JSON.stringify({ ...shipped, version: "0.9.0" }) } }))
  configureBundledAddons(older)
  const { client, state } = fakeClient()
  await seedBundledAddons(client)
  state.doc = readAddonsDocument({ ...state.doc, addons: state.doc.addons.map(entry => ({ ...entry, enabled: false, options: { provider: "anthropic" } })) })
  configureBundledAddons(bundledAddons())
  await seedBundledAddons(client)
  assert.equal(state.doc.addons[0].manifest.version, shipped.version)
  assert.equal(state.doc.addons[0].enabled, false, "the upgrade keeps the user's enabled flag")
  assert.equal(state.doc.addons[0].options.provider, "anthropic", "and their options")
  assert.deepEqual(state.doc.bundled, { [shipped.id]: shipped.version })

  const own = fakeClient({ version: 1, addons: [{ manifest: { ...shipped, version: "5.0.0",
    script: { url: "https://example.test/main.js", integrity: "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" } } }] })
  assert.equal(own.state.doc.addons.length, 1)
  await seedBundledAddons(own.client)
  assert.equal(own.state.doc.addons[0].manifest.version, "5.0.0", "an install of the user's own is left alone")
  assert.deepEqual(own.state.doc.bundled, { [shipped.id]: shipped.version })
  // Every client seeds on start: a newer build must not rewrite the record, or
  // two devices updated together write the same change at once and conflict.
  const writes = own.state.writes
  configureBundledAddons(bundledAddons().map(({ files }) => ({ files: { ...files,
    "once-addon.json": JSON.stringify({ ...shipped, version: "99.0.0" }) } })))
  await seedBundledAddons(own.client)
  assert.equal(own.state.writes, writes, "a newer build beside the user's own install writes nothing")
  own.state.doc = readAddonsDocument({ ...own.state.doc, addons: [] })
  await seedBundledAddons(own.client)
  assert.equal(own.state.doc.addons.length, 0, "and removing that install does not bring the package in")
})

test("different app versions converge without downgrading packages or reviving removals", async () => {
  const bundle = version => bundledAddons().map(({ files }) => ({ files: { ...files,
    "once-addon.json": JSON.stringify({ ...shipped, version }) } }))
  const { client, state } = fakeClient()
  configureBundledAddons(bundle("1.5.0"))
  await seedBundledAddons(client)
  configureBundledAddons(bundle("1.6.0"))
  await seedBundledAddons(client)
  for (let i = 0; i < 6; i++) {
    configureBundledAddons(bundle(i % 2 ? "1.6.0" : "1.5.0"))
    await seedBundledAddons(client)
    assert.equal(state.doc.addons[0].manifest.version, "1.6.0")
    assert.equal(state.doc.bundled[shipped.id], "1.6.0")
  }
  assert.equal(state.writes, 2)
  state.doc.addons = []
  configureBundledAddons(bundle("1.5.0"))
  await seedBundledAddons(client)
  assert.equal(state.doc.addons.length, 0)
  assert.equal(state.writes, 2)
})

test("bundle comparison respects numeric versions and prereleases, and leaves unknown formats alone", async () => {
  for (const [installed, bundled, expected] of [["1.9.0", "1.10.0", "1.10.0"], ["2.0.0", "2.0.0-beta.1", "2.0.0"],
    ["2.0.0-beta.2", "2.0.0-beta.10", "2.0.0-beta.10"], ["2.0.0-beta.10", "2.0.0", "2.0.0"], ["custom", "1.6.0", "custom"]]) {
    const bundle = version => bundledAddons().map(({ files }) => ({ files: { ...files, "once-addon.json": JSON.stringify({ ...shipped, version }) } }))
    const { client, state } = fakeClient()
    configureBundledAddons(bundle(installed))
    await seedBundledAddons(client)
    configureBundledAddons(bundle(bundled))
    await seedBundledAddons(client)
    assert.equal(state.doc.addons[0].manifest.version, expected)
  }
})

test("a locked vault is left alone, and a synced bundled entry runs from the build's copy", async () => {
  configureBundledAddons(bundledAddons())
  const locked = fakeClient({ version: 1, addons: [] }, "locked")
  await seedBundledAddons(locked.client)
  assert.equal(locked.state.writes, 0)

  const [pack] = await listBundledAddons()
  const { client, state } = fakeClient()
  assert.equal(await verifiedAddonScript(client, pack.entry.manifest), pack.code)
  assert.equal(state.scripts.get(pack.entry.manifest.script.integrity), pack.code, "and is cached for next time")
  const foreign = { ...pack.entry.manifest, script: { ...pack.entry.manifest.script, integrity: "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" } }
  await assert.rejects(verifiedAddonScript(client, foreign), /not bundled with this Once/)
})
