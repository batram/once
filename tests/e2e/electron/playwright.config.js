const { defineConfig } = require("@playwright/test")
const path = require("node:path")

// Specs tagged @interactive drive the window itself — fullscreen, maximize,
// title-bar drag regions. Those operations snap an off-screen background
// window back onto a monitor, so running them locally throws a window onto
// whatever virtual desktop the developer is working on. They are skipped
// locally and always run on CI, where there is nobody to interrupt. Set
// ONCE_ELECTRON_E2E_INTERACTIVE=1 to run them by hand.
const includeInteractive = Boolean(process.env.CI) ||
  process.env.ONCE_ELECTRON_E2E_INTERACTIVE === "1"

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: "*.spec.js",
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
    }]]
    : "line",
  grepInvert: includeInteractive ? undefined : /@interactive/,
  use: {
    actionTimeout: process.env.CI ? 15_000 : 5_000,
    navigationTimeout: process.env.CI ? 20_000 : 8_000,
    trace: "retain-on-failure"
  }
})
