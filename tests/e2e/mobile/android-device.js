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
  androidDeviceCommands,
  isAndroidEmulator,
  parseUsableAndroidDevices,
  resolveAndroidSerial,
  verifyAndroidTransport
}
