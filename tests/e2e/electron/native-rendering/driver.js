// Electron main-process entry: deliberately no Playwright/CDP connection.
// Loading the built Once entry exercises its real coordinator, IPC and views.
const { app, BrowserWindow, webContents, screen } = require("electron")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const { createHash } = require("node:crypto")
const { spawnSync } = require("node:child_process")
const path = require("node:path")
const { setTimeout: delay } = require("node:timers/promises")
const { runScenario } = require("./scenario")

const report = { processId: process.pid, versions: process.versions, stages: [], processes: [], status: "starting" }
const output = process.env.ONCE_RENDERING_REPORT
assert.ok(output && process.env.ONCE_ELECTRON_TEST_USER_DATA, "An isolated test profile is required")
app.on("child-process-gone", (_event, details) => {
  report.processes.push({ at: Date.now(), ...details })
})
app.on("render-process-gone", (_event, contents, details) => {
  report.processes.push({ at: Date.now(), contentsId: contents.id, ...details })
})
function healthy() {
  const failures = report.processes.filter(event => !["clean-exit", "killed"].includes(event.reason))
  assert.deepEqual(failures, [], "A process crashed; this is not a valid rendering observation")
}
const root = path.resolve(__dirname, "../../../..")
// Place each shell before it loads or receives a tab. Diagonal separation
// leaves both content regions exposed even on a 1280x720 CI display. Moving
// windows after reparenting could itself repair the defect under test.
app.on("browser-window-created", (_event, window) => {
  const area = screen.getPrimaryDisplay().workArea
  const secondary = BrowserWindow.getAllWindows().some(other => other.id !== window.id)
  window.setBounds({ width: 760, height: 480,
    x: area.x + (secondary ? Math.max(0, area.width - 760) : 0),
    y: area.y + (secondary ? Math.max(0, area.height - 480) : 0) })
  // Other applications must not cover the test when a detached window closes
  // and Windows restores foreground focus. This is set before any page loads,
  // and again once the window is showing: Windows has dropped a topmost flag
  // applied to a still-hidden detached window, which the scenario then
  // reported as lost protection. This is test scaffolding, not the tab
  // lifecycle under observation, so re-asserting it repairs nothing.
  const protect = () => { if (!window.isDestroyed()) window.setAlwaysOnTop(true) }
  window.once("ready-to-show", protect)
  window.on("show", protect)
})
const entry = path.join(root, "apps/electron/.webpack", process.arch, "main/index.js")
report.bundle = { path: entry, sha256: createHash("sha256").update(fs.readFileSync(entry)).digest("hex") }
require(entry)

const write = () => fs.writeFileSync(output, JSON.stringify(report, null, 2))
async function waitFor(label, predicate, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await predicate()
    if (result) return result
    await delay(100)
  }
  throw new Error(`Timed out: ${label}`)
}

async function main() {
  await app.whenReady()
  const source = await waitFor("Once shell", () => BrowserWindow.getAllWindows()[0])
  await waitFor("Once readiness", async () => {
    if (source.webContents.isLoading()) return false
    return source.webContents.executeJavaScript('document.body?.dataset.onceReady === "true"')
  }, 45000)
  source.setAlwaysOnTop(true)
  report.status = "ready"
  report.disabledFeatures = app.commandLine.getSwitchValue("disable-features")
  report.background = process.env.ONCE_ELECTRON_TEST_BACKGROUND
  report.display = screen.getPrimaryDisplay()
  report.gpu = app.getGPUFeatureStatus()
  healthy()
  assert.equal(report.background, "0")
  assert.equal(report.disabledFeatures.includes("NativeViewHostManagesLayers"),
    process.env.ONCE_ELECTRON_TEST_NATIVE_LAYERS !== "1", "Wrong workaround state")
  const stage = (name, detail) => {
    report.stages.push({ name, at: Date.now(), ...detail })
    write()
    healthy()
  }
  await runScenario({ source, waitFor, stage, BrowserWindow, webContents })
  healthy()
  report.status = "passed"
}

const watchdog = setTimeout(() => {
  report.status = "timeout"
  write()
  app.exit(2)
}, 120000)
main().catch(error => {
  report.status = "failed"
  report.error = error.stack
  report.code = error.code
  report.windows = BrowserWindow.getAllWindows().map(window => ({
    id: window.id, bounds: window.getBounds(), visible: window.isVisible(),
    minimized: window.isMinimized(), focused: window.isFocused(), alwaysOnTop: window.isAlwaysOnTop(),
    views: window.contentView.children.map(view => ({ bounds: view.getBounds(),
      visible: view.getVisible(), contentsId: view.webContents?.id }))
  }))
  write()
  // Diagnostic only, after the verdict; never capturePage (which can repair
  // visibility). Opt in on the interactive desktop to capture just the tab.
  if (process.env.ONCE_RENDERING_SCREENSHOT === "1") {
    const capture = spawnSync("powershell.exe", ["-NoProfile", "-File",
      path.join(__dirname, "capture-screen.ps1"), "-ReportPath", output],
    { timeout: 10000, windowsHide: true, encoding: "utf8" })
    report.screenCapture = { exitCode: capture.status, error: capture.stderr }
  }
}).finally(() => {
  clearTimeout(watchdog)
  write()
  app.exit(report.status === "passed" ? 0 : 1)
})
