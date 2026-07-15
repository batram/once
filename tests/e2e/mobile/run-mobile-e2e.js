const path = require("path")
const fs = require("fs")
const net = require("net")
const { spawn } = require("child_process")

const platform = process.argv[2]
if (platform !== "android" && platform !== "ios") {
  console.error("Expected android or ios")
  process.exit(1)
}

const root = path.resolve(__dirname, "../../..")
const node = process.execPath
const npmCli = process.env.npm_execpath
if (!npmCli) throw new Error("Run mobile E2E through an npm script")
const results = path.join(root, "test-results", "mobile")
fs.mkdirSync(results, { recursive: true })
const serverLog = fs.createWriteStream(path.join(results, `${platform}-test-server.log`))
let server
let stopping = false

function availablePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      const port = typeof address === "object" && address ? address.port : 0
      probe.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

function startServer(env) {
  server = spawn(node, ["tests/mobile-env/server.js"], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  })
  for (const stream of [server.stdout, server.stderr]) {
    stream.on("data", chunk => {
      process.stdout.write(chunk)
      serverLog.write(chunk)
    })
  }
}

async function waitForServer(port) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Mobile test server exited with ${server.exitCode}`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`)
      if (response.ok) return
    } catch {
      // Server is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Mobile test server did not become ready on port ${port}`)
}

async function start() {
  const port = process.env.ONCE_MOBILE_TEST_PORT || String(await availablePort())
  const testEnv = { ...process.env, ONCE_MOBILE_TEST_PORT: port }
  startServer(testEnv)
  try {
    await waitForServer(port)
    if (stopping) return
    const reset = await fetch(`http://127.0.0.1:${port}/test/databases/mobile_${platform}/reset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ docs: [] })
    })
    if (!reset.ok) throw new Error(`Unable to reset mobile_${platform} test database`)
  } catch (error) {
    console.error(error)
    server.kill()
    serverLog.end()
    process.exit(1)
    return
  }
  const wdio = spawn(
    node,
    [
      npmCli,
      "exec",
      "--workspace",
      "@once/mobile",
      "--",
      "wdio",
      path.join(root, `tests/e2e/mobile/wdio.${platform}.conf.js`)
    ],
    { cwd: root, stdio: "inherit", env: testEnv }
  )
  wdio.on("exit", (code) => {
    server.kill()
    serverLog.end()
    process.exit(code || 0)
  })
}

start()

function stop() {
  stopping = true
  server?.kill()
}
process.on("SIGINT", stop)
process.on("SIGTERM", stop)
