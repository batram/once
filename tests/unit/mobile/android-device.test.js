const test = require("node:test")
const assert = require("node:assert/strict")

const {
  ADB_COMMAND_TIMEOUT_MS,
  adbFailureDetail,
  androidDeviceCommands,
  isAndroidEmulator,
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
