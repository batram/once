const assert = require("node:assert/strict")
const { spawn } = require("node:child_process")
const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")
// Playwright clears test-results at startup, including unrelated subfolders.
const outputRoot = path.resolve(__dirname, "../../../../artifacts/native-rendering")
const summary = { startedAt: new Date().toISOString(), status: "running", runs: [] }

async function run(nativeLayers, iteration) {
  const label = `${nativeLayers ? "native" : "workaround"}-${iteration}`
  const directory = path.join(outputRoot, label)
  await fs.mkdir(directory, { recursive: true })
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "once-rendering-"))
  const reportPath = path.join(directory, "report.json")
  for (const artifact of ["report.json", "electron.log", "screen.png", "screen-owner.json"]) {
    await fs.rm(path.join(directory, artifact), { force: true })
  }
  let log = ""
  const child = spawn(require("electron"), [path.join(__dirname, "driver.js")], {
    env: { ...process.env,
      ONCE_ELECTRON_TEST_USER_DATA: profile,
      ONCE_ELECTRON_TEST_BACKGROUND: "0",
      ONCE_ELECTRON_TEST_NATIVE_LAYERS: nativeLayers ? "1" : "0",
      ONCE_ELECTRON_DISABLE_STORY_LOADING: "1",
      ONCE_ELECTRON_DISABLE_NETWORK_FETCH: "1",
      ONCE_RENDERING_REPORT: reportPath
    }, stdio: ["ignore", "pipe", "pipe"], timeout: 150000
  })
  child.stdout.on("data", chunk => { log += chunk })
  child.stderr.on("data", chunk => { log += chunk })
  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject)
    child.on("exit", resolve)
  })
  await fs.writeFile(path.join(directory, "electron.log"), log)
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  const report = JSON.parse(await fs.readFile(reportPath, "utf8"))
  summary.runs.push({ label, exitCode, status: report.status, code: report.code,
    stages: report.stages.length, reportPath })
  await fs.writeFile(path.join(outputRoot, "summary.json"), JSON.stringify(summary, null, 2))
  console.log(`${label}: ${report.status}; ${report.stages.length} stages; ${report.code || ""}`)
  if (nativeLayers) {
    assert.equal(report.code, "TAB_FRAME_STALLED",
      "Negative control did not reproduce the tab regression; this environment is not calibrated")
    assert.ok(report.stages.some(stage => stage.name === "observer-calibrated"),
      "Negative control failed before the observer was calibrated")
    assert.match(report.stages.at(-1).name, /^detach-/,
      "Negative control failed outside the expected reparenting operation")
    assert.equal(exitCode, 1, "Negative control must exit with a test failure")
    assert.equal(report.status, "failed")
  } else {
    assert.equal(exitCode, 0, report.error || `Electron exited ${exitCode}`)
    assert.equal(report.status, "passed")
  }
  return report
}

async function main() {
  assert.equal(process.platform, "win32", "This native occlusion calibration requires Windows")
  await fs.mkdir(outputRoot, { recursive: true })
  for (let iteration = 0; iteration < 3; iteration++) {
    const fixed = await run(false, iteration)
    const native = await run(true, iteration)
    assert.equal(native.bundle.sha256, fixed.bundle.sha256, "Bundle changed during calibration")
    assert.deepEqual(native.versions, fixed.versions, "Runtime changed during calibration")
  }
  summary.status = "passed"
}
main().catch(error => {
  summary.status = "failed"
  summary.error = error.stack
  console.error(error)
  process.exitCode = 1
}).finally(async () => {
  await fs.mkdir(outputRoot, { recursive: true })
  await fs.writeFile(path.join(outputRoot, "summary.json"), JSON.stringify(summary, null, 2))
})
