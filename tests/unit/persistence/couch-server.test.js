const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs/promises")
const http = require("node:http")
const os = require("node:os")
const path = require("node:path")
const { setTimeout: delay } = require("node:timers/promises")
const PouchDB = require("pouchdb")
const couchServer = require("../../helpers/couch-server")

async function waitForListeners(db, expected) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (db.listenerCount("destroyed") === expected) return
    await delay(10)
  }
  assert.equal(db.listenerCount("destroyed"), expected)
}

function longPoll(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, response => {
      let body = ""
      const result = new Promise((resolve, reject) => {
        response.on("data", chunk => { body += chunk })
        response.on("end", () => resolve(JSON.parse(body)))
        response.on("error", reject)
      })
      // Aborting an open poll rejects its response; observe it immediately.
      result.catch(() => {})
      resolve({ request, result })
    })
    request.on("error", reject)
  })
}

test("concurrent HTTP change polls allow scan listeners and release them on completion and cancellation", { timeout: 10_000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "once-couch-listeners-"))
  const Db = PouchDB.defaults({ prefix: directory + path.sep })
  const api = couchServer(Db, { mode: "minimumForPouchDB", inMemoryConfig: true })
  const source = new Db("once")
  await source.info()
  const handles = new Set()
  let peak = 0
  const changes = Db.prototype.changes
  t.mock.method(Db.prototype, "changes", function (...args) {
    const feed = changes.apply(this, args)
    if (this.name === "once" && this !== source) {
      handles.add(this)
      peak = Math.max(peak, this.listenerCount("destroyed"))
    }
    return feed
  })
  const warnings = []
  const onWarning = warning => {
    if (warning.name === "MaxListenersExceededWarning" && handles.has(warning.emitter)) warnings.push(warning.message)
  }
  process.on("warning", onWarning)
  const server = await new Promise(resolve => { const listening = api.listen(0, "127.0.0.1", () => resolve(listening)) })
  t.after(async () => {
    process.removeListener("warning", onWarning)
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await source.destroy()
    await Db.allDbs()
    await new Db("pouch__all_dbs__").close()
    await fs.rm(directory, { recursive: true, force: true })
  })
  const url = `http://127.0.0.1:${server.address().port}/once/_changes`
  const response = await fetch(url)
  assert.equal(response.status, 200)
  await response.json()
  assert.equal(handles.size, 1)
  const [served] = handles
  const baseline = served.listenerCount("destroyed")
  assert.equal(source.getMaxListeners(), 10, "the caller's database keeps its default limit")
  assert.ok(Number.isFinite(served.getMaxListeners()) && served.getMaxListeners() > 0)

  for (let round = 0; round < 4; round++) {
    const since = (await source.info()).update_seq
    const polls = await Promise.all(Array.from({ length: 6 }, () => longPoll(`${url}?feed=longpoll&since=${since}`)))
    await waitForListeners(served, baseline + polls.length)
    if (round % 2 === 0) {
      const id = `change-${round}`
      await source.put({ _id: id })
      for (const poll of polls) assert.equal((await poll.result).results[0].id, id)
    } else {
      for (const poll of polls) poll.request.destroy()
      await Promise.allSettled(polls.map(poll => poll.result))
    }
    await waitForListeners(served, baseline)
  }
  assert.ok(peak > 10, "exercise the transient listener count that exceeded Node's default")
  assert.deepEqual(warnings, [])
})
