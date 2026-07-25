const path = require("path")
const { spawn } = require("child_process")
const { startTestServer } = require("./test-server-process")

const root = path.resolve(__dirname, "../../..")
const npmCli = process.env.npm_execpath
if (!npmCli) throw new Error("Run mobile web E2E through an npm script")

let testServer
let playwright
let stopping = false

async function stop(signal) {
  if (stopping) return
  stopping = true
  if (playwright?.exitCode === null) playwright.kill(signal || "SIGTERM")
  await testServer?.stop()
}

async function main() {
  testServer = startTestServer()
  const started = await testServer.ready
  const env = {
    ...started.env,
    ONCE_MOBILE_TEST_SERVER_EXTERNAL: "1"
  }
  playwright = spawn(process.execPath, [
    npmCli,
    "exec",
    "--",
    "playwright",
    "test",
    "--config",
    "tests/e2e/mobile/playwright.config.js"
  ], {
    cwd: root,
    env,
    stdio: "inherit",
    windowsHide: true
  })
  const result = await new Promise((resolve, reject) => {
    playwright.once("error", reject)
    playwright.once("exit", (code, signal) => resolve({ code, signal }))
  })
  await stop()
  if (result.signal) {
    console.error(`Mobile Playwright exited from signal ${result.signal}`)
    process.exitCode = 1
  } else {
    process.exitCode = result.code || 0
  }
}

process.on("SIGINT", () => { void stop("SIGINT") })
process.on("SIGTERM", () => { void stop("SIGTERM") })
main().catch(async error => {
  console.error(error)
  await stop()
  process.exitCode = 1
})
