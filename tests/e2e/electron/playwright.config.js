const { defineConfig } = require("@playwright/test")

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
  retries: 1,
  workers: 1,
  reporter: "line",
  grepInvert: includeInteractive ? undefined : /@interactive/,
  use: {
    actionTimeout: process.env.CI ? 15_000 : 5_000,
    navigationTimeout: process.env.CI ? 20_000 : 8_000,
    trace: "retain-on-failure"
  }
})
