const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const {
  isNetworkPermissionError,
  readHealth,
  startTestServer
} = require("../../e2e/mobile/test-server-process")

async function requireServer(t, options = {}) {
  const server = startTestServer({
    ...options,
    host: "127.0.0.1",
    stdout: options.stdout || "ignore",
    stderr: options.stderr || "ignore"
  })
  t.after(() => server.stop())
  try {
    return { server, started: await server.ready }
  } catch (error) {
    if (!isNetworkPermissionError(error)) throw error
    t.skip(
      "loopback listeners are unavailable in this test environment " +
      `(${error.code})`
    )
    return null
  }
}

test("mobile test server atomically selects a port and reports ownership", async t => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "once-mobile-server-"))
  const running = await requireServer(t, {
    port: 0,
    owner: "unit-test-owner",
    env: { ONCE_MOBILE_TEST_DATA_DIR: dataRoot }
  })
  if (!running) return
  const { server, started } = running
  assert.ok(started.port > 0)
  assert.equal(started.env.ONCE_MOBILE_TEST_PORT, String(started.port))
  assert.deepEqual(await readHealth(started.port), {
    ok: true,
    owner: "unit-test-owner",
    pid: server.child.pid,
    port: started.port
  })

  const reset = await fetch(
    `http://127.0.0.1:${started.port}/test/databases/mobile_test/reset`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ docs: [] })
    }
  )
  assert.equal(reset.status, 200)
  assert.ok(fs.existsSync(path.resolve(dataRoot)))
})

test("independent dynamic-port servers use independent database roots", async t => {
  const firstRunning = await requireServer(t, {
    port: 0,
    owner: "isolation-first"
  })
  if (!firstRunning) return
  const secondRunning = await requireServer(t, {
    port: 0,
    owner: "isolation-second"
  })
  if (!secondRunning) return
  const { started: firstStarted } = firstRunning
  const { started: secondStarted } = secondRunning

  assert.notEqual(firstStarted.port, secondStarted.port)
  for (const port of [firstStarted.port, secondStarted.port]) {
    const reset = await fetch(`http://127.0.0.1:${port}/test/databases/isolation/reset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ docs: [{ _id: `from-${port}` }] })
    })
    assert.equal(reset.status, 200)
  }

  assert.notEqual(firstStarted.dataDirectory, secondStarted.dataDirectory)
  assert.ok(fs.existsSync(firstStarted.dataDirectory))
  assert.ok(fs.existsSync(secondStarted.dataDirectory))
})

test("mobile test server rejects an explicitly occupied port without disturbing its owner", async t => {
  const running = await requireServer(t, { port: 0, owner: "first" })
  if (!running) return
  const { server: first, started } = running

  const second = startTestServer({
    port: started.port,
    owner: "second",
    host: "127.0.0.1",
    stdout: "ignore",
    stderr: "ignore"
  })
  t.after(() => second.stop())
  await assert.rejects(second.ready, error =>
    error.name === "MobileTestServerStartupError" &&
    error.code === "EADDRINUSE")

  const health = await readHealth(started.port)
  assert.equal(health.owner, "first")
  assert.equal(health.pid, first.child.pid)
})

test("mobile test server exits cleanly when its owner stops it", async t => {
  const running = await requireServer(t, { port: 0 })
  if (!running) return
  const { server, started } = running
  assert.ok(fs.existsSync(started.dataDirectory))
  await server.stop()
  assert.notEqual(server.child.exitCode ?? server.child.signalCode, null)
  assert.equal(fs.existsSync(started.dataDirectory), false)
  await assert.rejects(readHealth(started.port, 200))
})

test("database reset replaces documents in place without a destroy/recreate race", async t => {
  const running = await requireServer(t, { port: 0, owner: "reset-test" })
  if (!running) return
  const { started: { port } } = running
  const resetUrl = `http://127.0.0.1:${port}/test/databases/reset_test/reset`

  for (const docs of [
    [{ _id: "old", value: 1 }],
    [{ _id: "new", value: 2 }],
    [{ _id: "final", value: 3 }]
  ]) {
    const response = await fetch(resetUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ docs })
    })
    assert.equal(response.status, 200)
  }

  const authorization = `Basic ${Buffer.from("once-test:once-test").toString("base64")}`
  const allDocs = await fetch(
    `http://127.0.0.1:${port}/db/reset_test/_all_docs?include_docs=true`,
    { headers: { authorization } }
  )
  assert.equal(allDocs.status, 200)
  const payload = await allDocs.json()
  assert.deepEqual(payload.rows.map(row => row.id), ["final"])
})
