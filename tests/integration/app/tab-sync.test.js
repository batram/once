const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")
const PouchDB = require("pouchdb")
const { pouchTabDocs } = require("../../../packages/persistence/dist")
const { DeviceIdentity } = require("../../../packages/app/dist/tabsync/DeviceIdentity")
const { TabDocRepository } = require("../../../packages/app/dist/tabsync/TabDocRepository")
const { TabSyncService } = require("../../../packages/app/dist/tabsync/TabSyncService")

const timing = { debounce: 1, minInterval: 0, heartbeat: 60000, refresh: 1 }
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function tab(id, url, fields = {}) {
  return { id, navSeq: 1, url, title: url, mode: "web", active: false, openedAt: 1, navigatedAt: 2, selectedAt: 3, activityAt: 4, ...fields }
}

function source(windows) {
  const listeners = new Set()
  return {
    windows,
    snapshot: async () => structuredClone(windows),
    onChanged(handler) { listeners.add(handler); return () => listeners.delete(handler) },
    emit() { listeners.forEach((handler) => handler()) }
  }
}

async function harness() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "once-tab-sync-"))
  const server = new PouchDB(path.join(directory, "server"))
  const made = []
  const device = async (name, tabSource, options = {}) => {
    const db = new PouchDB(path.join(directory, name), { revs_limit: 20 })
    const secrets = new Map()
    const identity = new DeviceIdentity({ get: async (key) => secrets.get(key) || "", set: async (key, value) => { secrets.set(key, value) } }, "electron", name)
    // These devices use tab sync; the master switch has its own test below.
    if (options.enabled !== false) await identity.setOptions({ enabled: true, offerAnswered: true })
    const errors = []
    const lists = new Map()
    const service = new TabSyncService({
      identity, repository: new TabDocRepository(pouchTabDocs(db)),
      listStore: { get: async (key, fallback) => lists.has(key) ? lists.get(key) : fallback, set: async (key, value) => { lists.set(key, value) } },
      source: tabSource, appVersion: "1.0.0", syncActive: () => options.active ?? true, changed: () => undefined,
      reportError: (operation, error) => errors.push({ operation, error }), timing
    })
    const changes = db.changes({ since: "now", live: true }).on("change", (change) => service.handleChange({ id: change.id }))
    made.push({ db, service, changes })
    await service.start()
    await settle(service)
    return { db, service, identity, errors, secrets, push: () => db.replicate.to(server), pull: () => db.replicate.from(server) }
  }
  const settle = async (service) => {
    for (let index = 0; index < 5; index++) {
      await wait(5)
      await service.whenIdle()
    }
  }
  const close = async () => {
    for (const { db, service, changes } of made) {
      service.dispose()
      changes.cancel()
      await db.close()
    }
    await server.close()
    await fs.rm(directory, { recursive: true, force: true })
  }
  return { server, device, settle, close }
}

test("a sharing device publishes only normal-window http(s) tabs, and other devices list it", async () => {
  const h = await harness()
  try {
    const laptopSource = source([
      { id: "w1", focused: true, tabs: [tab("a", "https://example.com/a", { active: true }), tab("b", "about:blank"), tab("c", "https://bank.example/")] },
      { id: "w2", focused: false, incognito: true, tabs: [tab("d", "https://private.example/")] }
    ])
    const laptop = await h.device("laptop", laptopSource)
    await laptop.service.setOptions({ sharing: true, excludedDomains: ["bank.example"] })
    await h.settle(laptop.service)
    const record = await laptop.identity.get()
    const doc = await laptop.db.get(`dev_${record.id}`)
    assert.deepEqual(doc.windows.map((window) => window.tabs.map((item) => item.url)), [["https://example.com/a"]])
    await laptop.push()
    const phone = await h.device("phone", undefined)
    await phone.pull()
    await h.settle(phone.service)
    const view = await phone.service.view()
    assert.equal(view.canShare, false)
    assert.deepEqual(view.devices.map((item) => item.name), ["laptop"])
    assert.deepEqual(laptop.errors, [])
  } finally {
    await h.close()
  }
})

test("with tab sync off a device publishes nothing, lists nobody and has no inbox, whatever else is chosen", async () => {
  const h = await harness()
  try {
    const laptop = await h.device("laptop", source([{ id: "w1", focused: true, tabs: [tab("a", "https://example.com/a", { active: true })] }]))
    await laptop.service.setOptions({ sharing: true })
    await h.settle(laptop.service)
    await laptop.push()
    // One process holds one publisher lock: the laptop lets go of it.
    laptop.service.dispose()
    const phone = await h.device("phone", source([{ id: "p", focused: true, tabs: [tab("p", "https://phone.example/", { active: true })] }]), { enabled: false })
    await phone.service.setOptions({ sharing: true, sendTarget: true })
    await h.settle(phone.service)
    const phoneRecord = await phone.identity.get()
    assert.equal(await phone.db.get(`dev_${phoneRecord.id}`).catch(() => null), null, "neither tabs nor presence are published")
    await phone.pull()
    await h.settle(phone.service)
    const off = await phone.service.view()
    assert.equal(off.options.enabled, false)
    assert.deepEqual([off.devices.length, off.inbox.length], [0, 0])
    await phone.service.setOptions({ enabled: true })
    await h.settle(phone.service)
    assert.deepEqual((await phone.service.view()).devices.map((item) => item.name), ["laptop"])
    let published = null
    for (let attempt = 0; attempt < 40 && !published; attempt++) {
      await h.settle(phone.service)
      published = await phone.db.get(`dev_${phoneRecord.id}`).catch(() => null)
    }
    assert.ok(published, "turned on, it publishes")
  } finally {
    await h.close()
  }
})

test("turning sharing off while a capture is in flight publishes nothing", async () => {
  const h = await harness()
  try {
    let release
    const slow = source([{ id: "w", focused: true, tabs: [tab("a", "https://example.com/")] }])
    slow.snapshot = () => new Promise((resolve) => { release = () => resolve(structuredClone(slow.windows)) })
    const laptop = await h.device("laptop", slow)
    await laptop.identity.setOptions({ sendTarget: false })
    void laptop.service.setOptions({ sharing: true })
    while (!release) await wait(1)
    await laptop.service.setOptions({ sharing: false })
    release()
    await h.settle(laptop.service)
    const rows = (await laptop.db.allDocs({ startkey: "dev_", endkey: "dev_￿" })).rows
    assert.deepEqual(rows, [])
  } finally {
    await h.close()
  }
})

test("a forgotten device stays hidden when it returns from offline, removes itself, and can rejoin", async () => {
  const h = await harness()
  try {
    const laptopSource = source([{ id: "w", focused: true, tabs: [tab("a", "https://example.com/1")] }])
    const laptop = await h.device("laptop", laptopSource)
    await laptop.service.setOptions({ sharing: true })
    await h.settle(laptop.service)
    await laptop.push()
    const phone = await h.device("phone", undefined)
    await phone.pull()
    await h.settle(phone.service)
    const laptopId = (await laptop.identity.get()).id
    await phone.service.forget(laptopId)
    await phone.push()
    // Offline meanwhile, the laptop keeps publishing.
    laptopSource.windows[0].tabs.push(tab("b", "https://example.com/2"))
    laptopSource.emit()
    await h.settle(laptop.service)
    await laptop.push()
    await phone.pull()
    await h.settle(phone.service)
    assert.deepEqual((await phone.service.view()).devices, [], "an older-epoch publication stays hidden")
    await laptop.pull()
    await h.settle(laptop.service)
    laptopSource.emit()
    await h.settle(laptop.service)
    const removed = await laptop.service.view()
    assert.equal(removed.options.sharing, false)
    assert.match(removed.notice, /Removed from tab sync by phone/)
    assert.deepEqual((await laptop.db.allDocs({ startkey: "dev_", endkey: "dev_￿" })).rows, [])
    await laptop.service.setOptions({ sharing: true })
    await h.settle(laptop.service)
    await laptop.push()
    await phone.pull()
    await h.settle(phone.service)
    const back = (await phone.service.view()).devices
    assert.deepEqual(back.map((item) => item.name), ["laptop"])
    assert.equal((await laptop.identity.get()).epoch, 2)
  } finally {
    await h.close()
  }
})

test("any device deletes sends past the shared retention or addressed to a removed device", async () => {
  const h = await harness()
  try {
    const laptop = await h.device("laptop", source([{ id: "w", focused: true, tabs: [] }]))
    const gone = "fedcba9876543210fedcba9876543210"
    const kept = "00112233445566778899aabbccddeeff"
    const from = (await laptop.identity.get()).id
    const send = (target, suffix, createdAt) => ({ _id: `tsend_${target}_${suffix}`, type: "send", from, fromName: "laptop",
      url: "https://example.com/", title: "x", mode: "web", createdAt })
    await laptop.db.bulkDocs([
      send(kept, "old", new Date(Date.now() - 15 * 86400000).toISOString()),
      send(kept, "new", new Date().toISOString()),
      send(gone, "new", new Date().toISOString()),
      { _id: `tret_${gone}`, type: "retirement", deviceId: gone, retiredEpoch: 1, retiredAt: new Date().toISOString(), retiredBy: "x" }
    ])
    await h.settle(laptop.service)
    await laptop.service.setOptions({ sharing: true })
    await h.settle(laptop.service)
    const ids = (await laptop.db.allDocs({ startkey: "tsend_", endkey: "tsend_￿" })).rows.map((row) => row.id)
    assert.deepEqual(ids, [`tsend_${kept}_new`])
  } finally {
    await h.close()
  }
})

test("concurrent first starts share one device identity, and the vault's name is adopted", async () => {
  const secrets = new Map([["once:addon-vault", JSON.stringify({ deviceName: "Work laptop" })]])
  const store = { get: async (key) => { await wait(1); return secrets.get(key) || "" }, set: async (key, value) => { await wait(1); secrets.set(key, value) } }
  const first = new DeviceIdentity(store, "chrome", "Chrome")
  const second = new DeviceIdentity(store, "chrome", "Chrome")
  const [a, b] = await Promise.all([first.get(), second.get()])
  assert.equal(a.id, b.id)
  assert.equal(a.name, "Work laptop")
  assert.deepEqual(await first.nextSeq(), { epoch: 1, seq: 1 })
  assert.deepEqual(await second.nextSeq(), { epoch: 1, seq: 2 })
  const { previous, current } = await first.reset()
  assert.equal(previous.id, a.id)
  assert.notEqual(current.id, a.id)
})

test("screenshots are stored once per page, reach other devices, and go when unreferenced or turned off", async () => {
  const h = await harness()
  try {
    const jpeg = (text) => Buffer.from(`jpeg:${text}`).toString("base64")
    const laptopSource = source([{ id: "w", focused: true, tabs: [tab("a", "https://example.com/1", { active: true }), tab("b", "https://example.com/2")] }])
    const captures = []
    laptopSource.captureThumbnail = async (tabId) => {
      captures.push(tabId)
      const page = laptopSource.windows[0].tabs.find((item) => item.id === tabId)
      return { jpeg: jpeg(`${tabId}@${page.url}`), width: 320, height: 200 }
    }
    const laptop = await h.device("laptop", laptopSource)
    await laptop.service.setOptions({ sharing: true })
    await h.settle(laptop.service)
    const id = (await laptop.identity.get()).id
    const published = async () => (await laptop.db.get(`dev_${id}`)).windows[0].tabs
    const first = await published()
    assert.ok(first.every((item) => item.thumb?.id.startsWith(`tth_${id}_`)))
    assert.deepEqual(captures.sort(), ["a", "b"])

    laptopSource.emit()
    await h.settle(laptop.service)
    assert.equal(captures.length, 2, "an unchanged page is not captured again")

    laptopSource.windows[0].tabs[0] = tab("a", "https://example.com/3", { active: true, navSeq: 2 })
    laptopSource.emit()
    await h.settle(laptop.service)
    const second = await published()
    assert.notEqual(second[0].thumb.id, first[0].thumb.id)
    const thumbIds = async () => (await laptop.db.allDocs({ startkey: "tth_", endkey: "tth_￿" })).rows.map((row) => row.id).sort()
    assert.deepEqual(await thumbIds(), [first[0].thumb.id, second[0].thumb.id, second[1].thumb.id].sort(), "the replaced screenshot stays for the grace period")

    await laptop.push()
    const phone = await h.device("phone", undefined)
    await phone.pull()
    await h.settle(phone.service)
    assert.equal(await phone.service.thumbnail(second[0].thumb.id), `data:image/jpeg;base64,${jpeg("a@https://example.com/3")}`)

    await laptop.service.setOptions({ screenshots: false })
    await h.settle(laptop.service)
    assert.deepEqual(await thumbIds(), [])
    assert.ok((await published()).every((item) => !item.thumb))
  } finally {
    await h.close()
  }
})

test("the position of a tab is read when it is left, and published while another tab is selected", async () => {
  const h = await harness()
  try {
    let fraction = 0.3
    const deselected = new Set()
    const laptopSource = source([{ id: "w", focused: true, tabs: [
      tab("a", "https://news.example/article", { active: true, mode: "reader" }), tab("b", "https://example.com/other")] }])
    laptopSource.readerPosition = async (tabId) => tabId === "a" ? { fraction, anchor: { index: 3, text: "Third" } } : null
    laptopSource.runInPage = async () => null
    laptopSource.onDeselected = (handler) => { deselected.add(handler); return () => deselected.delete(handler) }
    const laptop = await h.device("laptop", laptopSource)
    await laptop.service.setOptions({ sharing: true, screenshots: false })
    await h.settle(laptop.service)
    const id = (await laptop.identity.get()).id
    const readerState = async () => (await laptop.db.get(`dev_${id}`)).windows[0].tabs[0].state?.["reader.scroll"]?.data
    assert.equal((await readerState()).fraction, 0.3)

    fraction = 0.7
    laptopSource.windows[0].tabs[0].active = false
    laptopSource.windows[0].tabs[1].active = true
    deselected.forEach((handler) => handler("a"))
    laptopSource.emit()
    await h.settle(laptop.service)
    assert.equal((await readerState()).fraction, 0.7, "the article keeps the position it was left at")

    // The settings store reports this runtime's own writes too. With nothing
    // changed, that is no reason to forget what was read from the tabs.
    fraction = 0.1
    laptop.service.optionsChangedElsewhere()
    laptopSource.emit()
    await h.settle(laptop.service)
    assert.equal((await readerState()).fraction, 0.7, "the position read on leaving survives an unchanged settings report")
  } finally {
    await h.close()
  }
})

test("a tab sent to another device waits in its inbox until opened there, and only listed devices receive", async () => {
  const h = await harness()
  try {
    const laptop = await h.device("laptop", source([{ id: "w", focused: true, tabs: [] }]))
    await laptop.service.setOptions({ sharing: false, sendTarget: true })
    await h.settle(laptop.service)
    await laptop.push()
    const phoneSource = source([{ id: "w", focused: true, tabs: [tab("a", "https://news.example/a", { active: true, title: "News" })] }])
    phoneSource.runInPage = async () => ({ currentTime: 42, duration: 100, paused: true, rate: 1 })
    const phone = await h.device("phone", phoneSource)
    await phone.pull()
    await h.settle(phone.service)
    const laptopId = (await laptop.identity.get()).id
    await assert.rejects(phone.service.send("fedcba9876543210fedcba9876543210", { url: "https://x.example/", title: "x", mode: "web" }), /can no longer receive/)
    await phone.service.sendLocal(laptopId, "a")
    await phone.push()
    await laptop.pull()
    await h.settle(laptop.service)
    const [sent] = (await laptop.service.view()).inbox
    assert.equal(sent.fromName, "phone")
    assert.equal(sent.state.media.data.currentTime, 42)
    assert.deepEqual((await phone.service.view()).inbox, [], "the sender's own inbox stays empty")
    const taken = await laptop.service.takeSent(sent.id)
    assert.equal(taken.url, "https://news.example/a")
    await h.settle(laptop.service)
    assert.deepEqual((await laptop.service.view()).inbox, [])
    assert.deepEqual((await laptop.db.allDocs({ startkey: "tsend_", endkey: "tsend_￿" })).rows, [])
  } finally {
    await h.close()
  }
})
