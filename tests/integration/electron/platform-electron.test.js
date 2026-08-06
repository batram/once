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

const nextTurn = () => new Promise((resolve) => setImmediate(resolve))

test("rejects a local-looking sync target before constructing PouchDB", () => {
  let remoteCreations = 0
  const statuses = []
  const diagnostics = []
  const service = new PouchSyncService(
    {},
    () => {},
    () => {
      remoteCreations++
      return {}
    }
  )
  service.onStatus((status) => statuses.push(status))
  service.onDiagnostic((diagnostic) => diagnostics.push(diagnostic))

  service.syncFrom("user:secret@example.test/once")

  assert.equal(remoteCreations, 0)
  assert.deepEqual(statuses.at(-1), {
    state: "error",
    message: "CouchDB URL must start with http:// or https://"
  })
  assert.equal(diagnostics.at(-1).operation, "sync.configure")
  assert.doesNotMatch(diagnostics.at(-1).details, /secret|example\.test/)
})

test("cancels old CouchDB work when the sync URL changes", async (t) => {
  t.mock.method(console, "error", () => {})

  const replications = []
  const syncs = []
  const changes = []
  const db = {
    replicate: {
      from(target, options) {
        const chain = eventChain()
        replications.push({ target, options, chain })
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
  const remoteChanges = []
  service.onDiagnostic((error) => diagnostics.push(error))
  service.onStatus((status) => statuses.push(status))
  service.onRemoteChange((change) => remoteChanges.push(change))

  service.syncFrom("https://one.example/db")
  assert.equal(statuses.at(-1).message, "Syncing settings…")
  service.syncFrom("https://two.example/db")
  assert.equal(replications[0].chain.cancelled, true)

  replications[0].chain.emit("complete", {})
  assert.equal(syncs.length, 0)
  replications[1].chain.emit("change", { docs: [{}, {}] })
  assert.deepEqual(statuses.at(-1), {
    state: "syncing",
    message: "Syncing settings…",
    changes: 2
  })
  replications[1].chain.emit("complete", {})
  await nextTurn()
  assert.deepEqual(replications[2].options, {
    batch_size: 1000,
    batches_limit: 2,
    checkpoint: "target"
  })
  replications[2].chain.emit("complete", {})
  await nextTurn()
  assert.equal(syncs.length, 1)
  assert.deepEqual(syncs[0].target, { remote: "https://two.example/db" })
  assert.equal(statuses.at(-1).state, "up-to-date")

  syncs[0].chain.emit("change", {
    direction: "pull",
    change: { docs: [{ _id: "sto_one", id: "one" }] }
  })
  assert.deepEqual(changes, [{
    direction: "pull",
    change: { docs: [{ _id: "sto_one", id: "one" }] }
  }])
  assert.equal(statuses.at(-1).message, "Syncing 1 change…")
  syncs[0].chain.emit("change", {
    direction: "push",
    change: { docs: [{ _id: "sto_local", id: "local" }] }
  })
  syncs[0].chain.emit("paused")
  assert.equal(statuses.at(-1).state, "up-to-date")
  syncs[0].chain.emit("denied", { status: 403, message: "forbidden" })
  assert.equal(diagnostics[0].operation, "sync.denied")
  assert.equal(statuses.at(-1).state, "error")
  assert.match(diagnostics[0].details, /forbidden/)
  service.syncFrom("https://three.example/db")
  assert.equal(syncs[0].chain.cancelled, true)

  service.syncFrom("")
  assert.equal(replications[3].chain.cancelled, true)
  assert.deepEqual(statuses.at(-1), {
    state: "disabled",
    message: "Sync is not configured"
  })
  assert.deepEqual(remoteChanges, [{
    id: "sto_one",
    doc: { _id: "sto_one", id: "one" },
    presentation: "foreground"
  }])
})

test("syncs settings, newest stories, backlog, then starts live sync", async () => {
  const replications = []
  const syncs = []
  const lifecycle = []
  const remote = {
    async createIndex(options) {
      assert.deepEqual(options.index.fields, ["ingested_at"])
    },
    async find(options) {
      assert.equal(options.limit, 50)
      assert.deepEqual(options.sort, [{ ingested_at: "desc" }])
      return { docs: [{ _id: "sto_newest" }, { _id: "sto_next" }] }
    }
  }
  const db = {
    replicate: {
      from(target, options) {
        const chain = eventChain()
        replications.push({ target, options, chain })
        return chain
      }
    },
    async changes(options) {
      lifecycle.push("conflicts-checked")
      assert.equal(options.conflicts, true)
      return { results: [], last_seq: 0 }
    },
    async get(id) {
      assert.ok(id.startsWith("_local/"))
      throw { status: 404 }
    },
    async put() {
      return { rev: "1-marker" }
    },
    async bulkDocs() {
      return []
    },
    async compact() {
      lifecycle.push("compacted")
    },
    sync(target, options) {
      lifecycle.push("live-sync-started")
      const chain = eventChain()
      syncs.push({ target, options, chain })
      return chain
    }
  }
  const statuses = []
  const remoteChanges = []
  const service = new PouchSyncService(db, () => {}, () => remote)
  service.onStatus((status) => statuses.push(status))
  service.onRemoteChange((change) => remoteChanges.push(change))

  service.syncFrom(
    "https://example.test/once",
    () => ["sto_loaded", "sto_loaded", "sto_visible"]
  )
  assert.deepEqual(replications[0].options.doc_ids, [
    "sources",
    "cache_timing",
    "filter_list",
    "redirect_list",
    "theme",
    "animation",
    "swipe"
  ])
  assert.equal(replications[0].options.batch_size, 1000)
  assert.equal(replications[0].options.batches_limit, 2)
  assert.equal(replications[0].options.checkpoint, "target")

  replications[0].chain.emit("complete", {})
  await nextTurn()
  let replayed = 0
  service.onSettingsReplicated(() => { replayed += 1 })
  await nextTurn()
  assert.equal(replayed, 1)
  assert.deepEqual(replications[1].options.doc_ids, [
    "sto_loaded",
    "sto_visible"
  ])
  assert.equal(statuses.at(-1).message, "Refreshing loaded stories…")

  replications[1].chain.emit("change", {
    docs: [{ _id: "sto_loaded", href: "loaded" }]
  })
  replications[1].chain.emit("complete", {})
  await nextTurn()
  assert.deepEqual(replications[2].options.doc_ids, [
    "sto_newest",
    "sto_next"
  ])
  assert.match(statuses.at(-1).message, /newest stories/)

  replications[2].chain.emit("change", {
    docs: [
      { _id: "sto_newest", href: "newest" },
      { _id: "sto_next", href: "next" }
    ]
  })
  assert.equal(statuses.at(-1).message, "Loading newest stories (2/2)…")
  replications[2].chain.emit("complete", {})
  await nextTurn()
  assert.deepEqual(replications[3].options, {
    batch_size: 1000,
    batches_limit: 2,
    checkpoint: "target"
  })
  assert.equal(statuses.at(-1).message, "Loading older stories…")

  replications[3].chain.emit("change", {
    docs: [{ _id: "sto_older", href: "older" }]
  })
  assert.equal(statuses.at(-1).message, "Loading older stories (1 received)…")
  replications[3].chain.emit("complete", {})
  await nextTurn()
  assert.equal(syncs.length, 1)
  assert.deepEqual(lifecycle, [
    "conflicts-checked",
    "compacted",
    "live-sync-started"
  ])
  assert.equal(syncs[0].target, remote)
  assert.deepEqual(syncs[0].options, {
    batch_size: 1000,
    batches_limit: 2,
    checkpoint: "target",
    live: true,
    retry: true
  })
  assert.equal(statuses.at(-1).state, "up-to-date")
  assert.equal(statuses.at(-1).changes, 4)
  assert.deepEqual(
    remoteChanges.map(({ id, presentation }) => ({ id, presentation })),
    [
      {
        id: "sto_loaded",
        presentation: "foreground"
      },
      {
        id: "sto_newest",
        presentation: "foreground"
      },
      {
        id: "sto_next",
        presentation: "foreground"
      },
      {
        id: "sto_older",
        presentation: "background"
      }
    ]
  )
})
