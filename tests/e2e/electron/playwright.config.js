const { defineConfig } = require("@playwright/test")
const path = require("node:path")
const { runOutputDir } = require("../shared/run-output")

const runLog = path.resolve(__dirname, "../shared/run-log-reporter.js")

// Specs tagged @interactive drive the window itself — fullscreen, maximize,
// title-bar drag regions. Those operations snap an off-screen background
// window back onto a monitor, so running them locally throws a window onto
// whatever virtual desktop the developer is working on. They run on CI and on
// the hidden desktop (scripts/run-hidden.js, the npm default on Windows), where
// there is nobody to interrupt, and are skipped in a visible local run. Set
// ONCE_ELECTRON_E2E_INTERACTIVE=1 to run them by hand.
const includeInteractive = Boolean(process.env.CI) ||
  process.env.ONCE_HIDDEN_DESKTOP === "1" ||
  process.env.ONCE_ELECTRON_E2E_INTERACTIVE === "1"

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: "*.spec.js",
  outputDir: runOutputDir("electron"),
  // A hosted runner is several times slower than a developer machine and its
  // speed varies between runs, so the budget that keeps local feedback sharp
  // turns healthy specs red there. Locally it stays tight.
  timeout: process.env.CI ? 90_000 : 30_000,
  // Assertions get the same allowance as actions do there; the default five
  // seconds is what an assertion doubling as a page-load wait runs into.
  expect: { timeout: process.env.CI ? 15_000 : 5_000 },
  // A test that passes on its retry passes the run: failing it there turned
  // a third of all red runs into a manual rerun of a test that had already
  // passed. The flake is reported as a warning annotation instead, so it is
  // still noticed and fixed rather than quietly accumulating.
  retries: 1,
  workers: 1,
  reporter: process.env.CI
    ? [["line"], [path.resolve(__dirname, "../shared/flaky-report.js")], ["json", {
      outputFile: path.resolve(__dirname, "../../../artifacts/electron-e2e/results.json")
    }], [runLog]]
    : [["line"], [runLog]],
  grepInvert: includeInteractive ? undefined : /@interactive/,
  use: {
    actionTimeout: process.env.CI ? 15_000 : 5_000,
    navigationTimeout: process.env.CI ? 20_000 : 8_000,
    trace: "retain-on-failure"
  }
})
