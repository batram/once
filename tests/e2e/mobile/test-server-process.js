const crypto = require("crypto")
const fs = require("fs")
const os = require("os")
const path = require("path")
const { spawn } = require("child_process")

const root = path.resolve(__dirname, "../../..")

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

async function readHealth(port, timeout = 500) {
  const response = await fetch(`http://127.0.0.1:${port}/health`, {
    signal: AbortSignal.timeout(timeout)
  })
  if (!response.ok) throw new Error(`health check returned HTTP ${response.status}`)
  return response.json()
}

function waitForExit(child, timeout) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return Promise.race([
    new Promise(resolve => child.once("exit", () => resolve(true))),
    delay(timeout).then(() => false)
  ])
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  child.kill("SIGTERM")
  if (await waitForExit(child, 2_000)) return
  child.kill("SIGKILL")
  await waitForExit(child, 2_000)
}

function startTestServer(options = {}) {
  const requestedPort = String(options.port ?? process.env.ONCE_MOBILE_TEST_PORT ?? "0")
  const owner = options.owner || crypto.randomUUID()
  const suppliedDataDirectory = options.env?.ONCE_MOBILE_TEST_DATA_DIR ||
    process.env.ONCE_MOBILE_TEST_DATA_DIR
  const ownedDataDirectory = suppliedDataDirectory
    ? null
    : fs.mkdtempSync(path.join(os.tmpdir(), "once-mobile-test-"))
  const dataDirectory = suppliedDataDirectory || ownedDataDirectory
  const env = {
    ...process.env,
    ...options.env,
    ONCE_MOBILE_TEST_PORT: requestedPort,
    ONCE_MOBILE_TEST_OWNER: owner,
    ONCE_MOBILE_TEST_DATA_DIR: dataDirectory
  }
  const child = spawn(process.execPath, ["tests/mobile-env/server.js"], {
    cwd: root,
    env,
    stdio: ["ignore", options.stdout || "inherit", options.stderr || "inherit", "ipc"],
    windowsHide: true
  })

  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Mobile test server did not report readiness within 10s (requested port ${requestedPort})`))
    }, 10_000)
    const finish = (callback, value) => {
      clearTimeout(timeout)
      child.off("error", onError)
      child.off("exit", onExit)
      child.off("message", onMessage)
      callback(value)
    }
    const onError = error => finish(reject, error)
    const onExit = (code, signal) => finish(
      reject,
      new Error(`Mobile test server exited before readiness (code ${code ?? "none"}, signal ${signal ?? "none"})`)
    )
    const onMessage = message => {
      if (message?.type !== "once-mobile-test-server-ready") return
      finish(resolve, {
        port: message.port,
        owner,
        child,
        dataDirectory,
        env: { ...env, ONCE_MOBILE_TEST_PORT: String(message.port) }
      })
    }
    child.once("error", onError)
    child.once("exit", onExit)
    child.on("message", onMessage)
  })

  return {
    child,
    owner,
    ready,
    async stop() {
      await stopChild(child)
      if (ownedDataDirectory) {
        fs.rmSync(ownedDataDirectory, { recursive: true, force: true })
      }
    }
  }
}

module.exports = { readHealth, startTestServer, stopChild }
