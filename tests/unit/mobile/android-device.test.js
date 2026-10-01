const test = require("node:test")
const assert = require("node:assert/strict")

const {
  ADB_COMMAND_TIMEOUT_MS,
  adbFailureDetail,
  androidDeviceAbi,
  androidDeviceCommands,
  ensureAndroidInstallSpace,
  isAndroidEmulator,
  parseDataFreeBytes,
  parseUpdatedSystemPackages,
  parseUsableAndroidDevices,
  resolveAndroidSerial,
  verifyAndroidTransport
} = require("../../e2e/mobile/android-device")

test("Android device parsing ignores offline and unauthorized entries", () => {
  const output = [
    "List of devices attached",
    "emulator-5554\toffline",
    "emulator-5556\tdevice",
    "phone-1\tunauthorized",
    ""
  ].join("\r\n")

  assert.deepEqual(parseUsableAndroidDevices(output), ["emulator-5556"])
})

test("Android serial resolution selects the sole usable device with a bounded adb call", () => {
  const spawnSync = (adb, args, options) => {
    assert.equal(adb, "adb.exe")
    assert.deepEqual(args, ["devices"])
    assert.equal(options.timeout, ADB_COMMAND_TIMEOUT_MS)
    return {
      status: 0,
      stdout: "List of devices attached\nemulator-5554\toffline\nemulator-5556\tdevice\n"
    }
  }

  assert.equal(resolveAndroidSerial("adb.exe", {}, spawnSync), "emulator-5556")
})

test("Android serial resolution preserves an explicitly configured device", () => {
  const spawnSync = () => assert.fail("adb devices should not be called")
  assert.equal(
    resolveAndroidSerial("adb.exe", { ONCE_ANDROID_UDID: "phone-1" }, spawnSync),
    "phone-1"
  )
})

test("Android serial resolution rejects multiple usable devices", () => {
  const spawnSync = () => ({
    status: 0,
    stdout: "List of devices attached\nemulator-5554\tdevice\nemulator-5556\tdevice\n"
  })

  assert.throws(
    () => resolveAndroidSerial("adb.exe", {}, spawnSync, {
      npmScript: "test:mobile:e2e:android"
    }),
    error => {
      assert.equal(error.message, [
        "More than one usable Android device is connected (emulator-5554, emulator-5556).",
        "Choose one and rerun:",
        "  ONCE_ANDROID_UDID='emulator-5554' npm run test:mobile:e2e:android",
        "  ONCE_ANDROID_UDID='emulator-5556' npm run test:mobile:e2e:android"
      ].join("\n"))
      return true
    }
  )
})

test("Android device commands use the requested launcher", () => {
  assert.deepEqual(
    androidDeviceCommands(["phone-1"], "test:mobile:e2e:android:local"),
    ["ONCE_ANDROID_UDID='phone-1' npm run test:mobile:e2e:android:local"]
  )
})

test("ADB timeout failures explain forced termination", () => {
  const error = Object.assign(new Error("spawnSync adb ETIMEDOUT"), {
    code: "ETIMEDOUT"
  })
  assert.equal(
    adbFailureDetail({ error }, "adb reverse"),
    "adb reverse timed out after 10s and was terminated"
  )
})

test("ADB failures with no output report their terminating signal", () => {
  assert.equal(
    adbFailureDetail({ status: null, signal: "SIGTERM" }, "adb reverse"),
    "adb reverse was terminated by signal SIGTERM"
  )
})

test("Android emulator detection only accepts emulator serials", () => {
  assert.equal(isAndroidEmulator("emulator-5556"), true)
  assert.equal(isAndroidEmulator("adb-phone._adb-tls-connect._tcp"), false)
})

test("Android transport preflight accepts a responsive command channel", () => {
  const calls = []
  verifyAndroidTransport("adb.exe", "emulator-5556", {}, (adb, args, options) => {
    calls.push({ adb, args, timeout: options.timeout })
    return { status: 0, stdout: "once-adb-ready\r\n" }
  })
  assert.deepEqual(calls, [{
    adb: "adb.exe",
    args: ["-s", "emulator-5556", "shell", "echo", "once-adb-ready"],
    timeout: ADB_COMMAND_TIMEOUT_MS
  }])
})

test("Android transport preflight reconnects and retries once", () => {
  const calls = []
  const results = [
    { status: null, signal: "SIGTERM", stdout: "" },
    { status: 0, stdout: "reconnecting emulator-5556\n" },
    { status: 0, stdout: "once-adb-ready\n" }
  ]
  verifyAndroidTransport("adb.exe", "emulator-5556", {}, (_adb, args) => {
    calls.push(args)
    return results.shift()
  })
  assert.deepEqual(calls, [
    ["-s", "emulator-5556", "shell", "echo", "once-adb-ready"],
    ["-s", "emulator-5556", "reconnect"],
    ["-s", "emulator-5556", "shell", "echo", "once-adb-ready"]
  ])
})

test("Android ABI selection picks the first ABI the APK can ship", () => {
  const device = abilist => () => ({ status: 0, stdout: `${abilist}\n` })
  assert.equal(androidDeviceAbi("adb", "phone", {}, device("arm64-v8a,armeabi-v7a")), "arm64-v8a")
  assert.equal(androidDeviceAbi("adb", "emulator-5554", {}, device("x86_64,arm64-v8a")), "x86_64")
  assert.throws(() => androidDeviceAbi("adb", "old", {}, device("armeabi-v7a")), /supports none/)
})

test("Android storage parsing reads df rows and reverts only safe Play Store updates", () => {
  assert.equal(parseDataFreeBytes([
    "Filesystem       1K-blocks    Used Available Use% Mounted on",
    "/dev/block/dm-53   6082144 5225424    714508  88% /data/user/0"
  ].join("\n")), 714508 * 1024)
  assert.equal(parseDataFreeBytes("df: /data: Permission denied"), null)
  assert.deepEqual(parseUpdatedSystemPackages([
    "package:/data/app/~~a==/com.google.android.gms-b==/base.apk=com.google.android.gms",
    "package:/data/app/~~c==/com.android.chrome-d==/base.apk=com.android.chrome",
    "package:/system/app/Contacts/Contacts.apk=com.android.contacts",
    "package:/data/app/~~e==/com.google.android.webview-f==/base.apk=com.google.android.webview"
  ].join("\r\n")), ["com.android.chrome"])
})

function fakeDevice(freeMiB, { updates = [], reclaim = {} } = {}) {
  const calls = []
  let free = freeMiB
  const spawnSync = (_adb, args) => {
    const command = args.slice(3)
    calls.push(command.join(" "))
    if (command[0] === "df") {
      return { status: 0, stdout: `Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/x 1 1 ${free * 1024} 1% /data\n` }
    }
    if (command.join(" ") === "pm list packages -s -f") {
      return { status: 0, stdout: updates.map(name => `package:/data/app/x/${name}-y/base.apk=${name}`).join("\n") }
    }
    free += reclaim[command.at(-1)] || 0
    return { status: 0, stdout: "" }
  }
  return { calls, spawnSync }
}

const MiB = 1024 * 1024

test("Android install space is left alone when the APK already fits", () => {
  const device = fakeDevice(2000)
  ensureAndroidInstallSpace({ adb: "adb", serial: "emulator-5554", apkBytes: 200 * MiB, env: {}, spawnSync: device.spawnSync, log() {} })
  assert.deepEqual(device.calls, ["df -k /data"])
})

test("Android emulators reclaim space by reverting Play Store updates until the APK fits", () => {
  const device = fakeDevice(700, {
    updates: ["com.google.android.gms", "com.android.chrome", "com.google.android.youtube", "com.google.android.apps.maps"],
    reclaim: { "com.zmarn.once.dev": 0, "com.android.chrome": 230, "com.google.android.youtube": 140 }
  })
  ensureAndroidInstallSpace({ adb: "adb", serial: "emulator-5554", apkBytes: 200 * MiB, env: {}, spawnSync: device.spawnSync, log() {} })
  assert.deepEqual(device.calls.filter(call => call.startsWith("pm")), [
    "pm uninstall com.zmarn.once.dev",
    "pm trim-caches 64G",
    "pm list packages -s -f",
    "pm uninstall-system-updates com.android.chrome",
    "pm uninstall-system-updates com.google.android.youtube"
  ])
})

test("Android visual runs keep the installed app while reclaiming space", () => {
  const device = fakeDevice(700, { reclaim: { "64G": 500 } })
  ensureAndroidInstallSpace({ adb: "adb", serial: "emulator-5554", apkBytes: 200 * MiB, env: {}, spawnSync: device.spawnSync, keepApp: true, log() {} })
  assert.ok(!device.calls.some(call => call.includes("uninstall")))
})

test("Android install space failures explain how to grow the emulator or free a device", () => {
  const emulator = fakeDevice(300)
  assert.throws(
    () => ensureAndroidInstallSpace({ adb: "adb", serial: "emulator-5554", apkBytes: 200 * MiB, env: {}, spawnSync: emulator.spawnSync, log() {} }),
    /Wipe Data/
  )
  const phone = fakeDevice(300)
  assert.throws(
    () => ensureAndroidInstallSpace({ adb: "adb", serial: "phone-1", apkBytes: 200 * MiB, env: {}, spawnSync: phone.spawnSync, log() {} }),
    /free some space/
  )
  assert.deepEqual(phone.calls, ["df -k /data"])
})
