const { defineConfig } = require("@playwright/test")

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: "*.spec.js",
  // Budgets scale for a hosted runner, which is several times slower than a
  // developer machine and varies between runs; locally they stay tight. A
  // retry is a second sample for the report, not a way to hide a flake: on
  // CI a test that needed one still fails the run.
  timeout: process.env.CI ? 90_000 : 30_000,
  expect: { timeout: process.env.CI ? 15_000 : 5_000 },
  retries: 1,
  failOnFlakyTests: Boolean(process.env.CI),
  workers: 1,
  reporter: "line",
  use: {
    actionTimeout: process.env.CI ? 15_000 : 5_000,
    navigationTimeout: process.env.CI ? 20_000 : 8_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  }
})
