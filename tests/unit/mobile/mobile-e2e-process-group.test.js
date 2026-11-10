const test = require("node:test")
const assert = require("node:assert/strict")
const { spawn } = require("node:child_process")
const { once } = require("node:events")
const { detachedGroup, stopProcessTree } = require("../../e2e/mobile/process-group")

// A parent that starts one child of its own and prints both pids; with
// "ignore" neither reacts to SIGTERM, like an Appium that hangs on shutdown.
const TREE = `
const { spawn } = require("node:child_process")
const mode = process.argv[1]
const leaf = "if (process.argv[1] === 'ignore') process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); console.log('up')"
const child = spawn(process.execPath, ["-e", leaf, mode], { stdio: ["ignore", "pipe", "inherit"] })
if (mode === "ignore") process.on("SIGTERM", () => {})
child.stdout.once("data", () => console.log(JSON.stringify([process.pid, child.pid])))
setInterval(() => {}, 1000)
`

async function startTree(t, mode) {
  const child = spawn(process.execPath, ["-e", TREE, mode], { detached: true, stdio: ["ignore", "pipe", "inherit"] })
  t.after(() => {
    try { process.kill(-child.pid, "SIGKILL") } catch { /* already gone */ }
  })
  const [line] = await once(child.stdout, "data")
  return { child, pids: JSON.parse(String(line)) }
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test("stopProcessTree ends a tree that exits on SIGTERM without waiting out the grace period", { skip: !detachedGroup }, async (t) => {
  const { child, pids } = await startTree(t, "exit")
  const exit = once(child, "exit")
  // Far longer than the test's own timeout: only a SIGTERM exit can pass.
  await stopProcessTree(child, { graceMs: 600_000, pollMs: 10 })
  assert.deepEqual(pids.map(alive), [false, false])
  assert.equal((await exit)[1], "SIGTERM")
})

test("stopProcessTree kills a parent and grandchild that ignore SIGTERM", { skip: !detachedGroup }, async (t) => {
  const { child, pids } = await startTree(t, "ignore")
  const exit = once(child, "exit")
  await stopProcessTree(child, { graceMs: 200, pollMs: 10 })
  assert.deepEqual(pids.map(alive), [false, false])
  assert.equal((await exit)[1], "SIGKILL")
})

test("stopProcessTree returns for a child that has already ended, or never started", { skip: !detachedGroup }, async () => {
  const child = spawn(process.execPath, ["-e", ""], { detached: true, stdio: "ignore" })
  await once(child, "exit")
  await stopProcessTree(child, { graceMs: 600_000, pollMs: 10 })
  await stopProcessTree(undefined)
})
