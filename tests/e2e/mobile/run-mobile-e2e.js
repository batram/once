const path = require("path")
const fs = require("fs")
const net = require("net")
const { spawn, spawnSync } = require("child_process")

const platform = process.argv[2]
if (platform !== "android" && platform !== "ios") {
  console.error("Expected android or ios")
  process.exit(1)
}

const root = path.resolve(__dirname, "../../..")
const node = process.execPath
const npmCli = process.env.npm_execpath
if (!npmCli) throw new Error("Run mobile E2E through an npm script")
const appRoot = path.join(root, "apps", "mobile")
const appBundles = {
  android: "android/app/build/outputs/apk/development/debug/app-development-debug.apk",
  ios: "ios/build/Build/Products/Debug-iphonesimulator/Once Dev.app"
}
// Generated during builds; changes here must not count as source changes.
const generatedNames = new Set([
  "node_modules", "dist", "build", ".gradle", "output", "DerivedData",
  "xcuserdata", "public", "capacitor.config.json", "capacitor.plugins.json",
  "config.xml"
])

function newestSourceTime(target) {
  const stat = fs.statSync(target, { throwIfNoEntry: false })
  if (!stat) return 0
  if (!stat.isDirectory()) return stat.mtimeMs
  let newest = 0
  for (const entry of fs.readdirSync(target)) {
    if (generatedNames.has(entry)) continue
    newest = Math.max(newest, newestSourceTime(path.join(target, entry)))
  }
  return newest
}

function stalenessReason() {
  if (process.env.ONCE_MOBILE_APP) return null
  if (!fs.existsSync(path.join(appRoot, appBundles[platform]))) {
    return "the app bundle is missing"
  }
  let stamp
  try {
    stamp = JSON.parse(fs.readFileSync(path.join(appRoot, "dist", `.once-package-${platform}.json`), "utf8"))
  } catch {
    return "there is no build stamp from `mobile package`"
  }
  if (!stamp.e2e) return "the last build was not an --e2e build"
  if (stamp.channel !== "dev") return `the last build was for the ${stamp.channel} channel`
  const sources = [
    path.join(appRoot, "src"),
    path.join(appRoot, "webpack.config.js"),
    path.join(appRoot, "capacitor.config.ts"),
    path.join(appRoot, platform === "android" ? "android" : "ios"),
    ...fs.readdirSync(path.join(root, "packages")).map((name) =>
      path.join(root, "packages", name, "src"))
  ]
  if (sources.some((source) => newestSourceTime(source) > stamp.builtAt)) {
    return "sources changed since the last build"
  }
  return null
}

// Rebuild the app when the installed bundle would not match the sources or
// was not built for e2e, so tests never run against stale binaries.
function ensureFreshApp() {
  const reason = stalenessReason()
  if (!reason) return
  console.log(`Rebuilding the ${platform} dev app because ${reason}`)
  const build = spawnSync(
    node,
    [npmCli, "run", "mobile", "--", "package", platform, "--channel", "dev", "--e2e"],
    { cwd: root, stdio: "inherit" }
  )
  if (build.status !== 0) process.exit(build.status || 1)
}

const results = path.join(root, "test-results", "mobile")
fs.mkdirSync(results, { recursive: true })
const serverLog = fs.createWriteStream(path.join(results, `${platform}-test-server.log`))
let server
let stopping = false
let androidReverse

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

function configureAndroidReverse(port, env) {
  if (platform !== "android" || process.env.ONCE_MOBILE_TEST_URL) return
  const executable = process.platform === "win32" ? "adb.exe" : "adb"
  const sdk = env.ANDROID_HOME || env.ANDROID_SDK_ROOT
  const adb = sdk ? path.join(sdk, "platform-tools", executable) : executable
  const serial = env.ONCE_ANDROID_UDID || env.ANDROID_SERIAL
  const target = `tcp:${port}`
  const args = [...(serial ? ["-s", serial] : []), "reverse", target, target]
  const result = spawnSync(adb, args, { cwd: root, env, encoding: "utf8" })
  if (result.error) {
    throw new Error(`Unable to configure ADB reverse for the mobile test server: ${result.error.message}`)
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "unknown adb error").trim()
    throw new Error(`Unable to configure ADB reverse for the mobile test server: ${detail}`)
  }
  androidReverse = { adb, args: [...(serial ? ["-s", serial] : []), "reverse", "--remove", target], env }
  env.ONCE_MOBILE_TEST_URL = `http://127.0.0.1:${port}`
  console.log(`Forwarding Android 127.0.0.1:${port} to the host test server with adb reverse`)
}

function removeAndroidReverse() {
  if (!androidReverse) return
  spawnSync(androidReverse.adb, androidReverse.args, {
    cwd: root,
    env: androidReverse.env,
    stdio: "ignore"
  })
  androidReverse = undefined
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
  ensureFreshApp()
  const port = process.env.ONCE_MOBILE_TEST_PORT || String(await availablePort())
  const testEnv = { ...process.env, ONCE_MOBILE_TEST_PORT: port }
  try {
    configureAndroidReverse(port, testEnv)
    startServer(testEnv)
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
    server?.kill()
    removeAndroidReverse()
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
    removeAndroidReverse()
    serverLog.end()
    process.exit(code || 0)
  })
}

start()

function stop() {
  stopping = true
  server?.kill()
  removeAndroidReverse()
}
process.on("SIGINT", stop)
process.on("SIGTERM", stop)
