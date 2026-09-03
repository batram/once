const fs = require("fs")
const path = require("path")
const { spawn, spawnSync } = require("child_process")

const root = path.resolve(__dirname, "../../..")
const appRoot = path.join(root, "apps", "mobile")
const npmCli = process.env.npm_execpath
if (!npmCli) throw new Error("Run the mobile CLI through npm run mobile")
const platformNames = new Set(["android", "ios"])
const rootPackage = require(path.join(root, "package.json"))
const mobilePackage = require(path.join(appRoot, "package.json"))

function fail(message) {
  console.error(`mobile: ${message}`)
  process.exit(1)
}

function loadAndroidLocalEnvironment() {
  const envPath = path.join(root, ".env.android.local")
  if (!fs.existsSync(envPath)) return
  for (const rawLine of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const separator = line.indexOf("=")
    if (separator < 1) fail(`invalid line in .env.android.local: ${rawLine}`)
    const name = line.slice(0, separator).trim()
    let value = line.slice(separator + 1).trim()
    if ((value.startsWith("\"") && value.endsWith("\"")) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (!(name in process.env)) process.env[name] = value
  }
}

function parse(argv) {
  const positional = []
  const options = { passthrough: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === "--") {
      options.passthrough = argv.slice(index + 1)
      break
    }
    if (value === "--channel" || value === "--target") {
      options[value.slice(2)] = argv[++index]
    } else if (value === "--e2e") {
      options.e2e = true
    } else if (value.startsWith("--")) {
      options.passthrough.push(value)
    } else {
      positional.push(value)
    }
  }
  return { command: positional[0], platform: positional[1], options }
}

function environment(channel) {
  return { ...process.env, ONCE_BUILD_CHANNEL: channel }
}

function publicPackageEnvironment(channel) {
  return {
    ...environment(channel),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_TERMINAL_PROMPT: "0"
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || root,
    env: options.env || process.env,
    stdio: "inherit",
    shell: false
  })
  if (result.error) fail(result.error.message)
  if (result.status !== 0) process.exit(result.status || 1)
}

function runNpm(args, env) {
  run(process.execPath, [npmCli, ...args], { env })
}

function javaCommand() {
  const candidates = [
    process.env.ONCE_JAVA_HOME && path.join(process.env.ONCE_JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java"),
    process.env.JAVA_HOME && path.join(process.env.JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java"),
    process.platform === "win32" && "C:\\Program Files\\OpenJDK\\jdk-21\\bin\\java.exe",
    process.platform === "win32" && "C:\\Program Files\\Android\\Android Studio\\jbr\\bin\\java.exe",
    "java"
  ].filter(Boolean)
  return candidates.find(candidate => candidate === "java" || fs.existsSync(candidate))
}

function javaEnvironment(channel) {
  const command = javaCommand()
  const javaHome = command === "java" ? process.env.JAVA_HOME : path.dirname(path.dirname(command))
  return { command, env: { ...environment(channel), ...(javaHome ? { JAVA_HOME: javaHome } : {}) } }
}

function androidEnvironment(channel) {
  const java = javaEnvironment(channel)
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Android", "Sdk")
  ].filter(Boolean)
  const sdk = candidates.find(candidate => fs.existsSync(candidate))
  if (!sdk) fail("Android SDK not found; set ANDROID_HOME or ANDROID_SDK_ROOT")
  return {
    command: java.command,
    env: { ...java.env, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk }
  }
}

function adbCommand(env) {
  const command = path.join(
    env.ANDROID_HOME,
    "platform-tools",
    process.platform === "win32" ? "adb.exe" : "adb"
  )
  if (!fs.existsSync(command)) fail(`adb not found at ${command}`)
  return command
}

const wirelessAddressPattern = /^[^:\s]+:\d+$/

// `adb mdns services` lists paired wireless-debugging devices advertising
// _adb-tls-connect._tcp, e.g.
//   adb-RF8RC1R3QFT-i4U24z  _adb-tls-connect._tcp  192.168.2.212:41525
// The port is reassigned on every reboot, so discovery beats a pinned address.
function discoverWirelessAddresses(adb, env) {
  const result = spawnSync(adb, ["mdns", "services"], { env, encoding: "utf8" })
  if (result.error || result.status !== 0) return []
  const addresses = []
  for (const line of (result.stdout || "").split(/\r?\n/)) {
    const match = line.trim().match(/^(\S+)\s+_adb-tls-connect\._tcp\.?\s+(\S+:\d+)$/)
    if (match && wirelessAddressPattern.test(match[2])) {
      addresses.push({ name: match[1], address: match[2] })
    }
  }
  return addresses
}

// On macOS, Bonjour discovery can intermittently return no services even while
// the ADB server still has a healthy wireless connection. An IP:port serial in
// `adb devices` is already connected and is therefore a safe discovery fallback.
function connectedWirelessAddresses(adb, env) {
  const result = spawnSync(adb, ["devices"], { env, encoding: "utf8" })
  if (result.error || result.status !== 0) return []
  const addresses = []
  for (const line of (result.stdout || "").split(/\r?\n/)) {
    const match = line.trim().match(/^(\S+)\s+device(?:\s|$)/)
    if (match && wirelessAddressPattern.test(match[1])) {
      addresses.push(match[1])
    }
  }
  return [...new Set(addresses)]
}

// Precedence: an explicit ONCE_ANDROID_WIRELESS_ADDRESS in the environment,
// then mDNS discovery, an existing ADB wireless connection, then
// .env.android.local.
function resolveWirelessAddress(adb, env) {
  const exported = process.env.ONCE_ANDROID_WIRELESS_ADDRESS
  if (exported) {
    if (!wirelessAddressPattern.test(exported)) {
      fail("ONCE_ANDROID_WIRELESS_ADDRESS must be an IP or hostname followed by :port")
    }
    console.log(`mobile: using ONCE_ANDROID_WIRELESS_ADDRESS ${exported}`)
    return exported
  }
  const discovered = discoverWirelessAddresses(adb, env)
  if (discovered.length > 1) {
    const listed = discovered.map(entry => `${entry.name} (${entry.address})`).join(", ")
    fail(`adb mdns found multiple devices: ${listed} — set ONCE_ANDROID_WIRELESS_ADDRESS to pick one`)
  }
  if (discovered.length === 1) {
    console.log(`mobile: discovered ${discovered[0].name} at ${discovered[0].address} via adb mdns`)
    return discovered[0].address
  }
  const connected = connectedWirelessAddresses(adb, env)
  if (connected.length > 1) {
    fail(`adb has multiple connected wireless devices: ${connected.join(", ")} — set ONCE_ANDROID_WIRELESS_ADDRESS to pick one`)
  }
  if (connected.length === 1) {
    console.log(`mobile: using connected wireless device ${connected[0]} from adb devices`)
    return connected[0]
  }
  loadAndroidLocalEnvironment()
  const address = process.env.ONCE_ANDROID_WIRELESS_ADDRESS
  if (!address) {
    fail("no wireless device found via adb mdns or adb devices; enable wireless debugging and pair the device, or copy .env.android.example to .env.android.local and set ONCE_ANDROID_WIRELESS_ADDRESS")
  }
  if (!wirelessAddressPattern.test(address)) {
    fail("ONCE_ANDROID_WIRELESS_ADDRESS must be an IP or hostname followed by :port")
  }
  console.log(`mobile: using ${address} from .env.android.local`)
  return address
}

function platformEnvironment(platform, channel) {
  return platform === "android" ? androidEnvironment(channel).env : environment(channel)
}

function requireHealthyAdb(env) {
  const adb = path.join(env.ANDROID_HOME, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb")
  if (!fs.existsSync(adb)) return
  const result = spawnSync(adb, ["devices"], { env, encoding: "utf8" })
  if (result.error || result.status !== 0) return
  const offline = result.stdout.split(/\r?\n/).map(line => line.trim()).filter(line => /^\S+\s+offline$/.test(line))
  if (offline.length) {
    fail(`adb reports offline device(s): ${offline.join(", ")} — cold-boot the emulator or run adb kill-server before retrying`)
  }
}

function cap(args, env) {
  runNpm(["exec", "--workspace", "@once/mobile", "--", "cap", ...args], env)
}

function validatePlatform(platform, optional = false) {
  if (!platform && optional) return
  if (!platformNames.has(platform)) fail("platform must be android or ios")
  if (platform === "ios" && process.platform !== "darwin") {
    fail("iOS native commands require macOS with Xcode")
  }
}

function channelFor(command, value) {
  const channel = value || (command === "package" ? undefined : "dev")
  if (!channel) fail("package requires --channel dev or --channel release")
  if (channel !== "dev" && channel !== "release") fail("channel must be dev or release")
  return channel
}

function buildWeb(channel) {
  const env = environment(channel)
  runNpm(["run", "build:packages"], env)
  runNpm(["run", channel === "dev" ? "build:dev" : "build", "--workspace", "@once/mobile"], env)
  writeWebStamp(channel)
}

// Record what the web bundle in dist was built from. `npm run check` runs a
// plain `build:mobile:dev`, which overwrites an --e2e bundle with one that
// loads stories from the network at startup; the mobile web suite reads this
// stamp so it rebuilds instead of failing in ways that look like gesture bugs.
function writeWebStamp(channel) {
  fs.mkdirSync(path.join(appRoot, "dist"), { recursive: true })
  fs.writeFileSync(
    path.join(appRoot, "dist", ".once-web-build.json"),
    JSON.stringify({
      channel,
      e2e: Boolean(options.e2e),
      builtAt: Date.now()
    })
  )
}

function sync(platform, channel) {
  buildWeb(channel)
  cap(["sync", platform], platformEnvironment(platform, channel))
}

// Record what the last package build produced so the e2e runner can detect
// stale or mismatched (non-e2e, wrong channel) app bundles and rebuild.
function writePackageStamp(platform, channel) {
  fs.mkdirSync(path.join(appRoot, "dist"), { recursive: true })
  fs.writeFileSync(
    path.join(appRoot, "dist", `.once-package-${platform}.json`),
    JSON.stringify({
      channel,
      e2e: Boolean(options.e2e),
      builtAt: Date.now()
    })
  )
}

const { command, platform, options } = parse(process.argv.slice(2))
if (!command) fail("expected doctor, web, sync, run, serve, open, package, or deploy")
if (options.e2e) process.env.ONCE_MOBILE_E2E = "1"

if (command === "doctor") {
  validatePlatform(platform, true)
  if (Number.parseInt(process.versions.node, 10) < 24) fail("Node 24 or newer is required")
  if (mobilePackage.version !== rootPackage.version) fail("apps/mobile version must match the root version")
  if (!/^\d+\.\d+\.\d+/.test(rootPackage.version)) fail("root package version is invalid")
  if (process.env.ONCE_BUILD_NUMBER && !/^[1-9]\d*$/.test(process.env.ONCE_BUILD_NUMBER)) {
    fail("ONCE_BUILD_NUMBER must be a positive integer")
  }
  const required = ["capacitor.config.ts", "src/main.ts", "webpack.config.js"]
  for (const file of required) {
    if (!fs.existsSync(path.join(appRoot, file))) fail(`missing apps/mobile/${file}`)
  }
  if (platform && !fs.existsSync(path.join(appRoot, platform))) {
    fail(`missing committed apps/mobile/${platform} project`)
  }
  if (!platform || platform === "android") {
    const gradle = fs.readFileSync(path.join(appRoot, "android", "app", "build.gradle"), "utf8")
    if (!gradle.includes("development") || !gradle.includes("production")) {
      fail("Android development and production flavors are missing")
    }
  }
  if (!platform || platform === "ios") {
    for (const scheme of ["Once Dev.xcscheme", "Once.xcscheme"]) {
      if (!fs.existsSync(path.join(appRoot, "ios", "App", "App.xcodeproj", "xcshareddata", "xcschemes", scheme))) {
        fail(`missing iOS scheme ${scheme}`)
      }
    }
  }
  let doctorEnv = environment(options.channel || "dev")
  if (!platform || platform === "android") {
    const android = androidEnvironment(options.channel || "dev")
    run(android.command, ["-version"], { env: android.env })
    doctorEnv = android.env
  }
  cap(["doctor", ...(platform ? [platform] : [])], doctorEnv)
  process.exit(0)
}

if (command === "web") {
  if (platform) fail("web does not accept a platform")
  buildWeb(channelFor(command, options.channel))
  process.exit(0)
}

validatePlatform(platform)
const channel = channelFor(command, options.channel)
if (command === "run" && channel !== "dev") fail("run only supports the dev channel")

if (command === "sync") sync(platform, channel)
else if (command === "run") {
  const env = platformEnvironment(platform, channel)
  if (platform === "android") requireHealthyAdb(env)
  sync(platform, channel)
  const target = options.target ? ["--target", options.target] : []
  cap(["run", platform, "--no-sync", ...target, ...options.passthrough], env)
} else if (command === "open") {
  sync(platform, channel)
  cap(["open", platform], platformEnvironment(platform, channel))
} else if (command === "serve") {
  if (channel !== "dev") fail("serve only supports the dev channel")
  buildWeb(channel)
  const server = spawn(process.execPath, [npmCli, "run", "serve", "--workspace", "@once/mobile"], {
    cwd: root,
    env: environment(channel),
    stdio: "inherit",
    shell: false
  })
  const stop = () => server.kill()
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
  cap(["run", platform, "--live-reload", "--port", "5173", ...options.passthrough], platformEnvironment(platform, channel))
  stop()
} else if (command === "deploy") {
  if (platform !== "android") fail("deploy only supports android")
  if (channel !== "release") fail("deploy only supports the release channel")
  const android = androidEnvironment(channel)
  const adb = adbCommand(android.env)
  const address = resolveWirelessAddress(adb, android.env)
  sync(platform, channel)
  run(android.command, [
    "-classpath",
    path.join(appRoot, "android", "gradle", "wrapper", "gradle-wrapper.jar"),
    "org.gradle.wrapper.GradleWrapperMain",
    "assembleProductionDebug",
    "--no-daemon"
  ], {
    cwd: path.join(appRoot, "android"),
    env: android.env
  })
  const apk = path.join(
    appRoot,
    "android",
    "app",
    "build",
    "outputs",
    "apk",
    "production",
    "debug",
    "app-production-debug.apk"
  )
  if (!fs.existsSync(apk)) fail(`built APK not found at ${apk}`)
  run(adb, ["connect", address], { env: android.env })
  run(adb, ["-s", address, "install", "-r", apk], { env: android.env })
} else if (command === "package") {
  sync(platform, channel)
  if (platform === "android") {
    // The built-in extension bundles are not in the repository; they are
    // fetched against pinned hashes before the APK that carries them is built.
    run(process.execPath, [path.join(root, "scripts", "fetch-extensions.js")])
    const android = androidEnvironment(channel)
    const gradleTask = channel === "release"
      ? "bundleProductionRelease"
      : "assembleDevelopmentDebug"
    run(android.command, [
      "-classpath",
      path.join(appRoot, "android", "gradle", "wrapper", "gradle-wrapper.jar"),
      "org.gradle.wrapper.GradleWrapperMain",
      gradleTask,
      "--no-daemon"
    ], {
      cwd: path.join(appRoot, "android"),
      env: android.env
    })
  } else {
    const release = channel === "release"
    const buildPath = path.join(appRoot, "ios", "build")
    run("xcodebuild", [
      "-project", "App/App.xcodeproj",
      "-scheme", release ? "Once" : "Once Dev",
      "-configuration", release ? "Release" : "Debug",
      ...(release
        ? [
          "-destination", "generic/platform=iOS",
          "-archivePath", path.join(buildPath, "Once.xcarchive")
        ]
        : ["-sdk", "iphonesimulator"]),
      "-scmProvider", "system",
      "-packageAuthorizationProvider", "netrc",
      "-derivedDataPath", buildPath,
      `CURRENT_PROJECT_VERSION=${process.env.ONCE_BUILD_NUMBER || "1"}`,
      ...(release ? ["CODE_SIGNING_ALLOWED=NO", "archive"] : ["build"])
    ], { cwd: path.join(appRoot, "ios"), env: publicPackageEnvironment(channel) })
  }
  writePackageStamp(platform, channel)
} else fail(`unknown command ${command}`)
