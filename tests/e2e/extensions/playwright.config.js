const { defineConfig } = require("@playwright/test")

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: "chrome.spec.js",
  timeout: 45_000,
  workers: 1,
  reporter: "line",
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
})
