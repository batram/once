const path = require("path")
const { defineConfig, devices } = require("@playwright/test")
const { runOutputDir } = require("../shared/run-output")

const port = Number.parseInt(process.env.ONCE_MOBILE_TEST_PORT || "3211", 10)
const runLog = path.resolve(__dirname, "../shared/run-log-reporter.js")

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: "*.spec.js",
  globalSetup: path.join(__dirname, "global-setup.js"),
  outputDir: runOutputDir("mobile-web"),
  // Budgets scale for a hosted runner, which is several times slower than a
  // developer machine and varies between runs; locally they stay tight.
  timeout: process.env.CI ? 90_000 : 30_000,
  expect: { timeout: process.env.CI ? 15_000 : 5_000 },
  // Spec files run in parallel workers: every test gets its own browser
  // context, so app storage is never shared, and a test that needs a
  // server-side database names one no other test uses. Locally a flake fails
  // the run; on CI a test that passes on its retry passes the run and is
  // reported as a warning annotation, as in the other Playwright suites.
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [["line"], [path.resolve(__dirname, "../shared/flaky-report.js")], [runLog]]
    : [["line"], [runLog]],
  use: {
    baseURL: `http://127.0.0.1:${port}/app/`,
    ...devices["Pixel 7"],
    actionTimeout: process.env.CI ? 15_000 : 5_000,
    navigationTimeout: process.env.CI ? 20_000 : 8_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  }
})
