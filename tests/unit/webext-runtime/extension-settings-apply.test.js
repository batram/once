const assert = require("node:assert/strict")
const test = require("node:test")
const {
  ExtensionSettingsCoordinator, ublockSelection, reconcileUblockLists, applyFilterListsToUblock
} = require("../../../packages/webext-runtime/dist")

test("settings queues are independent per extension and suppress stale adoption", async () => {
  const hosts = ["one", "two"].map(id => ({ extension: { id, host: id, name: id } }))
  const calls = [], adopted = []
  const coordinator = new ExtensionSettingsCoordinator(() => hosts, () => {}, (host, settings) =>
    new Promise(resolve => calls.push({ host: host.extension.id, version: settings.userscripts.version, resolve })))
  coordinator.onAdopted(value => adopted.push(value))
  const settings = version => ({ filterLists: { lists: [] }, userscripts: { version, scripts: [] } })
  const first = coordinator.applySettings(settings(1))
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls.map(call => call.host), ["one", "two"])
  const latest = coordinator.applySettings(settings(2))
  calls[0].resolve({ userscripts: { version: 99, scripts: [] } })
  calls[1].resolve({})
  await first
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(adopted, [])
  assert.deepEqual(calls.map(call => call.version), [1, 1, 2, 2])
  calls[2].resolve({})
  calls[3].resolve({})
  await latest
  assert.equal(coordinator.status(hosts[0]).state, "applied")
})

function dashboardFixture() {
  const commands = []
  const records = new Map()
  let entry
  const host = {
    extension: { id: "uBlock0@raymondhill.net", host: "ublock", name: "uBlock Origin" },
    contexts: {
      whenListening: async () => {},
      addEntry: value => (entry = value),
      remove() {}
    },
    ports: {
      connect: () => 1,
      disconnect() {},
      post(_sender, portId, envelope) {
        commands.push(envelope.msg.what)
        if (envelope.msg.what === "applyFilterListSelection") {
          for (const [key, asset] of Object.entries(host.table.available)) asset.off = !envelope.msg.toSelect.includes(key)
        }
        if (host.failReload && envelope.msg.what === "reloadAllFilters") throw new Error("interrupted reload")
        entry.send({ api: "__port", event: "message", args: [{
          portId, message: { msgId: envelope.msgId, msg: envelope.msg.what === "getLists" ? host.table : {} }
        }] })
      }
    },
    store: { read: async key => records.get(key), write: async (key, value) => { records.set(key, value) } },
    table: { available: { easylist: { off: false, contentURL: "https://lists.test/easylist" } } }
  }
  return { host, commands, records }
}

test("unchanged uBlock selections wait for readiness without rebuilding filters", async () => {
  const { host, commands, records } = dashboardFixture()
  await applyFilterListsToUblock(host, [{ url: "https://lists.test/easylist", enabled: true }])
  assert.deepEqual(commands, ["getLists"])
  assert.deepEqual(records.get("once-filter-lists.json"), { "https://lists.test/easylist": true })
})

test("changed selections reload, but a second identical application does not", async () => {
  const { host, commands } = dashboardFixture()
  const lists = [{ url: "https://lists.test/easylist", enabled: false }]
  await applyFilterListsToUblock(host, lists)
  assert.deepEqual(commands, ["getLists", "applyFilterListSelection", "reloadAllFilters"])
  commands.length = 0
  await applyFilterListsToUblock(host, lists)
  assert.deepEqual(commands, ["getLists"])
})

test("an interrupted rebuild is retried even when the selection was already saved", async () => {
  const { host, commands, records } = dashboardFixture()
  host.failReload = true
  const lists = [{ url: "https://lists.test/easylist", enabled: false }]
  await assert.rejects(applyFilterListsToUblock(host, lists), /interrupted reload/)
  assert.equal(records.get("once-filter-lists-pending.json"), true)
  host.failReload = false
  commands.length = 0
  await applyFilterListsToUblock(host, lists)
  assert.deepEqual(commands, ["getLists", "applyFilterListSelection", "reloadAllFilters"])
  assert.equal(records.get("once-filter-lists-pending.json"), false)
})

const table = {
  available: {
    "easylist": { contentURL: ["assets/thirdparties/easylist.txt", "https://easylist.to/easylist/easylist.txt"], off: false },
    "DEU-0": { contentURL: "https://easylist-downloads.adblockplus.org/easylistgermany.txt", off: true },
    "ublock-filters": { contentURL: "assets/ublock/filters.txt", off: false },
    "https://imported.test/list.txt": { contentURL: "https://imported.test/list.txt", off: false }
  }
}

test("Once's subscriptions add to uBlock's selection and never replace it", () => {
  const result = ublockSelection(table, [
    { url: "https://easylist-downloads.adblockplus.org/easylistgermany.txt", enabled: true },
    { url: "https://new.test/list.txt", enabled: true }
  ])
  assert.deepEqual(result.toSelect.sort(), ["DEU-0", "easylist", "https://imported.test/list.txt", "ublock-filters"])
  assert.equal(result.toImport, "https://new.test/list.txt")
  assert.deepEqual(result.toRemove, [])
})

test("removed subscriptions restore the selection that predated Once ownership", () => {
  const before = reconcileUblockLists(table, [
    { url: "https://easylist.to/easylist/easylist.txt", enabled: false },
    { url: "https://new.test/list.txt", enabled: true }
  ], {})
  assert.deepEqual(before.baseline, {
    "https://easylist.to/easylist/easylist.txt": true,
    "https://new.test/list.txt": false
  })
  const afterTable = { available: { ...table.available,
    easylist: { ...table.available.easylist, off: true },
    "https://new.test/list.txt": { off: false }
  } }
  const after = reconcileUblockLists(afterTable, [], before.baseline)
  const selection = ublockSelection(afterTable, after.lists)
  assert.equal(selection.toSelect.includes("easylist"), true)
  assert.equal(selection.toSelect.includes("https://imported.test/list.txt"), true)
  assert.deepEqual(selection.toRemove, ["https://new.test/list.txt"])
  assert.deepEqual(after.baseline, {})
})

test("a disabled list is deselected by its stock key or removed when it was imported", () => {
  const result = ublockSelection(table, [
    { url: "http://easylist.to/easylist/easylist.txt", enabled: false },
    { url: "https://imported.test/list.txt", enabled: false },
    { url: "https://unknown.test/list.txt", enabled: false }
  ])
  assert.deepEqual(result.toSelect, ["ublock-filters"])
  assert.equal(result.toImport, "")
  assert.deepEqual(result.toRemove, ["https://imported.test/list.txt"])
})
