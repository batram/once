const { execFileSync } = require("child_process")

function resolveIosSimulator(env = process.env, exec = execFileSync) {
  const { devices } = JSON.parse(exec("xcrun", ["simctl", "list", "devices", "available", "--json"], {
    encoding: "utf8",
    env,
    timeout: 30_000
  }))
  // Appium uses the runtime identifier's version (18.3), which can differ
  // from the runtime bundle's patch version (18.3.1).
  const available = Object.entries(devices).flatMap(([runtime, entries]) => {
    const match = runtime.match(/\.iOS-([\d-]+)$/)
    if (!match) return []
    const version = match[1].replaceAll("-", ".")
    return entries.filter(device => device.isAvailable).map(device => ({ ...device, version }))
  })
  const candidates = available.filter(device => {
    if (env.ONCE_IOS_UDID && device.udid !== env.ONCE_IOS_UDID) return false
    if (env.ONCE_MOBILE_DEVICE && device.name !== env.ONCE_MOBILE_DEVICE) return false
    if (env.ONCE_IOS_VERSION && device.version !== env.ONCE_IOS_VERSION &&
      !device.version.startsWith(`${env.ONCE_IOS_VERSION}.`)) return false
    return env.ONCE_IOS_UDID || env.ONCE_MOBILE_DEVICE || device.name.startsWith("iPhone")
  }).sort((left, right) =>
    Number(right.state === "Booted") - Number(left.state === "Booted") ||
    Number(right.name === "iPhone 17 Pro") - Number(left.name === "iPhone 17 Pro") ||
    right.version.localeCompare(left.version, undefined, { numeric: true })
  )
  if (!candidates.length) {
    const requested = [env.ONCE_IOS_UDID, env.ONCE_MOBILE_DEVICE, env.ONCE_IOS_VERSION].filter(Boolean)
    throw new Error(
      `No available iOS simulator matches ${requested.join(" / ") || "an iPhone"}. ` +
      `Available simulators: ${available.map(device => `${device.name} (iOS ${device.version}, ${device.udid})`).join(", ") || "none"}`
    )
  }
  return candidates[0]
}

module.exports = { resolveIosSimulator }
