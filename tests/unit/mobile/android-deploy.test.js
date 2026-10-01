const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const test = require("node:test")
const { deploymentSettings, selectDeploymentAbis, installApk } = require("../../../apps/mobile/scripts/android-deploy")

test("deployment selects the device ABI and rejects incompatible overrides", () => {
  assert.deepEqual(selectDeploymentAbis("auto", "arm64-v8a,armeabi-v7a\r\n"), ["arm64-v8a"])
  assert.deepEqual(selectDeploymentAbis("auto", "x86_64,x86"), ["x86_64"])
  assert.deepEqual(selectDeploymentAbis("all", "arm64-v8a"), ["arm64-v8a", "x86_64"])
  assert.throws(() => selectDeploymentAbis("auto", "armeabi-v7a"), /do not support/)
  assert.throws(() => selectDeploymentAbis("x86_64", "arm64-v8a"), /do not support/)
  assert.throws(() => selectDeploymentAbis("auto", ""), /no ABIs reported/)
})

test("deployment validates configuration before building or installing", () => {
  for (const env of [
    { ONCE_ANDROID_DEPLOY_ABIS: "arm64-v8a," },
    { ONCE_ANDROID_DEPLOY_ABIS: "armeabi-v7a" },
    { ONCE_ANDROID_INSTALL_MODE: "magic" },
    { ONCE_ANDROID_GRADLE_DAEMON: "yes" }
  ]) assert.throws(() => deploymentSettings(env), /must be/)
  assert.equal(deploymentSettings({ ONCE_ANDROID_GRADLE_DAEMON: "false" }).daemon, false)
})

test("failed patch installs retry a full install without uninstalling or clearing data", () => {
  const calls = []
  installApk("adb", "phone", "app.apk", "fastdeploy", {}, (_command, args) => {
    calls.push(args)
    return { status: calls.length === 1 ? 1 : 0 }
  })
  assert.deepEqual(calls, [
    ["-s", "phone", "install", "-r", "--streaming", "--fastdeploy", "app.apk"],
    ["-s", "phone", "install", "-r", "--no-streaming", "app.apk"]
  ])
  assert.throws(() => installApk("adb", "phone", "app.apk", "push", {}, () => ({ status: 1 })), /install failed/)
  assert.throws(() => installApk("adb", "phone", "app.apk", "fastdeploy", {}, () => ({ error: new Error("spawn failed") })), /spawn failed/)
})

// Execute the actual CLI with a fake device/process boundary. In particular,
// exercise .env loading even when mDNS succeeds, before the SDK is resolved.
function deploy({ local = "", exported = {}, mdns = "phone _adb-tls-connect._tcp 192.0.2.1:1234", target = [], missing = "", directory = "", calls = [] } = {}) {
  const root = path.resolve(__dirname, "../../..")
  const filename = path.join(root, "apps/mobile/scripts/mobile-cli.js")
  const execute = (command, args, options) => {
    calls.push({ command, args, env: options.env })
    const stdout = args[0] === "mdns" ? mdns
      : args.includes("getprop") ? "arm64-v8a,armeabi-v7a\n" : ""
    return { status: 0, stdout }
  }
  const env = { npm_execpath: "npm-cli.js", ANDROID_HOME: "C:/sdk", JAVA_HOME: "C:/java", ...exported }
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    __dirname: path.dirname(filename), performance,
    console: { log() {}, warn() {}, error() {} },
    process: {
      env, platform: process.platform, execPath: process.execPath,
      argv: ["node", filename, "deploy", "android", "--channel", "release", ...target],
      exit(code) { throw new Error(`exit ${code}`) }
    },
    require(name) {
      if (name === "fs") return {
        ...fs, existsSync: file => file !== missing, mkdirSync() {}, writeFileSync() {},
        statSync: file => ({ size: 100, isFile: () => file !== directory }),
        readFileSync: (file, encoding) => file.endsWith(".env.android.local") ? local : fs.readFileSync(file, encoding)
      }
      if (name === "child_process") return { spawnSync: execute }
      if (name === "./android-deploy") return {
        deploymentSettings, selectDeploymentAbis,
        installApk: (...args) => installApk(...args, execute)
      }
      return require(name)
    }
  }, { filename })
  return calls
}

test("local tuning is read with working discovery; its stale wireless address stays a fallback", () => {
  const calls = deploy({ local: [
    "ONCE_ANDROID_WIRELESS_ADDRESS=192.0.2.2:5678",
    "ONCE_ANDROID_DEPLOY_ABIS=all",
    "ONCE_ANDROID_INSTALL_MODE=streaming",
    "ONCE_ANDROID_GRADLE_DAEMON=false",
    "ONCE_JAVA_HOME=C:/configured-java"
  ].join("\n") })
  const build = calls.find(call => call.args.includes("assembleProductionDebug"))
  assert.ok(build.args.includes("-PonceDeployAbis=arm64-v8a,x86_64"))
  assert.ok(build.args.includes("--no-daemon"))
  assert.ok(build.command.includes("configured-java"))
  const install = calls.find(call => call.args.includes("install"))
  assert.equal(install.args[1], "192.0.2.1:1234")
  assert.ok(install.args.includes("--streaming"))
})

test("exported settings override local tuning and local address works without discovery", () => {
  const calls = deploy({
    mdns: "", local: "ONCE_ANDROID_INSTALL_MODE=streaming\nONCE_ANDROID_WIRELESS_ADDRESS=192.0.2.2:5678",
    exported: { ONCE_ANDROID_INSTALL_MODE: "push" }
  })
  const install = calls.find(call => call.args.includes("install"))
  assert.equal(install.args[1], "192.0.2.2:5678")
  assert.ok(install.args.includes("--no-streaming"))
  const build = calls.find(call => call.args.includes("assembleProductionDebug"))
  assert.ok(build.args.includes("-PonceDeployAbis=arm64-v8a"))
  assert.ok(build.args.includes("--daemon"))
})

test("exported wireless address beats discovery and explicit USB target bypasses it", () => {
  const wireless = deploy({ exported: { ONCE_ANDROID_WIRELESS_ADDRESS: "192.0.2.3:6789" } })
  assert.equal(wireless.find(call => call.args.includes("install")).args[1], "192.0.2.3:6789")
  const usb = deploy({ local: "ONCE_ANDROID_SERIAL=local-phone", target: ["--target", "usb-phone"] })
  assert.equal(usb.find(call => call.args.includes("install")).args[1], "usb-phone")
  assert.ok(!usb.some(call => ["connect", "mdns"].includes(call.args[0])))
})

test("custom install ADB supports spaces while SDK ADB manages device discovery", () => {
  const custom = path.resolve("custom tools", "adb.exe")
  const calls = deploy({ local: `ONCE_ANDROID_ADB="${custom}"\nONCE_ANDROID_INSTALL_MODE=fastdeploy` })
  const install = calls.find(call => call.args.includes("install"))
  assert.equal(install.command, custom)
  assert.ok(install.args.includes("--fastdeploy"))
  for (const call of calls.filter(call => call.args[0] === "mdns" || call.args[0] === "connect" || call.args.includes("getprop"))) {
    assert.equal(call.command, path.join("C:/sdk", "platform-tools", process.platform === "win32" ? "adb.exe" : "adb"))
  }
})

test("exported install ADB overrides the file and relative paths resolve from the repository", () => {
  const calls = deploy({ local: "ONCE_ANDROID_ADB=ignored/adb", exported: { ONCE_ANDROID_ADB: "tools/custom-adb" } })
  assert.equal(calls.find(call => call.args.includes("install")).command, path.resolve(__dirname, "../../../tools/custom-adb"))
  const defaults = deploy()
  assert.equal(defaults.find(call => call.args.includes("install")).command, defaults.find(call => call.args[0] === "mdns").command)
})

test("invalid custom install ADB paths fail before invoking any build or device commands", () => {
  const custom = path.resolve("missing-adb")
  for (const invalid of [{ missing: custom }, { directory: custom }]) {
    const calls = []
    assert.throws(() => deploy({ exported: { ONCE_ANDROID_ADB: custom }, calls, ...invalid }), /exit 1/)
    assert.equal(calls.length, 0)
  }
})
