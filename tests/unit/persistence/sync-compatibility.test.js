const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")
const PouchDB = require("pouchdb")
const { PouchSyncCompatibility } = require("../../../packages/persistence/dist/PouchSyncCompatibility")
const { PouchSyncService } = require("../../../packages/persistence/dist")
const { compatibilityDatabase, eventually } = require("../../helpers/sync-compatibility")
const id = "once_sync_compat", destination = "https://sync.test/once"

test("legacy, local current formats and monotonic destination-scoped markers", async () => {
  const local = compatibilityDatabase(), remote = compatibilityDatabase()
  const gate = new PouchSyncCompatibility(local)
  await gate.check(remote, destination)
  assert.equal((await remote.get(id)).minSyncProtocol, 1)
  await local.put({ _id: "addons", list: { addons: [{ manifest: { capabilities: ["ai"] } }] } })
  await gate.check(remote, destination)
  assert.equal((await remote.get(id)).minSyncProtocol, 2)
  const marker = await remote.get(id)
  await remote.put({ ...marker, minSyncProtocol: 3, minAppVersion: "0.5.0" })
  await assert.rejects(gate.check(remote, destination), error => error.compatibility?.requiredSyncProtocol === 3)
  await remote.put({ ...await remote.get(id), minSyncProtocol: 1 })
  await assert.rejects(new PouchSyncCompatibility(local).check(remote, destination), /newer version/)
  await new PouchSyncCompatibility(local).check(compatibilityDatabase(), "https://other.test/once")
})

test("unknown metadata, removed markers, current remote vaults, failed CAS and concurrent raises", async () => {
  const local = compatibilityDatabase(), remote = compatibilityDatabase(), gate = new PouchSyncCompatibility(local)
  await remote.put({ _id: "addon_vault", list: { version: 2 } })
  await gate.check(remote, destination)
  assert.equal((await remote.get(id)).minSyncProtocol, 2)
  const get = remote.get
  remote.get = async key => { if (key === id) throw { status: 404 }; return get(key) }
  await assert.rejects(gate.check(remote, destination), /removed or lowered/)
  remote.get = get
  await remote.put({ ...await get(id), schema: 99 })
  await assert.rejects(gate.check(remote, destination), /unsupported or damaged/)
  const server = compatibilityDatabase()
  const a = new PouchSyncCompatibility(compatibilityDatabase()), b = new PouchSyncCompatibility(compatibilityDatabase())
  await Promise.all([a.check(server, destination), b.check(server, destination, 2)])
  assert.equal((await server.get(id)).minSyncProtocol, 2)
  await local.put({ _id: "addon_vault", list: { version: 2 } })
  await assert.rejects(new PouchSyncCompatibility(local, 1).localRequirement(), /newer version/)
})

test("two actual Pouch clients stop on a live protocol increase and retain pending edits", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "once-compat-"))
  const [old, modern, remote] = ["old", "modern", "remote"].map(name => new PouchDB(path.join(dir, name)))
  const statuses = []
  const client = new PouchSyncService(old, () => {}, () => remote, 1)
  client.onStatus(status => statuses.push(status))
  try {
    client.syncFrom(destination)
    await eventually(() => statuses.at(-1).state === "up-to-date")
    await assert.rejects(old.get(id), error => error.status === 404, "marker is not replicated as ordinary data")
    await new PouchSyncCompatibility(modern).check(remote, destination, 2)
    await eventually(() => statuses.at(-1).state === "update-required")
    await old.put({ _id: "sto_pending", value: "retained" })
    assert.equal((await old.get("sto_pending")).value, "retained")
    await assert.rejects(remote.get("sto_pending"), error => error.status === 404)
    client.recheckCompatibility()
    await eventually(() => statuses.at(-1).state === "update-required")
    assert.equal(statuses.at(-1).compatibility.requiredSyncProtocol, 2)
    client.syncFrom("")
    const updated = new PouchSyncService(old, () => {}, () => remote, 2)
    updated.syncFrom(destination)
    await eventually(() => statuses.at(-1).state === "disabled")
    for (let i = 0; i < 100; i++) { try { if ((await remote.get("sto_pending")).value) break } catch { /* Replication has not delivered the retained edit yet. */ } await new Promise(resolve => setTimeout(resolve, 10)) }
    assert.equal((await remote.get("sto_pending")).value, "retained")
    updated.syncFrom("")
  } finally { client.syncFrom(""); await Promise.all([old, modern, remote].map(db => db.close())); await fs.rm(dir, { recursive: true, force: true }) }
})

test("highest conflict branch is enforced and malformed losing branches fail closed", async () => {
  const local = compatibilityDatabase(), remote = compatibilityDatabase()
  await remote.put({ _id: id, schema: 1, minSyncProtocol: 1 })
  const get = remote.get
  remote.get = async (key, options) => key === id ? options?.rev ? { schema: 1, minSyncProtocol: 3 } : { ...await get(key), _conflicts: ["2-other"] } : get(key)
  const gate = new PouchSyncCompatibility(local)
  await assert.rejects(gate.check(remote, destination), error => error.compatibility?.requiredSyncProtocol === 3)
  remote.get = async (key, options) => key === id ? options?.rev ? { schema: 99 } : { ...await get(key), _conflicts: ["2-other"] } : get(key)
  await assert.rejects(gate.check(remote, destination), /unsupported or damaged/)
})

test("shared data writes wait for the marker and failed checks keep persisted values unchanged", async () => {
  const { PouchListStore } = require("../../../packages/persistence/dist")
  const local = compatibilityDatabase(), remote = compatibilityDatabase()
  const gate = new PouchSyncCompatibility(local)
  let offline = true
  const guarded = new PouchListStore(local, async version => {
    if (offline) throw new Error("offline")
    await gate.check(remote, destination, version)
  })
  await assert.rejects(guarded.writeVault({ version: 2 }, []), /offline/)
  await assert.rejects(local.get("addon_vault"), error => error.status === 404)
  offline = false
  await guarded.writeVault({ version: 2 }, [])
  assert.equal((await remote.get(id)).minSyncProtocol, 2)
  assert.equal((await local.get("addon_vault")).list.version, 2)
})

test("offline preflight and reconnect never start replication before compatibility is known", async () => {
  let count = 0, unavailable = true
  const local = compatibilityDatabase({ replicate: { from() { count++; throw new Error("must not replicate") } } })
  const remote = compatibilityDatabase()
  const get = remote.get
  remote.get = (...args) => unavailable ? Promise.reject(new Error("network failed")) : get(...args)
  const statuses = [], client = new PouchSyncService(local, () => {}, () => remote)
  client.onStatus(status => statuses.push(status))
  try {
    client.syncFrom(destination)
    await eventually(() => statuses.at(-1).state === "error")
    assert.match(statuses.at(-1).message, /Check your connection/)
    assert.equal(count, 0)
    unavailable = false
    await remote.put({ _id: id, schema: 1, minSyncProtocol: 3 })
    client.recheckCompatibility()
    await eventually(() => statuses.at(-1).state === "update-required")
    assert.equal(count, 0)
  } finally { client.syncFrom("") }
})

test("events queued by a cancelled live transport cannot clear update-required", () => {
  const { listenLiveSync } = require("../../../packages/persistence/dist/PouchSyncWatch")
  const events = new Map(), chain = { on(name, handler) { events.set(name, handler); return this } }
  let active = true, status = "up-to-date", writes = 0
  listenLiveSync(chain, () => active, () => writes++, busy => { status = busy ? "syncing" : "up-to-date" }, () => { active = false; status = "update-required" })
  events.get("error")(new Error("incompatible"))
  events.get("paused")(); events.get("active")(); events.get("change")({})
  assert.equal(status, "update-required")
  assert.equal(writes, 0)
})

test("a failed first marker write for existing development data can be retried", async () => {
  const local = compatibilityDatabase(), remote = compatibilityDatabase(), gate = new PouchSyncCompatibility(local)
  await remote.put({ _id: "addon_vault", list: { version: 2 } })
  const put = remote.put
  remote.put = async () => { throw new Error("network interrupted") }
  await assert.rejects(gate.check(remote, destination), /network interrupted/)
  remote.put = put
  await gate.check(remote, destination)
  assert.equal((await remote.get(id)).minSyncProtocol, 2)
})
