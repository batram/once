const { defineConfig } = require("@playwright/test")

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: "*.spec.js",
  timeout: 30_000,
  retries: 1,
  workers: 1,
  reporter: "line",
  use: {
    actionTimeout: 5_000,
    navigationTimeout: 8_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  }
})
