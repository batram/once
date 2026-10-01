const ADB_COMMAND_TIMEOUT_MS = 10_000

function parseUsableAndroidDevices(output) {
  return String(output)
    .split(/\r?\n/)
    .map(line => line.trim().split(/\s+/))
    .filter(parts => parts.length >= 2 && parts[1] === "device")
    .map(parts => parts[0])
}

function androidDeviceCommands(serials, npmScript) {
  return serials.map(
    serial => `ONCE_ANDROID_UDID='${serial}' npm run ${npmScript}`
  )
}

function isAndroidEmulator(serial) {
  return /^emulator-\d+$/.test(serial)
}

function verifyAndroidTransport(adb, serial, env, spawnSync) {
  const probe = () => spawnSync(adb, ["-s", serial, "shell", "echo", "once-adb-ready"], {
    env,
    encoding: "utf8",
    timeout: ADB_COMMAND_TIMEOUT_MS
  })
  let result = probe()
  if (!result.error && result.status === 0 &&
      String(result.stdout).trim() === "once-adb-ready") {
    return
  }

  spawnSync(adb, ["-s", serial, "reconnect"], {
    env,
    encoding: "utf8",
    timeout: ADB_COMMAND_TIMEOUT_MS
  })
  result = probe()
  if (!result.error && result.status === 0 &&
      String(result.stdout).trim() === "once-adb-ready") {
    return
  }

  const recovery = isAndroidEmulator(serial)
    ? `Cold boot the emulator, then verify: adb -s ${serial} shell echo ok`
    : `Reconnect the device, then verify: adb -s ${serial} shell echo ok`
  throw new Error(
    `Android device ${serial} is listed but its ADB command channel is unresponsive: ` +
    `${adbFailureDetail(result, "adb shell")}. ${recovery}`
  )
}

function adbFailureDetail(result, operation) {
  if (result.error?.code === "ETIMEDOUT") {
    return `${operation} timed out after ${ADB_COMMAND_TIMEOUT_MS / 1000}s and was terminated`
  }
  if (result.error) return result.error.message
  const output = (result.stderr || result.stdout || "").trim()
  if (output) return output
  if (result.signal) return `${operation} was terminated by signal ${result.signal}`
  if (result.status === null) return `${operation} exited without a status`
  return `${operation} failed with exit ${result.status}`
}

const SUPPORTED_ANDROID_ABIS = ["arm64-v8a", "x86_64"]
const ONCE_DEV_PACKAGE = "com.zmarn.once.dev"
// Play Store updates that the test session itself depends on; reverting them
// mid-run restarts Google Play services or swaps the WebView Appium drives.
const KEPT_SYSTEM_UPDATES = new Set([
  "com.google.android.gms",
  "com.android.vending",
  "com.google.android.webview"
])
// PackageManager refuses installs that would leave less than its low-storage
// threshold free (up to 500 MiB), and the app needs room for its own data.
const INSTALL_HEADROOM_BYTES = 768 * 1024 * 1024

function adbShell(adb, serial, args, env, spawnSync, timeout = ADB_COMMAND_TIMEOUT_MS) {
  return spawnSync(adb, ["-s", serial, "shell", ...args], { env, encoding: "utf8", timeout })
}

// The first ABI the APK can ship for this device, so e2e builds only carry the
// GeckoView native libraries the device will load.
function androidDeviceAbi(adb, serial, env, spawnSync) {
  const result = adbShell(adb, serial, ["getprop", "ro.product.cpu.abilist"], env, spawnSync)
  if (result.error || result.status !== 0) {
    throw new Error(`Unable to read the ABIs of Android device ${serial}: ${adbFailureDetail(result, "adb getprop")}`)
  }
  const abis = String(result.stdout).trim().split(",")
  const abi = abis.find(candidate => SUPPORTED_ANDROID_ABIS.includes(candidate))
  if (!abi) throw new Error(`Android device ${serial} supports none of ${SUPPORTED_ANDROID_ABIS.join(", ")} (${abis.join(",") || "no ABIs reported"})`)
  return abi
}

// `df -k /data` prints a header and one row; the mount point varies by image.
function parseDataFreeBytes(output) {
  const rows = String(output).trim().split(/\r?\n/).slice(1)
  const available = Number(rows.at(-1)?.trim().split(/\s+/)[3])
  return rows.length && Number.isFinite(available) ? available * 1024 : null
}

function androidDataFreeBytes(adb, serial, env, spawnSync) {
  const result = adbShell(adb, serial, ["df", "-k", "/data"], env, spawnSync)
  if (result.error || result.status !== 0) return null
  return parseDataFreeBytes(result.stdout)
}

// System packages whose code lives on /data are Play Store updates; parse
// `pm list packages -s -f` output into the ones safe to revert.
function parseUpdatedSystemPackages(output) {
  return String(output).split(/\r?\n/)
    .map(line => /^package:\/data\/app\/.*=([^=\s]+)$/.exec(line.trim())?.[1])
    .filter(name => name && !KEPT_SYSTEM_UPDATES.has(name))
}

// Make room for the APK Appium is about to install. Emulators fill /data over
// time as the Play Store updates the preinstalled Google apps, and a failed
// install then surfaces as INSTALL_FAILED_INSUFFICIENT_STORAGE. On emulators,
// reclaim space by dropping the previous app install, trimming caches, and
// reverting those Play Store updates; physical devices are only reported.
function ensureAndroidInstallSpace({ adb, serial, apkBytes, env, spawnSync, keepApp = false, log = console.log }) {
  const needed = apkBytes + INSTALL_HEADROOM_BYTES
  const mib = bytes => `${Math.round(bytes / 1024 / 1024)} MiB`
  let free = androidDataFreeBytes(adb, serial, env, spawnSync)
  if (free === null || free >= needed) return
  if (!isAndroidEmulator(serial)) {
    throw new Error(
      `Android device ${serial} has ${mib(free)} free on /data but installing the ` +
      `${mib(apkBytes)} test APK needs about ${mib(needed)}; free some space and rerun`
    )
  }
  log(`Android emulator ${serial} has ${mib(free)} free on /data; reclaiming space for the ${mib(apkBytes)} test APK`)
  const steps = [
    ...(keepApp ? [] : [["pm", "uninstall", ONCE_DEV_PACKAGE]]),
    ["pm", "trim-caches", "64G"]
  ]
  for (const step of steps) adbShell(adb, serial, step, env, spawnSync, 60_000)
  free = androidDataFreeBytes(adb, serial, env, spawnSync)
  if (free !== null && free < needed) {
    const listed = adbShell(adb, serial, ["pm", "list", "packages", "-s", "-f"], env, spawnSync)
    for (const name of parseUpdatedSystemPackages(listed.stdout)) {
      if (free >= needed) break
      log(`Reverting the Play Store update of ${name}`)
      adbShell(adb, serial, ["pm", "uninstall-system-updates", name], env, spawnSync, 60_000)
      free = androidDataFreeBytes(adb, serial, env, spawnSync)
    }
  }
  if (free !== null && free < needed) {
    throw new Error(
      `Android emulator ${serial} still has only ${mib(free)} free on /data after cleanup; ` +
      `installing the ${mib(apkBytes)} test APK needs about ${mib(needed)}. Grow the AVD's ` +
      "internal storage (Device Manager > Edit > Advanced > Internal Storage, or " +
      "disk.dataPartition.size in its config.ini), then cold boot it with Wipe Data; " +
      "the emulator only resizes /data when it is wiped"
    )
  }
  log(`Android emulator ${serial} now has ${mib(free)} free on /data`)
}

function resolveAndroidSerial(adb, env, spawnSync, options = {}) {
  const configured = env.ONCE_ANDROID_UDID || env.ANDROID_SERIAL
  if (configured) return configured

  const result = spawnSync(adb, ["devices"], {
    env,
    encoding: "utf8",
    timeout: ADB_COMMAND_TIMEOUT_MS
  })
  if (result.error) {
    throw new Error(`Unable to list Android devices: ${result.error.message}`)
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "unknown adb error").trim()
    throw new Error(`Unable to list Android devices: ${detail}`)
  }

  const usable = parseUsableAndroidDevices(result.stdout)
  if (usable.length === 1) return usable[0]
  if (usable.length === 0) {
    throw new Error("No usable Android device is connected (device state must be `device`)")
  }
  const commands = androidDeviceCommands(
    usable,
    options.npmScript || "test:mobile:e2e:android"
  )
  throw new Error(
    `More than one usable Android device is connected (${usable.join(", ")}).\n` +
    "Choose one and rerun:\n" +
    commands.map(command => `  ${command}`).join("\n")
  )
}

module.exports = {
  ADB_COMMAND_TIMEOUT_MS,
  adbFailureDetail,
  androidDataFreeBytes,
  androidDeviceAbi,
  androidDeviceCommands,
  ensureAndroidInstallSpace,
  isAndroidEmulator,
  parseDataFreeBytes,
  parseUpdatedSystemPackages,
  parseUsableAndroidDevices,
  resolveAndroidSerial,
  SUPPORTED_ANDROID_ABIS,
  verifyAndroidTransport
}
