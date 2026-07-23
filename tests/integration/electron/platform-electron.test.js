const test = require("node:test")
const assert = require("node:assert/strict")
const { bridgeFetch } = require("@once/platform-electron/fetch")
const {
  normalizeBrowserUrl,
  resolveOpenDisposition
} = require("@once/platform-electron/navigation")
const { PouchSyncService } = require("@once/persistence")

function eventChain() {
  const handlers = new Map()
  return {
    cancelled: false,
    on(name, handler) {
      handlers.set(name, handler)
      return this
    },
    cancel() {
      this.cancelled = true
    },
    emit(name, value) {
      handlers.get(name)?.(value)
    }
  }
}

test("normalizes supported browser URLs and rejects privileged schemes", () => {
  assert.equal(normalizeBrowserUrl(" about:blank "), "about:blank")
  assert.equal(normalizeBrowserUrl("https://example.com"), "https://example.com/")
  assert.equal(normalizeBrowserUrl("example.com"), "https://example.com/")
  assert.equal(
    normalizeBrowserUrl("localhost:8443/path"),
    "https://localhost:8443/path"
  )
  assert.equal(
    normalizeBrowserUrl("//example.com/path"),
    "https://example.com/path"
  )
  assert.throws(() => normalizeBrowserUrl("not a valid URL"), /complete HTTP/)
  assert.throws(() => normalizeBrowserUrl("data:text/plain,reader"), /Only HTTP/)
  assert.throws(() => normalizeBrowserUrl("once-reader://https/example.com"), /Only HTTP/)
  assert.throws(() => normalizeBrowserUrl("file:///secret"), /Only HTTP/)
  assert.throws(() => normalizeBrowserUrl("javascript:alert(1)"), /Only HTTP/)
})

test("maps Once link targets to desktop tab dispositions", () => {
  assert.equal(resolveOpenDisposition("_self"), "current")
  assert.equal(resolveOpenDisposition("middle"), "background")
  assert.equal(resolveOpenDisposition("blank"), "foreground")
  assert.equal(resolveOpenDisposition("custom-window"), "foreground")
})

test("serializes fetch requests through the preload bridge", async () => {
  let received
  const bridge = {
    async fetch(request) {
      received = request
      return {
        status: 201,
        statusText: "Created",
        headers: [["content-type", "application/json"]],
        body: new TextEncoder().encode('{"ok":true}').buffer
      }
    }
  }

  const response = await bridgeFetch(bridge, "https://example.com/db", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"name":"once"}'
  })

  assert.equal(received.url, "https://example.com/db")
  assert.equal(received.method, "POST")
  assert.equal(new TextDecoder().decode(received.body), '{"name":"once"}')
  assert.equal(response.status, 201)
  assert.deepEqual(await response.json(), { ok: true })
})

test("cancels old CouchDB work when the sync URL changes", () => {
  const replications = []
  const syncs = []
  const changes = []
  const db = {
    replicate: {
      from(target) {
        const chain = eventChain()
        replications.push({ target, chain })
        return chain
      }
    },
    sync(target) {
      const chain = eventChain()
      syncs.push({ target, chain })
      return chain
    }
  }
  const service = new PouchSyncService(
    db,
    (change) => changes.push(change),
    (url) => ({ remote: url })
  )
  const diagnostics = []
  const statuses = []
  service.onDiagnostic((error) => diagnostics.push(error))
  service.onStatus((status) => statuses.push(status))

  service.syncFrom("https://one.example/db")
  assert.equal(statuses.at(-1).state, "connecting")
  service.syncFrom("https://two.example/db")
  assert.equal(replications[0].chain.cancelled, true)

  replications[0].chain.emit("complete", {})
  assert.equal(syncs.length, 0)
  replications[1].chain.emit("change", { docs: [{}, {}] })
  assert.deepEqual(statuses.at(-1), {
    state: "syncing",
    message: "Downloading remote changes (2)…",
    changes: 2
  })
  replications[1].chain.emit("complete", {})
  assert.equal(syncs.length, 1)
  assert.deepEqual(syncs[0].target, { remote: "https://two.example/db" })
  assert.equal(statuses.at(-1).state, "up-to-date")

  syncs[0].chain.emit("change", { change: { docs: [{ id: "one" }] } })
  assert.deepEqual(changes, [{ change: { docs: [{ id: "one" }] } }])
  assert.equal(statuses.at(-1).message, "Syncing 1 change…")
  syncs[0].chain.emit("paused")
  assert.equal(statuses.at(-1).state, "up-to-date")
  syncs[0].chain.emit("denied", { status: 403, message: "forbidden" })
  assert.equal(diagnostics[0].operation, "sync.denied")
  assert.equal(statuses.at(-1).state, "error")
  assert.match(diagnostics[0].details, /forbidden/)
  service.syncFrom("https://three.example/db")
  assert.equal(syncs[0].chain.cancelled, true)

  service.syncFrom("")
  assert.equal(replications[2].chain.cancelled, true)
  assert.deepEqual(statuses.at(-1), {
    state: "disabled",
    message: "Sync is not configured"
  })
})
