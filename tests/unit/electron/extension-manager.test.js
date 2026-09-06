const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs/promises")
const syncFs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const Module = require("node:module")
const ts = require("typescript")
const AdmZip = require("adm-zip")
const originalLoad = Module._load
Module._load = function (name, parent, main) {
  if (name === "electron") return { app: { getLocale: () => "en" }, protocol: { registerSchemesAsPrivileged() {} } }
  return originalLoad.call(this, name, parent, main)
}
Module._extensions[".ts"] = (module, filename) => module._compile(ts.transpileModule(syncFs.readFileSync(filename, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
}).outputText, filename)
const { ExtensionManager } = require("../../../apps/electron/src/extensions/ExtensionManager.ts")
const { unpackExtension, amoSlug } = require("../../../apps/electron/src/extensions/ExtensionPackage.ts")
const { loadUnpackedExtension } = require("../../../apps/electron/src/extensions/LoadedExtension.ts")
const { ExtensionStorage } = require("../../../apps/electron/src/extensions/ExtensionStorage.ts")

async function harness(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "once-extension-manager-"))
  t.after(() => fs.rm(root, { force: true, recursive: true }))
  const hosts = new Map()
  const runtime = {
    load: async (directory, id) => {
      const extension = await loadUnpackedExtension(directory, "en")
      if (id && extension.id !== id) throw new Error("Wrong ID")
      if (extension.manifest.version === "broken") throw new Error("Cannot boot replacement")
      hosts.set(extension.id, { extension, storage: new ExtensionStorage(path.join(root, "local.json")),
        syncStorage: new ExtensionStorage(path.join(root, "sync.json")), contexts: { emit() {} } })
      return extension
    },
    unload: async host => { for (const [id, item] of hosts) if (item.extension.host === host) hosts.delete(id) },
    host: id => hosts.get(id), changed() {}
  }
  const manager = new ExtensionManager(root, runtime)
  await manager.restore([])
  const xpi = async version => {
    const zip = new AdmZip()
    zip.addFile("manifest.json", Buffer.from(JSON.stringify({ manifest_version: 2, name: "Test extension", version,
      browser_specific_settings: { gecko: { id: "test@example.org" } }, permissions: ["storage"] })))
    const file = path.join(root, `${version}.xpi`)
    await fs.writeFile(file, zip.toBuffer())
    return file
  }
  return { root, hosts, runtime, manager, xpi }
}

test("preview does not run code; install, disabled updates, restart, rollback and removal preserve identity", async t => {
  const h = await harness(t)
  const preview = await h.manager.preview("", await h.xpi("1"))
  assert.equal(h.hosts.size, 0)
  await h.manager.install(preview.token)
  assert.equal((await h.manager.list())[0].running, true)
  await h.manager.setEnabled(preview.id, false)
  const update = await h.manager.preview("", await h.xpi("2"))
  await h.manager.install(update.token)
  assert.equal((await h.manager.list())[0].enabled, false)
  const restarted = new ExtensionManager(h.root, h.runtime)
  await restarted.restore([])
  assert.equal((await restarted.list())[0].running, false)
  await restarted.setEnabled(preview.id, true)
  const broken = await restarted.preview("", await h.xpi("broken"))
  await assert.rejects(restarted.install(broken.token), /Cannot boot/)
  assert.equal((await restarted.list())[0].version, "2")
  assert.equal((await restarted.list())[0].running, true)
  await restarted.remove(preview.id)
  assert.deepEqual(await restarted.list(), [])
})

test("selected sync keys are applied with deletions while local-only keys survive", async t => {
  const h = await harness(t)
  const preview = await h.manager.preview("", await h.xpi("1"))
  await h.manager.install(preview.token)
  const host = h.hosts.get(preview.id)
  await h.manager.watch(host)
  await host.storage.set({ theme: "light", removed: true, privateToken: "keep" })
  await h.manager.applySync({ version: 1, extensions: { [preview.id]: {
    local: ["theme", "removed"], sync: ["enabled"], values: { local: { theme: "dark" }, sync: { enabled: false } }
  } } })
  assert.deepEqual(await host.storage.get(null), { theme: "dark", privateToken: "keep" })
  assert.deepEqual(await host.syncStorage.get(null), { enabled: false })
  const adopted = []
  h.manager.onSyncChanged = document => adopted.push(document)
  await host.storage.set({ theme: "blue", privateToken: "still local" })
  await h.manager.setEnabled(preview.id, false)
  assert.deepEqual(adopted[0].extensions[preview.id].values.local, { theme: "blue" })
  assert.equal(JSON.stringify(adopted).includes("privateToken"), false)
  await host.storage.flush()
  await host.syncStorage.flush()
})

test("AMO sources and archive entry names are constrained before extraction", async t => {
  assert.equal(amoSlug("https://addons.mozilla.org/en-US/firefox/addon/darkreader/"), "darkreader")
  assert.throws(() => amoSlug("https://example.org/firefox/addon/foo/"))
  const h = await harness(t)
  const zip = new AdmZip()
  zip.addFile("safe/CON.txt", Buffer.from("bad"))
  await assert.rejects(unpackExtension(zip.toBuffer(), path.join(h.root, "unpacked")), /unsafe/)
  await assert.rejects(fs.stat(path.join(h.root, "unpacked")), /ENOENT/)
})
