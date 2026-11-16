const test = require("node:test")
const assert = require("node:assert/strict")
const { resolveIosSimulator } = require("../../e2e/mobile/ios-simulator")

function device(name, udid, state = "Shutdown", isAvailable = true) {
  return { name, udid, state, isAvailable }
}

const devices = {
  "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [device("iPhone 17 Pro", "older")],
  "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [device("iPhone 17 Pro", "newer")],
  "com.apple.CoreSimulator.SimRuntime.iOS-27-1": [device("iPhone 18 Pro", "latest")],
  "com.apple.CoreSimulator.SimRuntime.iOS-27-2": [device("iPhone 17 Pro", "unavailable", "Shutdown", false)],
  "com.apple.CoreSimulator.SimRuntime.tvOS-27-2": [device("Apple TV", "tv", "Booted")]
}

function resolve(env = {}, inventory = devices) {
  return resolveIosSimulator(env, (command, args, options) => {
    assert.equal(command, "xcrun")
    assert.deepEqual(args, ["simctl", "list", "devices", "available", "--json"])
    assert.equal(options.timeout, 30_000)
    assert.equal(options.env, env)
    return JSON.stringify({ devices: inventory })
  })
}

test("iOS selects an installed runtime instead of the newer Xcode SDK", () => {
  const selected = resolve()
  assert.equal(selected.udid, "newer")
  assert.equal(selected.version, "27.0")
})

test("iOS prefers a booted iPhone and ignores other platforms", () => {
  assert.equal(resolve({}, {
    ...devices,
    "com.apple.CoreSimulator.SimRuntime.iOS-18-3": [device("iPhone 16", "booted", "Booted")]
  }).udid, "booted")
})

test("iOS falls back to the newest iPhone runtime when the default model is absent", () => {
  assert.equal(resolve({}, {
    "com.apple.CoreSimulator.SimRuntime.iOS-18-3": [device("iPhone 16", "old")],
    "com.apple.CoreSimulator.SimRuntime.iOS-27-1": [device("iPhone 18 Pro", "new")]
  }).udid, "new")
})

test("iOS honors explicit UDID, device name and version constraints", () => {
  assert.equal(resolve({ ONCE_IOS_UDID: "older" }).version, "26.5")
  assert.equal(resolve({ ONCE_MOBILE_DEVICE: "iPhone 18 Pro" }).udid, "latest")
  assert.equal(resolve({ ONCE_IOS_VERSION: "26.5" }).udid, "older")
  assert.equal(resolve({ ONCE_IOS_VERSION: "27" }).udid, "newer")
  assert.equal(resolve({ ONCE_IOS_UDID: "older", ONCE_MOBILE_DEVICE: "iPhone 17 Pro", ONCE_IOS_VERSION: "26.5" }).udid, "older")
})

test("iOS rejects unavailable or contradictory overrides with available choices", () => {
  for (const env of [
    { ONCE_IOS_VERSION: "27.2" },
    { ONCE_IOS_UDID: "unavailable" },
    { ONCE_MOBILE_DEVICE: "missing" },
    { ONCE_IOS_UDID: "older", ONCE_IOS_VERSION: "27.0" }
  ]) {
    assert.throws(() => resolve(env), /No available iOS simulator matches.*iPhone 17 Pro \(iOS 26.5, older\)/)
  }
  assert.throws(() => resolve({}, {}), /Available simulators: none/)
})

test("iOS keeps the simctl runtime identifier version used by Appium", () => {
  assert.equal(resolve({}, {
    "com.apple.CoreSimulator.SimRuntime.iOS-18-3": [device("iPhone 16", "patch")]
  }).version, "18.3")
})
