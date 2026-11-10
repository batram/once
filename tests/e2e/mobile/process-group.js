const { spawnSync } = require("child_process")
const { setTimeout: delay } = require("timers/promises")

// A child spawned with `detached` leads its own process group, so the whole
// tree below it (npm exec -> wdio -> its worker -> Appium) can be signalled
// and watched as one. Signalling only the child would leave the rest running
// whenever a link in that chain does not pass the signal on.
const detachedGroup = process.platform !== "win32"

function groupAlive(pid) {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    // EPERM still means a member exists; ESRCH means the group is gone.
    return error.code === "EPERM"
  }
}

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal)
  } catch {
    // The group ended between the check and the signal.
  }
}

function exited(child) {
  return child.exitCode !== null || child.signalCode !== null
}

/**
 * Ends `child` and everything it started: SIGTERM first, SIGKILL for whatever
 * is still running after `graceMs`. Resolves once nothing of it is left, so
 * the caller can exit without leaving a process behind.
 */
async function stopProcessTree(child, { graceMs = 5_000, pollMs = 100 } = {}) {
  if (!child?.pid) return
  if (!detachedGroup) {
    // Windows has no process groups to signal; taskkill /t walks the tree.
    if (exited(child)) return
    const gone = new Promise(resolve => child.once("exit", resolve))
    spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", timeout: 5_000 })
    await Promise.race([gone, delay(graceMs)])
    return
  }
  signalGroup(child.pid, "SIGTERM")
  const deadline = Date.now() + graceMs
  while (groupAlive(child.pid) && Date.now() < deadline) await delay(pollMs)
  if (!groupAlive(child.pid)) return
  signalGroup(child.pid, "SIGKILL")
  while (groupAlive(child.pid)) await delay(pollMs)
}

module.exports = { detachedGroup, stopProcessTree }
