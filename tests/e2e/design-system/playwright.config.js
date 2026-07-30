const { defineConfig } = require("@playwright/test")

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: "*.spec.js",
  timeout: 30_000,
  workers: 1,
  reporter: "line",
  use: {
    viewport: { width: 960, height: 720 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  }
})
