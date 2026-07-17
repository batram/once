const assert = require("node:assert/strict")
const test = require("node:test")
const path = require("node:path")

const {
  packagedAppTarget,
  shouldSkipPackagedAppStop,
  shouldStopPackagedApp
} = require("../../../apps/electron/scripts/stop-packaged-app")

test("stops packaged apps before Windows package and make builds", () => {
  assert.equal(shouldStopPackagedApp("win32", "package"), true)
  assert.equal(shouldStopPackagedApp("win32", "make"), true)
})

test("does not stop apps for development start, typecheck, or other platforms", () => {
  assert.equal(shouldStopPackagedApp("win32", "start"), false)
  assert.equal(shouldStopPackagedApp("win32", undefined), false)
  assert.equal(shouldStopPackagedApp("linux", "package"), false)
  assert.equal(shouldStopPackagedApp("darwin", "make"), false)
})

test("nokill bypasses packaged app termination through arguments or npm config", () => {
  assert.equal(shouldSkipPackagedAppStop(["package", "--nokill"], {}), true)
  assert.equal(shouldSkipPackagedAppStop(["package"], {
    npm_config_nokill: "true"
  }), true)
  assert.equal(shouldSkipPackagedAppStop(["package"], {}), false)
  assert.equal(shouldStopPackagedApp("win32", "package", true), false)
})

test("release and dev builds target only their own packaged app", () => {
  const outputRoot = path.resolve("apps/electron/out")

  assert.deepEqual(packagedAppTarget(outputRoot, "release"), {
    outputRoot,
    processName: "once"
  })
  assert.deepEqual(packagedAppTarget(outputRoot, "dev"), {
    outputRoot: path.join(outputRoot, "dev"),
    processName: "once-dev"
  })
})
