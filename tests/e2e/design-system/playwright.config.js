const { defineConfig } = require("@playwright/test")
const path = require("node:path")

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: "*.spec.js",
  // Budgets scale for a hosted runner, which is several times slower than a
  // developer machine; locally they stay tight. A test that passes on its
  // retry passes the run, and on CI is reported as a warning annotation.
  timeout: process.env.CI ? 90_000 : 30_000,
  expect: { timeout: process.env.CI ? 15_000 : 5_000 },
  retries: 1,
  workers: 1,
  reporter: process.env.CI ? [["line"], [path.resolve(__dirname, "../shared/flaky-report.js")]] : "line",
  use: {
    actionTimeout: process.env.CI ? 15_000 : 5_000,
    navigationTimeout: process.env.CI ? 20_000 : 8_000,
    viewport: { width: 960, height: 720 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  }
})
