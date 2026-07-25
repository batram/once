const fs = require("fs")
const path = require("path")
const { spawnSync } = require("child_process")

const root = path.resolve(__dirname, "../../..")
const npmCli = process.env.npm_execpath
if (!npmCli) throw new Error("Run mobile E2E through an npm script")
const visual = process.argv.includes("--visual")

function fail(message) {
  console.error(`mobile-e2e: ${message}`)
  process.exit(1)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: options.env || process.env,
    stdio: options.capture ? "pipe" : "inherit",
    encoding: options.capture ? "utf8" : undefined,
    shell: false
  })
  if (result.error) fail(result.error.message)
  if (result.status !== 0) {
    if (options.capture) process.stderr.write(result.stderr || result.stdout || "")
    process.exit(result.status || 1)
  }
  return result
}

function runNpm(args, env, capture = false) {
  return run(process.execPath, [npmCli, ...args], { env, capture })
}

function androidEnvironment() {
  const sdkCandidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Android", "Sdk")
  ].filter(Boolean)
  const sdk = sdkCandidates.find(candidate => fs.existsSync(candidate))
  if (!sdk) fail("Android SDK not found; set ANDROID_HOME or ANDROID_SDK_ROOT")

  const javaCandidates = [
    process.env.ONCE_JAVA_HOME,
    process.env.JAVA_HOME,
    process.platform === "win32" && "C:\\Program Files\\OpenJDK\\jdk-21",
    process.platform === "win32" && "C:\\Program Files\\Android\\Android Studio\\jbr"
  ].filter(Boolean)
  const javaHome = javaCandidates.find(candidate => fs.existsSync(path.join(candidate, "bin")))

  return {
    sdk,
    env: {
      ...process.env,
      ANDROID_HOME: sdk,
      ANDROID_SDK_ROOT: sdk,
      ...(javaHome ? { JAVA_HOME: javaHome } : {})
    }
  }
}

function requireConnectedDevice(sdk, env) {
  const adb = path.join(sdk, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb")
  if (!fs.existsSync(adb)) fail(`adb not found at ${adb}`)
  const result = run(adb, ["devices"], { env, capture: true })
  const connected = result.stdout.split(/\r?\n/)
    .map(line => /^(\S+)\s+device(?:\s|$)/.exec(line.trim())?.[1])
    .filter(Boolean)
  const requested = process.env.ONCE_ANDROID_UDID || process.env.ANDROID_SERIAL
  if (requested && !connected.includes(requested)) {
    fail(`Android device ${requested} is not ready; adb reports: ${connected.join(", ") || "none"}`)
  }
  if (!connected.length) {
    fail("no Android device is ready; start an emulator or connect a device and try again")
  }
  if (!requested && connected.length > 1) {
    fail(`multiple Android devices are ready (${connected.join(", ")}); set ONCE_ANDROID_UDID`)
  }
  return requested || connected[0]
}

function ensureUiAutomatorDriver(env) {
  const list = runNpm(
    ["exec", "--workspace", "@once/mobile", "--", "appium", "driver", "list", "--installed"],
    env,
    true
  )
  if (!/uiautomator2@8\.1\.0\b/.test(`${list.stdout}\n${list.stderr}`)) {
    runNpm(
      ["exec", "--workspace", "@once/mobile", "--", "appium", "driver", "install", "uiautomator2@8.1.0"],
      env
    )
  }
}

const android = androidEnvironment()
const serial = requireConnectedDevice(android.sdk, android.env)
const env = { ...android.env, ONCE_ANDROID_UDID: serial, ANDROID_SERIAL: serial }
ensureUiAutomatorDriver(env)
runNpm(["run", "mobile", "--", "package", "android", "--channel", "dev", "--e2e"], env)
runNpm([
  "run",
  visual ? "inspect:mobile:android:run" : "test:mobile:e2e:android"
], env)
