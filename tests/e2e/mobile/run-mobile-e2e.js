const path = require("path")
const fs = require("fs")
const { spawn, spawnSync } = require("child_process")
const { startTestServer } = require("./test-server-process")
const {
  ADB_COMMAND_TIMEOUT_MS,
  adbFailureDetail,
  isAndroidEmulator,
  verifyAndroidTransport,
  resolveAndroidSerial
} = require("./android-device")

const platform = process.argv[2]
const visual = process.argv.includes("--visual")
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
const { newestSourceTime, packageSources, readStamp } = require("./build-freshness")

function stalenessReason() {
  if (process.env.ONCE_MOBILE_APP) return null
  if (!fs.existsSync(path.join(appRoot, appBundles[platform]))) {
    return "the app bundle is missing"
  }
  const stamp = readStamp(`.once-package-${platform}.json`)
  if (!stamp) return "there is no build stamp from `mobile package`"
  if (!stamp.e2e) return "the last build was not an --e2e build"
  if (stamp.channel !== "dev") return `the last build was for the ${stamp.channel} channel`
  const sources = [
    path.join(appRoot, "src"),
    path.join(appRoot, "webpack.config.js"),
    path.join(appRoot, "capacitor.config.ts"),
    path.join(appRoot, platform === "android" ? "android" : "ios"),
    ...(platform === "android" ? [path.join(appRoot, "extensions")] : []),
    ...packageSources()
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

function installVisualApp() {
  if (!visual) return
  const app = path.join(appRoot, appBundles[platform])
  let command
  let args
  if (platform === "android") {
    const executable = process.platform === "win32" ? "adb.exe" : "adb"
    const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
    command = sdk ? path.join(sdk, "platform-tools", executable) : executable
    const serial = resolveAndroidSerial(command, process.env, spawnSync, {
      npmScript: visual ? "inspect:mobile:android:run" : "test:mobile:e2e:android"
    })
    args = ["-s", serial, "install", "-r", app]
  } else {
    command = "xcrun"
    args = [
      "simctl",
      "install",
      process.env.ONCE_IOS_UDID || "booted",
      app
    ]
  }
  const install = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    timeout: platform === "android" ? 120_000 : undefined
  })
  if (install.error) {
    throw new Error(`Unable to install the visual-inspection app: ${install.error.message}`)
  }
  if (install.status !== 0) {
    throw new Error(`Unable to install the visual-inspection app (exit ${install.status})`)
  }
}

const results = path.join(root, "test-results", "mobile")
fs.mkdirSync(results, { recursive: true })
const serverLog = fs.createWriteStream(path.join(results, `${platform}-test-server.log`))
let stopping = false
let androidReverse
let testServer
let wdio
let runWatchdog
let finalizing = false

function configureAndroidReverse(port, env) {
  if (platform !== "android" || process.env.ONCE_MOBILE_TEST_URL) return
  const executable = process.platform === "win32" ? "adb.exe" : "adb"
  const sdk = env.ANDROID_HOME || env.ANDROID_SDK_ROOT
  const adb = sdk ? path.join(sdk, "platform-tools", executable) : executable
  const serial = resolveAndroidSerial(adb, env, spawnSync, {
    npmScript: visual ? "inspect:mobile:android:run" : "test:mobile:e2e:android"
  })
  verifyAndroidTransport(adb, serial, env, spawnSync)
  env.ONCE_ANDROID_UDID = serial
  env.ANDROID_SERIAL = serial
  if (isAndroidEmulator(serial)) {
    env.ONCE_MOBILE_TEST_URL = `http://10.0.2.2:${port}`
    console.log(
      `Connecting Android emulator ${serial} to the host test server at ` +
      `10.0.2.2:${port}`
    )
    return
  }
  const target = `tcp:${port}`
  const args = ["-s", serial, "reverse", target, target]
  const result = spawnSync(adb, args, {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: ADB_COMMAND_TIMEOUT_MS
  })
  if (result.error || result.status !== 0) {
    throw new Error(
      "Unable to configure ADB reverse for the mobile test server: " +
      adbFailureDetail(result, "adb reverse")
    )
  }
  androidReverse = { adb, args: ["-s", serial, "reverse", "--remove", target], env }
  env.ONCE_MOBILE_TEST_URL = `http://127.0.0.1:${port}`
  console.log(`Forwarding Android 127.0.0.1:${port} to the host test server with adb reverse`)
}

function removeAndroidReverse() {
  if (!androidReverse) return
  spawnSync(androidReverse.adb, androidReverse.args, {
    cwd: root,
    env: androidReverse.env,
    stdio: "ignore",
    timeout: ADB_COMMAND_TIMEOUT_MS
  })
  androidReverse = undefined
}

function forceStopWdio() {
  if (!wdio?.pid || wdio.exitCode !== null) return
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/pid", String(wdio.pid), "/t", "/f"], {
      stdio: "ignore",
      timeout: 5_000
    })
  } else {
    wdio.kill("SIGKILL")
  }
}

async function finalize(code) {
  if (finalizing) return
  finalizing = true
  clearTimeout(runWatchdog)
  await testServer?.stop()
  removeAndroidReverse()
  serverLog.end()
  process.exit(code)
}

async function start() {
  ensureFreshApp()
  installVisualApp()
  let testEnv
  let port
  try {
    testServer = startTestServer({
      port: process.env.ONCE_MOBILE_TEST_PORT || "0",
      stdout: "pipe",
      stderr: "pipe"
    })
    for (const stream of [testServer.child.stdout, testServer.child.stderr]) {
      stream.on("data", chunk => {
        process.stdout.write(chunk)
        serverLog.write(chunk)
      })
    }
    const started = await testServer.ready
    port = String(started.port)
    testEnv = started.env
    configureAndroidReverse(port, testEnv)
    if (stopping) return
    const database = visual ? `visual_${platform}` : `mobile_${platform}`
    const reset = await fetch(`http://127.0.0.1:${port}/test/databases/${database}/reset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ docs: [] })
    })
    if (!reset.ok) throw new Error(`Unable to reset ${database} test database`)
  } catch (error) {
    console.error(error)
    await finalize(1)
  }
  wdio = spawn(
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
    {
      cwd: root,
      stdio: "inherit",
      env: {
        ...testEnv,
        ...(visual ? { ONCE_MOBILE_VISUAL_INSPECTION: "1" } : {})
      }
    }
  )
  wdio.on("exit", async (code, signal) => {
    if (visual && !signal && code === 0) {
      console.log("")
      console.log(`${platform === "android" ? "Android emulator" : "iOS Simulator"} is ready for visual inspection.`)
      console.log("The fixture server will remain available while this command is running.")
      console.log("Press Ctrl-C when finished to remove forwarding and stop the fixture server.")
      return
    }
    await finalize(signal ? 1 : (code || 0))
  })
  wdio.on("error", async error => {
    console.error(error)
    await finalize(1)
  })
  if (!visual) {
    const configuredTimeout = Number(process.env.ONCE_MOBILE_E2E_TIMEOUT_MS || 600_000)
    const runTimeout = Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? configuredTimeout
      : 600_000
    runWatchdog = setTimeout(() => {
      console.error(
        `Mobile E2E run timed out after ${Math.round(runTimeout / 1000)}s; ` +
        "forcing WebdriverIO/Appium cleanup"
      )
      if (wdio?.exitCode === null) wdio.kill("SIGTERM")
      setTimeout(() => {
        forceStopWdio()
        void finalize(1)
      }, 5_000).unref()
    }, runTimeout)
  }
}

start()

function stop() {
  stopping = true
  if (wdio?.exitCode === null) wdio.kill("SIGTERM")
  setTimeout(forceStopWdio, 5_000).unref()
  void finalize(1)
}
process.on("SIGINT", stop)
process.on("SIGTERM", stop)
