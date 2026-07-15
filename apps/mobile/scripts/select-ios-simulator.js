const { execFileSync } = require("child_process")

function simctl(...args) {
  return JSON.parse(execFileSync("xcrun", ["simctl", "list", ...args, "--json"], { encoding: "utf8" }))
}

const runtimes = simctl("runtimes").runtimes
  .filter(runtime => runtime.isAvailable && runtime.name.startsWith("iOS "))
  .filter(runtime => Number.parseInt(runtime.version, 10) >= 15)
  .sort((left, right) => left.version.localeCompare(right.version, undefined, { numeric: true }))

if (!runtimes.length) throw new Error("No available iOS 15+ simulator runtime")
const runtime = runtimes[0]
const devices = simctl("devices").devices[runtime.identifier] || []
const device = devices.find(candidate => candidate.isAvailable && candidate.name.startsWith("iPhone"))
if (!device) throw new Error(`No available iPhone for ${runtime.name}`)

process.stdout.write(`ONCE_IOS_VERSION=${runtime.version}\n`)
process.stdout.write(`ONCE_MOBILE_DEVICE=${device.name}\n`)
process.stdout.write(`ONCE_IOS_UDID=${device.udid}\n`)
